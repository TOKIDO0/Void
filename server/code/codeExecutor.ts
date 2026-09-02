import { spawn } from "node:child_process";
import { createContext, Script } from "node:vm";
import type { CodeLanguage, CodeRunData } from "./codeTypes";

const MAX_CODE_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;

function createCodeError(code: string, message: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, details });
}

export function getCodeErrorPayload(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  const maybe = error as { code?: string; message?: string; details?: Record<string, unknown> };
  if (maybe && typeof maybe.code === "string" && typeof maybe.message === "string") {
    return { code: maybe.code, message: maybe.message, details: maybe.details };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "执行失败" };
}

function clampTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) throw createCodeError("INVALID_REQUEST", "timeoutMs 必须是数字");
  const n = Math.floor(value);
  if (n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) throw createCodeError("INVALID_REQUEST", `timeoutMs 必须在 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} 之间`);
  return n;
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`, truncated: true };
}

async function runJavascript(code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const logs: string[] = [];
  let truncated = false;
  const pushLog = (args: unknown[]) => {
    const line = args.map((v) => {
      if (typeof v === "string") return v;
      try { return JSON.stringify(v); } catch { return String(v); }
    }).join(" ");
    if (logs.join("\n").length + line.length > MAX_OUTPUT_CHARS) truncated = true;
    logs.push(line);
  };
  const sandbox: Record<string, unknown> = {
    console: {
      log: (...args: unknown[]) => pushLog(args),
      error: (...args: unknown[]) => pushLog(args),
      warn: (...args: unknown[]) => pushLog(args),
      info: (...args: unknown[]) => pushLog(args)
    },
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    setTimeout: undefined, setInterval: undefined, queueMicrotask: undefined,
    // 禁止访问外部
    require: undefined, process: undefined, global: undefined, globalThis: undefined, Buffer: undefined, fetch: undefined, URL: undefined
  };
  const context = createContext(sandbox, { name: "void-code-js" });
  const wrapped = `"use strict"; (async () => { ${code} })()`;
  const script = new Script(wrapped, { filename: "void-code.js" });
  const start = Date.now();
  try {
    const maybePromise = script.runInContext(context, { timeout: timeoutMs, displayErrors: true }) as unknown;
    if (maybePromise && typeof (maybePromise as { then?: unknown }).then === "function") {
      const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs));
      const value = await Promise.race([maybePromise as Promise<unknown>, timeoutPromise]);
      if (value !== undefined) pushLog([String(value)]);
    }
    const raw = logs.join("\n");
    const t = truncateOutput(raw);
    return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false };
  } catch (error) {
    const elapsed = Date.now() - start;
    const isTimeout = error instanceof Error && /Script execution timed out/i.test(error.message);
    const rawErr = error instanceof Error ? error.message : String(error);
    // 超时视为 timedOut
    if (isTimeout || elapsed >= timeoutMs) {
      const raw = logs.join("\n");
      const t = truncateOutput(raw);
      const errSuffix = `\n[timeout after ${timeoutMs}ms] ${rawErr}`;
      const combined = t.text + errSuffix;
      const final = truncateOutput(combined);
      return { stdout: final.text, stderr: rawErr, exitCode: null, timedOut: true };
    }
    const raw = logs.join("\n");
    const t = truncateOutput(raw);
    const errText = rawErr.slice(0, 4000);
    return { stdout: t.text, stderr: errText, exitCode: 1, timedOut: false };
  }
}

async function runPython(code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  // 优先 python，其次 python3
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const bin of candidates) {
    const result = await tryRunPythonBin(bin, code, timeoutMs);
    if (result !== null) return result;
  }
  throw createCodeError("PYTHON_NOT_FOUND", "本机未找到可用的 python/python3 解释器，请先安装 Python 3");
}

function tryRunPythonBin(bin: string, code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-c", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill(); } catch {}
      // 强制杀
      setTimeout(() => { try { child.kill("SIGKILL" as unknown as string); } catch {} }, 500);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT_CHARS + 5000) {
        // 背压：kill 超长输出
        if (!killed) {
          killed = true;
          try { child.kill(); } catch {}
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        resolve(null);
        return;
      }
      resolve({ stdout: truncateOutput(stdout).text, stderr: err.message.slice(0, 4000), exitCode: 1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const outT = truncateOutput(stdout);
      const errT = truncateOutput(stderr);
      const truncated = outT.truncated || errT.truncated;
      // 超长截断标记
      resolve({ stdout: outT.text, stderr: timedOut ? `timeout after ${timeoutMs}ms\n` + errT.text : errT.text, exitCode: timedOut ? null : code, timedOut, truncated } as unknown as { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean });
      void truncated;
    });
  });
}

export async function executeCode(request: { language: CodeLanguage; code: string; timeoutMs?: number }): Promise<CodeRunData> {
  const language = request.language;
  if (language !== "javascript" && language !== "python") throw createCodeError("INVALID_REQUEST", "language 必须是 javascript | python");
  const code = typeof request.code === "string" ? request.code : "";
  const trimmed = code.trim();
  if (!trimmed) throw createCodeError("INVALID_REQUEST", "code 不能为空");
  if (code.length > MAX_CODE_CHARS) throw createCodeError("INVALID_REQUEST", `code 不能超过 ${MAX_CODE_CHARS} 字符`);
  // 轻量黑名单：阻止明显逃逸尝试（仅提示，不依赖它做安全边界）
  const lower = trimmed.toLowerCase();
  if (language === "javascript") {
    const blocked = ["process", "require(", "child_process", "fs.", "net.", "fetch(", "import("];
    for (const pat of blocked) {
      if (lower.includes(pat) && pat !== "process") {
        // 仅告警不阻断，vm 已隔离；process 常见于用户误写，给友好提示
        if (pat === "require(" || pat === "child_process" || pat === "fs.") {
          throw createCodeError("BLOCKED_PATTERN", `JS 沙箱不支持 ${pat}，请使用纯计算逻辑`);
        }
      }
    }
  }
  if (language === "python") {
    const pyBlocked = ["os.system", "subprocess", "socket", "__import__('os')"];
    for (const pat of pyBlocked) {
      if (lower.includes(pat)) {
        // 仅对高危做阻断，避免用户误用
        if (pat === "os.system" || pat === "subprocess") {
          throw createCodeError("BLOCKED_PATTERN", `Python 沙箱不支持 ${pat}，请使用纯计算逻辑`);
        }
      }
    }
  }
  const timeoutMs = clampTimeout(request.timeoutMs);
  const started = Date.now();
  const ranAt = Date.now();
  let result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };
  if (language === "javascript") result = await runJavascript(code, timeoutMs);
  else result = await runPython(code, timeoutMs);
  const durationMs = Date.now() - started;
  const outTrunc = result.stdout.length >= MAX_OUTPUT_CHARS || result.stderr.length >= MAX_OUTPUT_CHARS;
  return {
    language,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    truncated: outTrunc,
    ranAt
  };
}
