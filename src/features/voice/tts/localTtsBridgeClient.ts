import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";

export type LocalTtsAudioStream = {
  pcmStream: ReadableStream<Uint8Array>;
  sampleRate: number;
};

/** 本机 sidecar 本地 TTS：返回 PCM16LE 24k 流，不经过任何云端。 */
export async function synthesizeLocalTts(
  text: string,
  voiceId: number,
  signal?: AbortSignal
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
      body: JSON.stringify({ text, voice: voiceId }),
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
  return {
    pcmStream: response.body,
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000
  };
}

function withVoiceTtsCode(error: Error, code: string): Error {
  Object.assign(error, { voiceTtsCode: code });
  return error;
}
