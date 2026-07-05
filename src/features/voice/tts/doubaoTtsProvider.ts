import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { buildVoiceFetchTarget, fetchVoiceWithProxy } from "../voiceProxyUrl";
import {
  DOUBAO_TTS_HTTP_ENDPOINT,
  DOUBAO_TTS_RESOURCE_ID
} from "../voiceProviderConfig";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";
import { parseVoiceSynthesisResponse } from "./voiceTtsResponse";

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

    return await parseVoiceSynthesisResponse(response, {
      providerLabel: "Doubao TTS",
      providerKind: "doubao",
      endpointUrl: this.endpointUrl
    });
  }
}

function isAsrResourceId(resourceId: string) {
  const normalizedResourceId = resourceId.trim().toLowerCase();
  return normalizedResourceId.includes(".sauc.") || normalizedResourceId.includes("asr");
}
