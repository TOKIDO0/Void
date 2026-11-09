/**
 * Qwen3-TTS 本地引擎的 Node 侧监督器。
 *
 * 架构：Python 服务负责加载模型和同步生成，Node sidecar 只做
 * 启停/健康检查/请求转发/空闲回收，不把 torch 放进 Node 主线程。
 * 模型、Python 运行时和脚本路径由环境变量覆盖；未安装时返回结构化
 * LOCAL_TTS_ENGINE_UNAVAILABLE，由上层回退 Kokoro。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { VoiceTtsEngineError } from "../voiceTtsShared";

export type QwenTtsStyle = "greeting" | "happy" | "neutral" | "serious";
export type QwenTtsLanguage = "zh" | "ja";

export type QwenTtsOptions = {
  speaker: string;
  language: QwenTtsLanguage;
  style: QwenTtsStyle;
};

export type QwenTtsAudio = {
  pcm: Buffer;
  sampleRate: number;
  provider: "qwen3";
};

type QwenTtsConfig = {
  python: string;
  script: string;
  modelDir: string;
  device: string;
};

type QwenTtsProcess = {
  child: ChildProcess;
  port: number;
  token: string;
};

const SERVICE_IDLE_MS = 10 * 60_000;
const STARTUP_TIMEOUT_MS = 90_000;
const HEALTH_PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_SPEAKER = "ono_anna";

let service: QwenTtsProcess | null = null;
let starting: Promise<QwenTtsProcess> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRequests = 0;

function runtimeRoot(): string {
  return process.env.VOID_RUNTIME_ROOT?.trim() || "D:\\AI\\void-runtime";
}

function resolveConfig(): QwenTtsConfig | null {
  const root = runtimeRoot();
  const python = process.env.VOID_QWEN_TTS_PYTHON?.trim()
    || join(root, "tts-eval", "qwen3-tts", ".venv", "Scripts", "python.exe");
  const modelDir = process.env.VOID_QWEN_TTS_MODEL_DIR?.trim()
    || join(root, "tts-eval", "models", "Qwen3-TTS", "Qwen3-TTS-12Hz-1.7B-CustomVoice");
  // 生产优先用 sidecar-app/qwen3tts/；开发用仓库内脚本。
  const bundledScript = join(process.cwd(), "qwen3tts", "qwen3_tts_server.py");
  const devScript = join(process.cwd(), "server", "voice", "qwen3tts", "qwen3_tts_server.py");
  const script = process.env.VOID_QWEN_TTS_SCRIPT?.trim()
    || (existsSync(bundledScript) ? bundledScript : devScript);
  const device = process.env.VOID_QWEN_TTS_DEVICE?.trim() || "cuda:0";

  if (!existsSync(python) || !existsSync(script) || !existsSync(modelDir)) {
    return null;
  }
  return { python, script, modelDir, device };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("无法分配 Qwen3-TTS 端口"));
      });
    });
  });
}

async function probeHealth(port: number, token: string, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-VOID-Qwen-Token": token },
      signal: controller.signal
    });
    if (!response.ok) return false;
    const payload = await response.json() as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function stopService(): void {
  clearIdleTimer();
  const current = service;
  service = null;
  if (current) {
    try {
      current.child.kill();
    } catch {
      // 已退出
    }
  }
}

function scheduleIdleStop(): void {
  clearIdleTimer();
  if (pendingRequests > 0 || !service) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pendingRequests === 0) {
      stopService();
    }
  }, SERVICE_IDLE_MS);
  idleTimer.unref?.();
}

async function startService(): Promise<QwenTtsProcess> {
  const config = resolveConfig();
  if (!config) {
    throw new VoiceTtsEngineError(
      "LOCAL_TTS_ENGINE_UNAVAILABLE",
      "Qwen3-TTS 语音引擎未安装或路径不完整。请安装语音引擎包，或在设置中改用 Kokoro。"
    );
  }

  const port = await getFreePort();
  const token = randomBytes(24).toString("hex");
  const child = spawn(config.python, [
    config.script,
    "--port", String(port),
    "--model-dir", config.modelDir,
    "--device", config.device,
    "--token", token,
    "--parent-pid", String(process.pid)
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.log(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[qwen3-tts:stderr] ${text}`);
  });
  child.once("exit", (code) => {
    if (service?.child === child) {
      service = null;
      clearIdleTimer();
    }
    console.warn(`[qwen3-tts] service exited code=${code ?? "null"}`);
  });
  child.once("error", (error) => {
    console.error("[qwen3-tts] service spawn error", error);
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new VoiceTtsEngineError(
        "LOCAL_TTS_ENGINE_INIT_FAILED",
        `Qwen3-TTS 服务启动后退出（code=${child.exitCode}）。`
      );
    }
    if (await probeHealth(port, token)) {
      return { child, port, token };
    }
    await sleep(600);
  }
  try { child.kill(); } catch { /* ignore */ }
  throw new VoiceTtsEngineError(
    "LOCAL_TTS_ENGINE_INIT_FAILED",
    "Qwen3-TTS 服务启动超时（首次加载模型可能需要更久）。"
  );
}

