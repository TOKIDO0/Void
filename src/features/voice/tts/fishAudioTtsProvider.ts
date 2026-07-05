import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { buildVoiceFetchTarget, fetchVoiceWithProxy } from "../voiceProxyUrl";
import {
  FISHAUDIO_TTS_ENDPOINT,
  normalizeFishAudioModel
} from "../voiceProviderConfig";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";
import { parseVoiceSynthesisResponse } from "./voiceTtsResponse";

type FishAudioTtsProviderConfig = {
  apiKey: string;
  voiceId: string;
  model?: string;
  endpointUrl?: string;
};

export class FishAudioTtsProvider implements VoiceTtsProvider {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly model: string;
  private readonly endpointUrl: string;

  constructor(config: FishAudioTtsProviderConfig) {
    this.apiKey = normalizeBearerToken(config.apiKey);
    this.voiceId = config.voiceId.trim();
    this.model = normalizeFishAudioModel(config.model);
    this.endpointUrl = config.endpointUrl?.trim() || FISHAUDIO_TTS_ENDPOINT;
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    if (!this.apiKey) {
      throw createNetworkError("FishAudio TTS 缺少 API Key。", this.endpointUrl);
    }

    if (!this.model) {
      throw createNetworkError("FishAudio TTS 缺少 Model。", this.endpointUrl);
    }

    const fetchTarget = buildVoiceFetchTarget(this.endpointUrl, request.requestMode);
    logFishAudioRequest(this.apiKey, this.model, this.voiceId, this.endpointUrl, request.requestMode);

    // reference_id 为可选参数：仅当配置了有效 Voice ID 时才携带，
    // 为空则由 FishAudio 使用模型默认音色（避免无效 ID 触发 "Reference not found" 400）
    const requestBody: { text: string; format: string; reference_id?: string } = {
      text: request.text,
      format: "mp3"
    };
    if (this.voiceId) {
      requestBody.reference_id = this.voiceId;
    }

    const response = await fetchVoiceWithProxy(fetchTarget, {
      method: "POST",
      headers: {
        Accept: "audio/mpeg, audio/wav, application/json",
        Authorization: `Bearer ${this.apiKey}`,
        model: this.model,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: request.signal
    });

    if (!response.ok) {
      await parseVoiceSynthesisResponse(response, {
        providerLabel: "FishAudio TTS",
        providerKind: "fishaudio",
        endpointUrl: this.endpointUrl
      });
      throw new Error("FishAudio TTS 响应解析中断。");
    }

    const audioBlob = await response.blob();
    return {
      audioUrl: URL.createObjectURL(audioBlob),
      mimeType: audioBlob.type || "audio/mpeg",
      provider: "fishaudio"
    };
  }
}

function normalizeBearerToken(apiKey: string) {
  return apiKey.trim().replace(/^Bearer\s+/i, "");
}

function logFishAudioRequest(
  apiKey: string,
  model: string,
  voiceId: string,
  endpointUrl: string,
  requestMode: VoiceSynthesisRequest["requestMode"]
) {
  if (!import.meta.env.DEV) {
    return;
  }

  console.info("[VOID FishAudio request]", {
    endpointUrl,
    requestMode,
    model,
    voiceIdLength: voiceId.length,
    apiKeyLength: apiKey.length,
    apiKeyHasBearerPrefix: /^Bearer\s+/i.test(apiKey)
  });
}
