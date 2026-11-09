import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import type { VoiceTtsLanguage, VoiceTtsStyle } from "./voiceTtsContract";

export type LocalTtsEngine = "qwen3" | "kokoro";

export type LocalTtsAudioStream = {
  pcmStream: ReadableStream<Uint8Array>;
  sampleRate: number;
  provider: "kokoro" | "qwen3";
};

export type LocalTtsOptions = {
  engine?: LocalTtsEngine;
  speaker?: string;
  language?: VoiceTtsLanguage;
  style?: VoiceTtsStyle;
};

/** 本机 sidecar 本地 TTS：返回 PCM16LE 24k 流，不经过任何云端。 */
export async function synthesizeLocalTts(
  text: string,
  voiceId: number,
  signal?: AbortSignal,
  options: LocalTtsOptions = {}
): Promise<LocalTtsAudioStream> {
  const origin = resolveVoidBridgeOrigin();
  const url = `${origin}/void-voice/tts`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await bridgeAuthHeadersForUrl(url))
      },
      body: JSON.stringify({
        text,
        voice: voiceId,
        engine: options.engine ?? "kokoro",
        speaker: options.speaker,
        language: options.language ?? "zh",
        style: options.style ?? "neutral"
      }),
      signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw withVoiceTtsCode(
      new Error("本地语音合成服务未连接，请确认 VOID 桌面端/本机服务在运行。"),
      "LOCAL_TTS_BRIDGE_UNREACHABLE"
    );
  }

  if (!response.ok || !response.body) {
    let payload: { error?: { code?: string; message?: string } } = {};
    try {
      payload = await response.json() as typeof payload;
    } catch {
      // 非 JSON 错误响应
    }
    throw withVoiceTtsCode(
      new Error(payload.error?.message ?? `本地语音合成失败（HTTP ${response.status}）。`),
      payload.error?.code ?? "LOCAL_TTS_GENERATE_FAILED"
    );
  }

  const sampleRate = Number(response.headers.get("x-void-tts-sample-rate") ?? "24000");
  const provider = response.headers.get("x-void-tts-provider") === "qwen3" ? "qwen3" : "kokoro";
  return {
    pcmStream: response.body,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000,
    provider
  };
}

/** 启动时后台预热 Qwen3；失败静默，不阻塞 UI。 */
export async function warmupLocalTtsEngine(): Promise<void> {
  const origin = resolveVoidBridgeOrigin();
  const url = `${origin}/void-voice/tts/warmup`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { ...(await bridgeAuthHeadersForUrl(url)) }
    });
  } catch {
    // 引擎包未安装/服务未起时不影响启动。
  }
}

function withVoiceTtsCode(error: Error, code: string): Error {
  Object.assign(error, { voiceTtsCode: code });
  return error;
}
