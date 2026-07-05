import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { buildVoiceFetchTarget, fetchVoiceWithProxy } from "../voiceProxyUrl";
import {
  DOUBAO_TTS_HTTP_ENDPOINT,
  DOUBAO_TTS_RESOURCE_ID
} from "../voiceProviderConfig";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";
import {
  assertSuccessfulBaseResponse,
  decodeBase64Audio,
  parseVoiceSynthesisResponse,
  resolveAudioMimeType
} from "./voiceTtsResponse";

type DoubaoTtsProviderConfig = {
  apiKey: string;
  speakerId: string;
  endpointUrl?: string;
  resourceId?: string;
};

export class DoubaoTtsProvider implements VoiceTtsProvider {
  private readonly apiKey: string;
  private readonly speakerId: string;
  private readonly endpointUrl: string;
  private readonly resourceId: string;

  constructor(config: DoubaoTtsProviderConfig) {
    this.apiKey = config.apiKey.trim();
    this.speakerId = config.speakerId.trim();
    this.endpointUrl = config.endpointUrl?.trim() || DOUBAO_TTS_HTTP_ENDPOINT;
    this.resourceId = config.resourceId?.trim() || DOUBAO_TTS_RESOURCE_ID;
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    if (!this.apiKey) {
      throw createNetworkError("Doubao TTS 缺少 API Key。", this.endpointUrl);
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
      headers: {
        Accept: "application/json, audio/mpeg, audio/*",
        "Content-Type": "application/json",
        "X-Api-Key": this.apiKey,
        "X-Api-Resource-Id": this.resourceId,
        "X-Api-Request-Id": crypto.randomUUID()
      },
      signal: request.signal,
      body: JSON.stringify({
        req_params: {
          text: request.text,
          speaker: this.speakerId,
          audio_params: {
            format: "mp3",
            sample_rate: 24000
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

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.startsWith("audio/")) {
      const audioBlob = await response.blob();
      return {
        audioUrl: URL.createObjectURL(audioBlob),
        mimeType: audioBlob.type || contentType,
        provider: "doubao"
      };
    }

    const payload = await response.json() as Record<string, unknown>;
    assertSuccessfulBaseResponse(payload, {
      providerLabel: "Doubao TTS",
      providerKind: "doubao",
      endpointUrl: this.endpointUrl
    });

    const audioBase64 = resolveDoubaoAudioBase64(payload);
    if (!audioBase64) {
      throw new Error("Doubao TTS 返回成功，但未携带可解析音频数据。待任务 2 复验其真实返回结构。");
    }

    const mimeType = resolveAudioMimeType(payload, contentType);
    const audioBlob = decodeBase64Audio(audioBase64, mimeType);
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType,
      provider: "doubao"
    };
  }
}

function isAsrResourceId(resourceId: string) {
  const normalizedResourceId = resourceId.trim().toLowerCase();
  return normalizedResourceId.includes(".sauc.") || normalizedResourceId.includes("asr");
}

function resolveDoubaoAudioBase64(payload: Record<string, unknown>) {
  const data = asRecord(payload.data);
  const candidates = [
    payload.data,
    payload.audio,
    payload.audio_base64,
    data?.audio,
    data?.audio_base64,
    data?.data
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return "";
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