async function ensureService(): Promise<QwenTtsProcess> {
  if (service) return service;
  if (!starting) {
    starting = startService()
      .then((created) => {
        service = created;
        scheduleIdleStop();
        return created;
      })
      .finally(() => {
        starting = null;
      });
  }
  return starting;
}

function errorFromPayload(status: number, payload: unknown): VoiceTtsEngineError {
  const body = (payload && typeof payload === "object" ? payload : {}) as {
    error?: { code?: string; message?: string } | string;
  };
  const error = typeof body.error === "object" ? body.error : undefined;
  const code = error?.code === "LOCAL_TTS_TEXT_INVALID"
    ? "LOCAL_TTS_TEXT_INVALID"
    : "LOCAL_TTS_GENERATE_FAILED";
  const message = error?.message
    || (typeof body.error === "string" ? body.error : "")
    || `Qwen3-TTS 合成失败（HTTP ${status}）。`;
  return new VoiceTtsEngineError(code, message);
}

/** 提交一句 Qwen3-TTS。调用方负责文本长度；Python 服务再做一次校验。 */
export async function synthesizeQwenTts(
  text: string,
  options: QwenTtsOptions,
  signal?: AbortSignal
): Promise<QwenTtsAudio> {
  const active = await ensureService();
  pendingRequests += 1;
  clearIdleTimer();
  try {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${active.port}/tts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-VOID-Qwen-Token": active.token
        },
        body: JSON.stringify({
          text,
          speaker: options.speaker || DEFAULT_SPEAKER,
          language: options.language,
          style: options.style
        }),
        signal
      });
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      throw new VoiceTtsEngineError(
        "LOCAL_TTS_ENGINE_INIT_FAILED",
        "Qwen3-TTS 服务未响应，已回退 Kokoro。"
      );
    }
    if (!response.ok) {
      let payload: unknown = null;
      try { payload = await response.json(); } catch { /* ignore */ }
      throw errorFromPayload(response.status, payload);
    }
    const pcm = Buffer.from(await response.arrayBuffer());
    const sampleRate = Number(response.headers.get("x-void-tts-sample-rate") || "24000");
    return {
      pcm,
      sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 24000,
      provider: "qwen3"
    };
  } finally {
    pendingRequests = Math.max(0, pendingRequests - 1);
    scheduleIdleStop();
  }
}

/** 预热：只启动服务，Python 侧自己加载模型并做一次短句预热。 */
export function warmupQwenTts(): void {
  if (!resolveConfig()) return;
  void ensureService().catch((error) => {
    console.warn("[qwen3-tts] warmup skipped:", error instanceof Error ? error.message : error);
  });
}

export function getQwenTtsStatus() {
  const config = resolveConfig();
  return {
    available: Boolean(config),
    running: Boolean(service),
    pendingRequests,
    modelDir: config?.modelDir ?? "",
    device: config?.device ?? ""
  };
}

export function disposeQwenTtsService(): void {
  stopService();
}
