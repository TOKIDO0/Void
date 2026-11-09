import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  DEFAULT_VOICE_ID,
  IDLE_UNLOAD_MS,
  MAX_TEXT_CHARS,
  SAMPLE_RATE_FALLBACK,
  VoiceTtsEngineError,
  type VoiceTtsEngineErrorCode,
  type VoiceTtsWorkerRequest,
  type VoiceTtsWorkerResponse
} from "./voiceTtsShared";
import {
  inspectVoiceTtsModel,
  resolveVoiceTtsModelDir
} from "./voiceTtsModelManager";
import {
  disposeQwenTtsService,
  getQwenTtsStatus,
  synthesizeQwenTts,
  type QwenTtsLanguage,
  type QwenTtsStyle
} from "./qwen3tts/qwenTtsService";

export { VoiceTtsEngineError } from "./voiceTtsShared";
export type { VoiceTtsEngineErrorCode } from "./voiceTtsShared";

/** 队列上限：正常一轮最多 2 句并发 + 少量余量；满则快速返回 BUSY，避免无界堆积。 */
const MAX_PENDING_TTS = 8;

export type LocalTtsEngine = "kokoro" | "qwen3";

export type LocalTtsOptions = {
  engine?: LocalTtsEngine;
  speaker?: string;
  language?: QwenTtsLanguage;
  style?: QwenTtsStyle;
};

export type LocalTtsAudio = {
  pcm: Buffer;
  sampleRate: number;
  provider: "kokoro" | "qwen3";
};

type PendingTtsTask = {
  id: number;
  text: string;
  voiceId?: number;
  signal?: AbortSignal;
  settled: boolean;
  canceled: boolean;
  resolve: (audio: LocalTtsAudio) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
};

let worker: Worker | null = null;
let inFlight: PendingTtsTask | null = null;
const pendingTasks: PendingTtsTask[] = [];
let nextTaskId = 1;

/**
 * worker 脚本路径：
 * - 生产：Rust 以 cwd=<resourceDir>/sidecar-app 拉起，tts-worker.cjs 与 void-bridge.cjs 同级；
 * - 生产模拟：同样以 cwd=sidecar-app 启动；
 * - 开发：cwd=仓库根，tsx 直接跑 server/voice/voiceTtsWorker.ts，复用主进程 tsx loader。
 * 不用 __dirname：server 以 ESM 运行（package.json type=module），tsx 不注入该变量。
 * 不在主线程加载 sherpa-onnx-node，避免同步 generate 阻塞事件循环。
 */
function resolveWorkerScript(): { script: string; execArgv?: string[] } {
  const builtWorker = join(process.cwd(), "tts-worker.cjs");
  if (existsSync(builtWorker)) {
    return { script: builtWorker };
  }
  const devWorker = join(process.cwd(), "server", "voice", "voiceTtsWorker.ts");
  if (existsSync(devWorker)) {
    return { script: devWorker, execArgv: process.execArgv };
  }
  throw new Error(`无法定位 TTS worker：${builtWorker} / ${devWorker}`);
}

function normalizeWorkerErrorCode(code: unknown): VoiceTtsEngineErrorCode {
  switch (code) {
    case "LOCAL_TTS_MODEL_MISSING":
    case "LOCAL_TTS_MODEL_INVALID":
    case "LOCAL_TTS_ENGINE_INIT_FAILED":
    case "LOCAL_TTS_TEXT_INVALID":
    case "LOCAL_TTS_GENERATE_FAILED":
      return code;
    default:
      return "LOCAL_TTS_GENERATE_FAILED";
  }
}

function finishTask(task: PendingTtsTask, audio: LocalTtsAudio | null, error: Error | null): void {
  if (task.settled) {
    return;
  }
  task.settled = true;
  if (task.onAbort && task.signal) {
    task.signal.removeEventListener("abort", task.onAbort);
  }
  if (error) {
    task.reject(error);
    return;
  }
  if (audio) {
    task.resolve(audio);
  }
}

