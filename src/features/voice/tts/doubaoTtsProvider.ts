import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { buildVoiceFetchTarget, fetchVoiceWithProxy } from "../voiceProxyUrl";
import {
  DOUBAO_TTS_HTTP_ENDPOINT,
  DOUBAO_TTS_RESOURCE_ID
} from "../voiceProviderConfig";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";
import { decodeBase64Audio, parseVoiceSynthesisResponse } from "./voiceTtsResponse";

// v3 单向流式合成的音频封装格式（与请求体 audio_params.format 保持一致）
const DOUBAO_TTS_AUDIO_FORMAT = "mp3";
const DOUBAO_TTS_AUDIO_MIME_TYPE = "audio/mpeg";
const DOUBAO_TTS_AUDIO_SAMPLE_RATE = 24000;
// NDJSON 流的结束标志码：该行不含音频数据，表示整段合成完成
const DOUBAO_TTS_STREAM_END_CODE = 20000000;

type DoubaoTtsProviderConfig = {
  appId: string;
  apiKey: string;
  speakerId: string;
  endpointUrl?: string;
  resourceId?: string;
};

export class DoubaoTtsProvider implements VoiceTtsProvider {
  private readonly appId: string;
  private readonly apiKey: string;
  private readonly speakerId: string;
  private readonly endpointUrl: string;
  private readonly resourceId: string;

  constructor(config: DoubaoTtsProviderConfig) {
    this.appId = config.appId.trim();
    this.apiKey = config.apiKey.trim();
    this.speakerId = config.speakerId.trim();
    this.endpointUrl = config.endpointUrl?.trim() || DOUBAO_TTS_HTTP_ENDPOINT;
    this.resourceId = config.resourceId?.trim() || DOUBAO_TTS_RESOURCE_ID;
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    if (!this.appId) {
      throw createNetworkError("Doubao TTS 缺少 App ID。", this.endpointUrl);
    }

    if (!this.apiKey) {
      throw createNetworkError("Doubao TTS 缺少 Access Key（API Key）。", this.endpointUrl);
    }

    if (!this.speakerId) {
      throw createNetworkError("Doubao TTS 缺少 Speaker ID。", this.endpointUrl);
    }

    if (isAsrResourceId(this.resourceId)) {
      throw createNetworkError(
        `Doubao TTS 的 Resource ID 被填成了 ASR 识别资源：${this.resourceId}。普通豆包官方音色请优先使用 seed-tts-2.0，复刻音色再使用 seed-icl-2.0。`,
        this.endpointUrl
      );
    }

    const fetchTarget = buildVoiceFetchTarget(this.endpointUrl, request.requestMode);
    const response = await fetchVoiceWithProxy(fetchTarget, {
      method: "POST",
      // 豆包 openspeech v3 鉴权：App ID + Access Key + Resource ID 三件套。
      // 必须与已验证可用的 STT（voiceSttBridge.ts）使用同一套头名，避免鉴权方案分叉再次 401。
      headers: {
        Accept: "application/json, audio/mpeg, audio/*",
        "Content-Type": "application/json",
        "X-Api-App-Key": this.appId,
        "X-Api-Access-Key": this.apiKey,
        "X-Api-Resource-Id": this.resourceId,
        "X-Api-Request-Id": crypto.randomUUID()
      },
      signal: request.signal,
      body: JSON.stringify({
        user: {
          uid: "void-web-mvp"
        },
        req_params: {
          text: request.text,
          speaker: this.speakerId,
          audio_params: {
            format: DOUBAO_TTS_AUDIO_FORMAT,
            sample_rate: DOUBAO_TTS_AUDIO_SAMPLE_RATE
          }
        }
      })
    });

    if (!response.ok) {
      await parseVoiceSynthesisResponse(response, {
        providerLabel: "Doubao TTS",
        providerKind: "doubao",
        endpointUrl: this.endpointUrl
      });
      throw new Error("Doubao TTS 响应解析中断。");
    }

    // 某些网关可能直接回二进制音频；正常情况下 v3 单向流式回 NDJSON 文本流。
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("audio/")) {
      const audioBlob = await response.blob();
      return {
        audioUrl: URL.createObjectURL(audioBlob),
        mimeType: audioBlob.type || contentType,
        provider: "doubao"
      };
    }

    const rawBody = await response.text();
    const audioBlob = decodeUnidirectionalStreamAudio(rawBody, DOUBAO_TTS_AUDIO_MIME_TYPE);
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType: DOUBAO_TTS_AUDIO_MIME_TYPE,
      provider: "doubao"
    };
  }
}

/**
 * 解析豆包 v3 单向流式（/api/v3/tts/unidirectional）的 NDJSON 响应体。
 *
 * 响应为换行分隔的 JSON，每行形如 `{"code":0,"data":"<base64 音频片段>"}`，
 * 以 `{"code":20000000}`（无 data）收尾；非 0 且非结束码表示服务端错误。
 * 逐行解码 base64 音频片段并拼接为单个 Blob。
 */
function decodeUnidirectionalStreamAudio(rawBody: string, mimeType: string): Blob {
  const audioChunks: Blob[] = [];
  let sawEndSignal = false;

  for (const line of rawBody.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmedLine) as Record<string, unknown>;
    } catch {
      continue;
    }

    const code = typeof event.code === "number" ? event.code : null;
    if (code === DOUBAO_TTS_STREAM_END_CODE) {
      sawEndSignal = true;
      continue;
    }

    if (code !== null && code !== 0) {
      const message = typeof event.message === "string" && event.message.trim()
        ? event.message.trim()
        : `code=${code}`;
      throw new Error(`Doubao TTS 合成失败：${message}`);
    }

    const data = event.data;
    if (typeof data === "string" && data) {
      audioChunks.push(decodeBase64Audio(data, mimeType));
    }
  }

  if (!audioChunks.length) {
    throw new Error(
      sawEndSignal
        ? "Doubao TTS 合成完成但未返回音频数据，请检查 Speaker 音色 ID 是否有效。"
        : "Doubao TTS 未返回可解析的音频数据。"
    );
  }

  return new Blob(audioChunks, { type: mimeType });
}

function isAsrResourceId(resourceId: string) {
  const normalizedResourceId = resourceId.trim().toLowerCase();
  return normalizedResourceId.includes(".sauc.") || normalizedResourceId.includes("asr");
}
