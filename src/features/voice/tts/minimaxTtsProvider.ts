import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { buildVoiceFetchTarget, fetchVoiceWithProxy } from "../voiceProxyUrl";
import {
  MINIMAX_TTS_ENDPOINT,
  MINIMAX_TTS_MODEL,
  resolveDefaultVoiceCatalogEntry,
  resolveSceneVoiceCatalogEntry
} from "../voiceProviderConfig";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";
import { parseVoiceSynthesisResponse } from "./voiceTtsResponse";

type MiniMaxTtsProviderConfig = {
  apiKey: string;
  groupId?: string;
  endpointUrl?: string;
};

export class MiniMaxTtsProvider implements VoiceTtsProvider {
  private readonly apiKey: string;
  private readonly groupId: string;
  private readonly endpointUrl: string;

  constructor(config: MiniMaxTtsProviderConfig) {
    this.apiKey = config.apiKey.trim();
    this.groupId = config.groupId?.trim() || "";
    this.endpointUrl = config.endpointUrl?.trim() || MINIMAX_TTS_ENDPOINT;
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    if (!this.apiKey) {
      throw createNetworkError("MiniMax TTS 缺少 API Key。", this.endpointUrl);
    }

    const preferredGender = request.preferredGender ?? "female";
    const voiceCatalogEntry = request.scene && request.scene !== "default"
      ? resolveSceneVoiceCatalogEntry(request.scene, preferredGender)
      : resolveDefaultVoiceCatalogEntry(preferredGender);
    const fetchTarget = buildVoiceFetchTarget(this.endpointUrl, request.requestMode);

    const response = await fetchVoiceWithProxy(fetchTarget, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(this.groupId ? { "X-Group-Id": this.groupId } : {})
      },
      body: JSON.stringify({
        model: MINIMAX_TTS_MODEL,
        text: request.text,
        stream: false,
        voice_setting: {
          voice_id: voiceCatalogEntry.voiceId,
          speed: 1,
          vol: 1,
          pitch: 0
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1
        },
        subtitle_enable: false,
        output_format: "hex"
      })
    });

    return await parseVoiceSynthesisResponse(response, {
      providerLabel: "MiniMax TTS",
      providerKind: "minimax",
      endpointUrl: this.endpointUrl
    });
  }
}
