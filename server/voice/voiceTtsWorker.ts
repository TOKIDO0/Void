/**
 * 本地 Kokoro TTS worker 线程。
 *
 * 为什么独立线程：sherpa-onnx-node 的 `OfflineTts.generate` 是同步调用
 *（该版本异步接口会崩），单句约 2–3.5 秒。放在 sidecar 主线程会阻塞
 * Node 事件循环，长回复期间 `/void-model-proxy` 无法读取/转发 SSE。
 *
 * owner：本文件只负责「加载引擎 + 同步合成 + 空闲卸载」；
 * 队列上限、取消、HTTP 响应由主线程 voiceTtsEngine 统一管理。
 */
import { parentPort, workerData } from "node:worker_threads";
import {
  DEFAULT_VOICE_ID,
  IDLE_UNLOAD_MS,
  MAX_TEXT_CHARS,
  SAMPLE_RATE_FALLBACK,
  VoiceTtsEngineError,
  type OfflineTts,
  type VoiceTtsWorkerRequest,
  type VoiceTtsWorkerResponse
} from "./voiceTtsShared";
import {
  inspectVoiceTtsModel,
  resolveVoiceTtsModelDir
} from "./voiceTtsModelManager";

const modelDir = typeof workerData?.modelDir === "string" && workerData.modelDir.trim()
  ? workerData.modelDir.trim()
  : resolveVoiceTtsModelDir();

let tts: OfflineTts | null = null;
let loading: Promise<OfflineTts> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function loadTts(): Promise<OfflineTts> {
  const model = inspectVoiceTtsModel(modelDir);
  if (model.state === "missing") {
    throw new VoiceTtsEngineError("LOCAL_TTS_MODEL_MISSING", model.reason);
  }
  if (model.state === "invalid") {
    throw new VoiceTtsEngineError("LOCAL_TTS_MODEL_INVALID", model.reason);
  }

  let imported: unknown;
  try {
    imported = await import("sherpa-onnx-node");
  } catch {
    throw new VoiceTtsEngineError("LOCAL_TTS_ENGINE_INIT_FAILED", "本地语音合成引擎加载失败。");
  }
  const sherpa = (imported as { default?: unknown }).default ?? imported;
  const OfflineTtsCtor = (sherpa as {
    OfflineTts?: new (config: unknown) => OfflineTts;
  }).OfflineTts;
  if (typeof OfflineTtsCtor !== "function") {
    throw new VoiceTtsEngineError("LOCAL_TTS_ENGINE_INIT_FAILED", "本地语音合成引擎不可用。");
  }

  try {
    return new OfflineTtsCtor({
      model: {
        kokoro: {
          model: model.files.model,
          voices: model.files.voices,
          tokens: model.files.tokens,
          lexicon: model.files.lexicon,
          lengthScale: 1.0
        },
        numThreads: 2,
        provider: "cpu",
        debug: 0
      },
      ruleFsts: model.files.ruleFsts.join(","),
      maxNumSentences: 1
    });
  } catch {
    throw new VoiceTtsEngineError("LOCAL_TTS_ENGINE_INIT_FAILED", "本地语音合成模型初始化失败。");
  }
}

async function getTts(): Promise<OfflineTts> {
  if (tts) {
    return tts;
  }
  if (loading) {
    return loading;
  }
  loading = loadTts()
    .then((created) => {
      tts = created;
      return created;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 空闲卸载只丢引用；是否真正归还内存由原生 handle 的 finalizer/GC 决定，不伪造已释放。 */
function scheduleIdleUnload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    tts = null;
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

function clearIdleUnload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function synthesize(request: VoiceTtsWorkerRequest): { pcm: Buffer; sampleRate: number } {
  const normalized = request.text.trim();
  if (!normalized) {
    throw new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "没有可合成的文本。");
  }
  if (normalized.length > MAX_TEXT_CHARS) {
    throw new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "单句文本过长，请缩短后再试。");
  }

  const engine = tts;
  if (!engine) {
    throw new VoiceTtsEngineError("LOCAL_TTS_ENGINE_INIT_FAILED", "本地语音合成引擎尚未就绪。");
  }

  const voiceId = request.voiceId;
  const sid = Number.isInteger(voiceId) && voiceId !== undefined && voiceId >= 0 && voiceId < engine.numSpeakers
    ? voiceId
    : DEFAULT_VOICE_ID;

  let audio: { samples: Float32Array; sampleRate: number };
  try {
    audio = engine.generate({ text: normalized, sid, speed: 1.0 });
  } catch {
    throw new VoiceTtsEngineError("LOCAL_TTS_GENERATE_FAILED", "本地语音合成失败。");
  }

  const sampleRate = audio.sampleRate || SAMPLE_RATE_FALLBACK;
  const samples = audio.samples;
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm.writeInt16LE(Math.round(value * 32767), index * 2);
  }

  return { pcm, sampleRate };
}

function post(message: VoiceTtsWorkerResponse, transfer?: ArrayBuffer[]): void {
  parentPort?.postMessage(message, transfer);
}

async function handleRequest(request: VoiceTtsWorkerRequest): Promise<void> {
  clearIdleUnload();
  try {
    await getTts();
    const audio = synthesize(request);
    // 转移 ArrayBuffer，避免主线程再复制一份 PCM。
    post(
      {
        type: "result",
        id: request.id,
        pcm: audio.pcm,
        sampleRate: audio.sampleRate
      },
      [audio.pcm.buffer as ArrayBuffer]
    );
  } catch (error) {
    if (error instanceof VoiceTtsEngineError) {
      post({ type: "error", id: request.id, code: error.code, message: error.message });
      return;
    }
    post({
      type: "error",
      id: request.id,
      code: "LOCAL_TTS_GENERATE_FAILED",
      message: "本地语音合成失败。"
    });
  } finally {
    scheduleIdleUnload();
  }
}

parentPort?.on("message", (message: VoiceTtsWorkerRequest) => {
  if (!message || message.type !== "synthesize" || typeof message.id !== "number") {
    return;
  }
  void handleRequest(message);
});
