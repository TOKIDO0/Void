import {
  inspectVoiceTtsModel,
  resolveVoiceTtsModelDir,
  type VoiceTtsModelStatus
} from "./voiceTtsModelManager";

const DEFAULT_VOICE_ID = 47; // zf_xiaoxiao
const MAX_TEXT_CHARS = 500;
const IDLE_UNLOAD_MS = 60_000;
const SAMPLE_RATE_FALLBACK = 24000;

type GeneratedAudio = { samples: Float32Array; sampleRate: number };
type OfflineTts = {
  generate(request: { text: string; sid: number; speed: number; enableExternalBuffer?: boolean }): GeneratedAudio;
  sampleRate: number;
  numSpeakers: number;
};

export type VoiceTtsEngineErrorCode =
  | "LOCAL_TTS_MODEL_MISSING"
  | "LOCAL_TTS_MODEL_INVALID"
  | "LOCAL_TTS_ENGINE_INIT_FAILED"
  | "LOCAL_TTS_TEXT_INVALID"
  | "LOCAL_TTS_GENERATE_FAILED";

export class VoiceTtsEngineError extends Error {
  constructor(readonly code: VoiceTtsEngineErrorCode, message: string) {
    super(message);
    this.name = "VoiceTtsEngineError";
  }
}

export type LocalTtsAudio = {
  pcm: Buffer;
  sampleRate: number;
  provider: "kokoro";
};

let tts: OfflineTts | null = null;
let loading: Promise<OfflineTts> | null = null;
let cachedModel: VoiceTtsModelStatus | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function loadTts(): Promise<OfflineTts> {
  const model = inspectVoiceTtsModel();
  cachedModel = model;
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
      scheduleIdleUnload();
      return created;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export async function synthesizeLocalTts(text: string, voiceId = DEFAULT_VOICE_ID): Promise<LocalTtsAudio> {
  const normalized = text.trim();
  if (!normalized) {
    throw new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "没有可合成的文本。");
  }
  if (normalized.length > MAX_TEXT_CHARS) {
    throw new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "单句文本过长，请缩短后再试。");
  }

  const engine = await getTts();
  const sid = Number.isInteger(voiceId) && voiceId >= 0 && voiceId < engine.numSpeakers
    ? voiceId
    : DEFAULT_VOICE_ID;

  let audio: GeneratedAudio;
  try {
    // 该版本 Node 异步接口会崩，使用同步 generate；单句约 2 秒，sidecar 会被短暂占用。
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

  return { pcm, sampleRate, provider: "kokoro" };
}

export function getVoiceTtsEngineStatus() {
  return {
    engineLoaded: Boolean(tts),
    idleUnloadMs: IDLE_UNLOAD_MS,
    model: cachedModel ?? inspectVoiceTtsModel(),
    modelDir: resolveVoiceTtsModelDir(),
    defaultVoiceId: DEFAULT_VOICE_ID
  };
}

/**
 * 空闲卸载：只丢引用，等待原生 handle 的 finalizer/GC 释放。
 * 是否真正归还内存需在真实进程用 RSS 验证；这里不伪造已释放。
 */
function scheduleIdleUnload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    tts = null;
    cachedModel = null;
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}