function cancelTask(task: PendingTtsTask): void {
  if (task.settled) {
    return;
  }
  task.canceled = true;
  if (inFlight === task) {
    // worker 的同步 generate 无法中断；先向前端结算，结果返回后丢弃。
    finishTask(task, null, new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成已取消。"));
    return;
  }
  const queueIndex = pendingTasks.indexOf(task);
  if (queueIndex >= 0) {
    pendingTasks.splice(queueIndex, 1);
  }
  finishTask(task, null, new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成已取消。"));
}

function pumpQueue(): void {
  if (inFlight || pendingTasks.length === 0) {
    return;
  }

  let task = pendingTasks.shift();
  while (task && (task.canceled || task.settled)) {
    task = pendingTasks.shift();
  }
  if (!task) {
    return;
  }

  inFlight = task;
  try {
    const target = ensureWorker();
    const message: VoiceTtsWorkerRequest = {
      type: "synthesize",
      id: task.id,
      text: task.text,
      voiceId: task.voiceId
    };
    target.postMessage(message);
  } catch (error) {
    inFlight = null;
    finishTask(
      task,
      null,
      new VoiceTtsEngineError(
        "LOCAL_TTS_ENGINE_INIT_FAILED",
        error instanceof Error ? error.message : "本地语音合成线程启动失败。"
      )
    );
    pumpQueue();
  }
}

function handleWorkerMessage(source: Worker, message: VoiceTtsWorkerResponse): void {
  if (source !== worker || !message || typeof message.id !== "number") {
    return;
  }
  const task = inFlight;
  if (!task || task.id !== message.id) {
    return;
  }
  inFlight = null;

  if (task.canceled || task.settled || task.signal?.aborted) {
    finishTask(task, null, new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成已取消。"));
  } else if (message.type === "result") {
    finishTask(task, {
      pcm: Buffer.from(message.pcm.buffer, message.pcm.byteOffset, message.pcm.byteLength),
      sampleRate: message.sampleRate || SAMPLE_RATE_FALLBACK,
      provider: "kokoro"
    }, null);
  } else {
    finishTask(task, null, new VoiceTtsEngineError(
      normalizeWorkerErrorCode(message.code),
      message.message
    ));
  }
  pumpQueue();
}

function failInFlight(error: Error): void {
  const task = inFlight;
  inFlight = null;
  if (task) {
    finishTask(task, null, error);
  }
  pumpQueue();
}

function handleWorkerFailure(source: Worker, error: Error): void {
  if (source !== worker) {
    return;
  }
  worker = null;
  failInFlight(new VoiceTtsEngineError(
    "LOCAL_TTS_ENGINE_INIT_FAILED",
    error instanceof Error ? error.message : "本地语音合成线程异常。"
  ));
}

function handleWorkerExit(source: Worker, code: number): void {
  if (source !== worker) {
    return;
  }
  worker = null;
  failInFlight(new VoiceTtsEngineError(
    "LOCAL_TTS_ENGINE_INIT_FAILED",
    `本地语音合成线程已退出（code=${code}）。`
  ));
}

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  const { script, execArgv } = resolveWorkerScript();
  const created = new Worker(script, {
    execArgv,
    workerData: { modelDir: resolveVoiceTtsModelDir() }
  });
  created.on("message", (message: VoiceTtsWorkerResponse) => handleWorkerMessage(created, message));
  created.on("error", (error) => handleWorkerFailure(created, error));
  created.on("exit", (code) => handleWorkerExit(created, code));
  worker = created;
  return created;
}

/**
 * 提交一句本地 TTS。主线程只做队列/取消/HTTP，不执行同步 generate。
 * signal 由 HTTP 请求的 aborted/close 触发，队列中与合成中的任务都可取消。
 */
export function synthesizeLocalTts(
  text: string,
  voiceId = DEFAULT_VOICE_ID,
  signal?: AbortSignal,
  options: LocalTtsOptions = {}
): Promise<LocalTtsAudio> {
  const normalized = text.trim();
  if (!normalized) {
    return Promise.reject(new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "没有可合成的文本。"));
  }
  if (normalized.length > MAX_TEXT_CHARS) {
    return Promise.reject(new VoiceTtsEngineError("LOCAL_TTS_TEXT_INVALID", "单句文本过长，请缩短后再试。"));
  }
  if (signal?.aborted) {
    return Promise.reject(new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成已取消。"));
  }

  if (options.engine === "qwen3") {
    return synthesizeQwenTts(normalized, {
      speaker: options.speaker?.trim() || "ono_anna",
      language: options.language === "ja" ? "ja" : "zh",
      style: options.style ?? "neutral"
    }, signal);
  }
  if (pendingTasks.length + (inFlight ? 1 : 0) >= MAX_PENDING_TTS) {
    return Promise.reject(new VoiceTtsEngineError("LOCAL_TTS_BUSY", "本地语音合成队列已满，请稍后重试。"));
  }

  return new Promise<LocalTtsAudio>((resolve, reject) => {
    const task: PendingTtsTask = {
      id: nextTaskId,
      text: normalized,
      voiceId,
      signal,
      settled: false,
      canceled: false,
      resolve,
      reject
    };
    nextTaskId += 1;

    if (signal) {
      task.onAbort = () => cancelTask(task);
      signal.addEventListener("abort", task.onAbort, { once: true });
    }

    pendingTasks.push(task);
    pumpQueue();
  });
}

/** 服务关闭时终止 worker，避免空闲线程把 sidecar 进程留在后台。 */
export async function disposeVoiceTtsEngine(): Promise<void> {
  disposeQwenTtsService();
  for (const task of pendingTasks.splice(0)) {
    finishTask(task, null, new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成服务已关闭。"));
  }
  if (inFlight) {
    const task = inFlight;
    inFlight = null;
    finishTask(task, null, new VoiceTtsEngineError("LOCAL_TTS_ABORTED", "语音合成服务已关闭。"));
  }
  const current = worker;
  worker = null;
  if (current) {
    await current.terminate().catch(() => undefined);
  }
}

export function getVoiceTtsEngineStatus() {
  return {
    engineLoaded: Boolean(worker),
    workerMode: true,
    workerAlive: Boolean(worker),
    queueDepth: pendingTasks.length,
    inFlight: Boolean(inFlight),
    idleUnloadMs: IDLE_UNLOAD_MS,
    model: inspectVoiceTtsModel(),
    modelDir: resolveVoiceTtsModelDir(),
    defaultVoiceId: DEFAULT_VOICE_ID,
    qwen3: getQwenTtsStatus()
  };
}
