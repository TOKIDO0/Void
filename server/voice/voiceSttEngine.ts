import {
  inspectVoiceSttModel,
  resolveVoiceSttModelDir,
  type VoiceSttModelStatus
} from "./voiceSttModelManager";

const SAMPLE_RATE = 16000;
const MAX_SESSIONS = 2;
const IDLE_UNLOAD_MS = 60_000;
const PARTIAL_THROTTLE_MS = 120;
/** 单会话音频上限：16k * 2 bytes * 10 分钟。 */
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 60 * 10;

type OnlineStream = {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
};

type OnlineRecognizer = {
  createStream(): OnlineStream;
  isReady(stream: OnlineStream): boolean;
  decode(stream: OnlineStream): void;
  isEndpoint(stream: OnlineStream): boolean;
  reset(stream: OnlineStream): void;
  getResult(stream: OnlineStream): { text?: string };
};

export type VoiceSttEngineErrorCode =
  | "LOCAL_STT_MODEL_MISSING"
  | "LOCAL_STT_MODEL_INVALID"
  | "LOCAL_STT_ENGINE_INIT_FAILED"
  | "LOCAL_STT_LIMIT"
  | "LOCAL_STT_BUSY";

export class VoiceSttEngineError extends Error {
  constructor(
    readonly code: VoiceSttEngineErrorCode,
    message: string,
    readonly recoverable = false
  ) {
    super(message);
    this.name = "VoiceSttEngineError";
  }
}

export type VoiceSttSessionEvents = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
};

let recognizer: OnlineRecognizer | null = null;
let loading: Promise<OnlineRecognizer> | null = null;
let cachedModel: VoiceSttModelStatus | null = null;
let activeSessions = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function loadRecognizer(): Promise<OnlineRecognizer> {
  const model = inspectVoiceSttModel();
  cachedModel = model;
  if (model.state === "missing") {
    throw new VoiceSttEngineError("LOCAL_STT_MODEL_MISSING", model.reason);
  }
  if (model.state === "invalid") {
    throw new VoiceSttEngineError("LOCAL_STT_MODEL_INVALID", model.reason);
  }

  let imported: unknown;
  try {
    imported = await import("sherpa-onnx-node");
  } catch {
    throw new VoiceSttEngineError("LOCAL_STT_ENGINE_INIT_FAILED", "本地语音引擎加载失败。");
  }
  const sherpa = (imported as { default?: unknown }).default ?? imported;
  const Recognizer = (sherpa as { OnlineRecognizer?: new (config: unknown) => OnlineRecognizer }).OnlineRecognizer;
  if (typeof Recognizer !== "function") {
    throw new VoiceSttEngineError("LOCAL_STT_ENGINE_INIT_FAILED", "本地语音引擎不可用。");
  }

  try {
    const created = new Recognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        paraformer: {
          encoder: model.files.encoder,
          decoder: model.files.decoder
        },
        tokens: model.files.tokens,
        numThreads: 2,
        provider: "cpu",
        debug: 0
      },
      decodingMethod: "greedy_search",
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20
    });
    return created;
  } catch {
    throw new VoiceSttEngineError("LOCAL_STT_ENGINE_INIT_FAILED", "本地语音模型初始化失败。");
  }
}

export async function getVoiceSttRecognizer(): Promise<OnlineRecognizer> {
  if (recognizer) {
    return recognizer;
  }
  if (loading) {
    return loading;
  }
  loading = loadRecognizer()
    .then((created) => {
      recognizer = created;
      scheduleIdleUnload();
      return created;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export class VoiceSttSession {
  private readonly stream: OnlineStream;
  private lastPartial = "";
  private lastPartialAt = 0;
  private audioBytes = 0;
  private closed = false;

  constructor(
    private readonly engine: OnlineRecognizer,
    private readonly events: VoiceSttSessionEvents
  ) {
    this.stream = engine.createStream();
  }

  acceptPcm16Base64(audioBase64: string): void {
    if (this.closed) {
      return;
    }
    const samples = decodePcm16Base64(audioBase64);
    if (samples.length === 0) {
      return;
    }
    this.audioBytes += samples.length * 2;
    if (this.audioBytes > MAX_AUDIO_BYTES) {
      throw new VoiceSttEngineError("LOCAL_STT_LIMIT", "单次语音过长，请分段说话。");
    }

    this.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    this.drain();
    this.emitPartialIfChanged();

    if (this.engine.isEndpoint(this.stream)) {
      this.finish();
    }
  }

  commit(): void {
    if (this.closed) {
      return;
    }
    this.finish();
  }

  close(): void {
    this.closed = true;
  }

  private drain(): void {
    while (this.engine.isReady(this.stream)) {
      this.engine.decode(this.stream);
    }
  }

  private currentText(): string {
    return (this.engine.getResult(this.stream).text ?? "").trim();
  }

  private emitPartialIfChanged(): void {
    const text = this.currentText();
    if (!text || text === this.lastPartial) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPartialAt < PARTIAL_THROTTLE_MS) {
      return;
    }
    this.lastPartial = text;
    this.lastPartialAt = now;
    this.events.onPartial(text);
  }

  /** endpoint 与本地 VAD commit 共用；重置 stream 后不会重复发同一句 final。 */
  private finish(): void {
    this.drain();
    const text = this.currentText();
    this.engine.reset(this.stream);
    this.lastPartial = "";
    this.lastPartialAt = 0;
    this.audioBytes = 0;
    if (text) {
      this.events.onFinal(text);
    }
  }
}

export async function acquireVoiceSttSession(
  events: VoiceSttSessionEvents
): Promise<VoiceSttSession> {
  if (activeSessions >= MAX_SESSIONS) {
    throw new VoiceSttEngineError("LOCAL_STT_BUSY", "本地语音识别忙，请稍后重试。");
  }
  const engine = await getVoiceSttRecognizer();
  const session = new VoiceSttSession(engine, events);
  activeSessions += 1;
  scheduleIdleUnload();
  return session;
}

export function releaseVoiceSttSession(session: VoiceSttSession | null): void {
  if (!session) {
    return;
  }
  session.close();
  activeSessions = Math.max(0, activeSessions - 1);
  scheduleIdleUnload();
}

export function getVoiceSttEngineStatus() {
  return {
    engineLoaded: Boolean(recognizer),
    activeSessions,
    maxSessions: MAX_SESSIONS,
    idleUnloadMs: IDLE_UNLOAD_MS,
    model: cachedModel ?? inspectVoiceSttModel(),
    modelDir: resolveVoiceSttModelDir()
  };
}

/**
 * 空闲卸载：只丢引用，等待原生 handle 的 finalizer/GC 释放。
 * 是否真正归还 ~318MB 需在 M4 用真实进程 RSS 验证；这里不伪造已释放。
 */
function scheduleIdleUnload(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeSessions > 0) {
      scheduleIdleUnload();
      return;
    }
    recognizer = null;
    cachedModel = null;
  }, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

function decodePcm16Base64(audioBase64: string): Float32Array {
  if (typeof audioBase64 !== "string" || !audioBase64) {
    return new Float32Array(0);
  }
  const buffer = Buffer.from(audioBase64, "base64");
  const count = Math.floor(buffer.length / 2);
  if (count <= 0) {
    return new Float32Array(0);
  }
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768;
  }
  return samples;
}
