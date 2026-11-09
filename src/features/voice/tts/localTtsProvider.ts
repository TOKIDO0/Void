import { synthesizeLocalTts, type LocalTtsEngine } from "./localTtsBridgeClient";
import type { VoiceSynthesisRequest, VoiceSynthesisResult, VoiceTtsProvider } from "./voiceTtsContract";

/** 本地语音：Qwen3 质量优先；引擎未安装/启动失败时自动回退 Kokoro，避免整段无声。 */
export class LocalTtsProvider implements VoiceTtsProvider {
  constructor(
    private readonly voiceId = 47,
    private readonly engine: LocalTtsEngine = "qwen3",
    private readonly speaker = "ono_anna"
  ) {}

  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    if (this.engine === "qwen3") {
      try {
        const { pcmStream, sampleRate, provider } = await synthesizeLocalTts(
          request.text,
          this.voiceId,
          request.signal,
          { engine: "qwen3", speaker: this.speaker, language: "zh", style: "neutral" }
        );
        return {
          pcmStream,
          sampleRate,
          sessionId: `qwen3-${Date.now().toString(36)}`,
          provider: provider === "qwen3" ? "qwen3" : "local"
        };
      } catch (error) {
        if (request.signal?.aborted) {
          throw error;
        }
        const code = (error as { voiceTtsCode?: string }).voiceTtsCode;
        if (
          code !== "LOCAL_TTS_ENGINE_UNAVAILABLE"
          && code !== "LOCAL_TTS_ENGINE_INIT_FAILED"
          && code !== "LOCAL_TTS_GENERATE_FAILED"
        ) {
          throw error;
        }
        // 引擎包未安装或启动失败：本次回退 Kokoro，不阻塞文字回合。
        console.warn("[VOID TTS] Qwen3-TTS 不可用，回退 Kokoro：", error);
      }
    }

    const { pcmStream, sampleRate } = await synthesizeLocalTts(
      request.text,
      this.voiceId,
      request.signal,
      { engine: "kokoro" }
    );
    return {
      pcmStream,
      sampleRate,
      sessionId: `local-${Date.now().toString(36)}`,
      provider: "local"
    };
  }
}
