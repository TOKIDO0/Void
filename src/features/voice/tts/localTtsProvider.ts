import { synthesizeLocalTts } from "./localTtsBridgeClient";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";

/** 本地 Kokoro 语音：整句同步合成后以 PCM 流交给现有播放控制器。 */
export class LocalTtsProvider implements VoiceTtsProvider {
  constructor(private readonly voiceId = 47) {}

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const { pcmStream, sampleRate } = await synthesizeLocalTts(request.text, this.voiceId, request.signal);
    return {
      pcmStream,
      sampleRate,
      sessionId: `local-${Date.now().toString(36)}`,
      provider: "local"
    };
  }
}
