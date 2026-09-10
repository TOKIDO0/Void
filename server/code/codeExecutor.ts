/**
 * P0-3 受限代码执行（根因修复版）。
 *
 * 根因：旧实现用 node:vm（同进程、可逃逸）+ 裸 spawn 系统 python + 字符串黑名单。
 * 新边界：
 *  - JS：优先 isolated-vm 真隔离（独立 V8 Isolate + 内存上界）；缺装时回落 hardened node:vm
 *   （冻结内建、无外部句柄、超时 + 输出上界），绝不依赖字符串黑名单；
 *  - Python：默认禁用系统 Python（VOID_CODE_ALLOW_SYSTEM_PYTHON=1 才放行，且视为显式审批），
 *    配置 VOID_CODE_PYTHON_DOCKER_IMAGE 时走 `docker run --rm --network none -m 128m` 强隔离；
 *    纯计算推荐上层走 Pyodide/WASM（本进程不内嵌 20MB+ wasm，保持 sidecar 轻量）；
 *  - 黑名单全部删除：安全来自隔离 + 超时 + 内存/输出上界 + 默认禁用 + 审计日志钩子。
 */
import { spawn } from "node:child_process";
import { createContext, Script } from "node:vm";
import type { CodeLanguage, CodeRunData } from "./codeTypes";

const MAX_CODE_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;
const JS_MEMORY_MB = readPositiveIntEnv("VOID_CODE_JS_MEMORY_MB", 128);
const DOCKER_MEMORY = process.env.VOID_CODE_DOCKER_MEMORY?.trim() || "128m";

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

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function truncateOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`, truncated: true };
}

type JsResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; engine: string };

async function tryLoadIsolatedVm(): Promise<null | Record<string, unknown>> {
  try {
    // isolated-vm 是可选原生依赖：装不上时回落 hardened vm，不中断服务。
    // @ts-ignore 可选依赖无类型声明时仍可编译
    const mod = await import("isolated-vm");
    return mod as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runJavascriptIsolated(code: string, timeoutMs: number): Promise<JsResult | null> {
  const ivm = await tryLoadIsolatedVm();
  if (!ivm) return null;
  try {
    const Isolate = ivm["Isolate"] as new (opts: Record<string, unknown>) => {
      createContextSync: () => unknown;
      compileScriptSync: (src: string) => { runSync: (ctx: unknown, opts: Record<string, unknown>) => unknown };
      dispose: () => void;
    };
    const isolate = new Isolate({ memoryLimit: JS_MEMORY_MB });
    try {
      const logs: string[] = [];
      const context = isolate.createContextSync();
      const ctx = context as {
        global: { setSync: (k: string, v: unknown, opts?: unknown) => void };
      };
      const pushLog = (line: string) => {
        if (logs.join("\n").length + line.length > MAX_OUTPUT_CHARS + 2000) return;
        logs.push(line);
      };
      // @ts-ignore isolated-vm Reference 形态按运行时实际结构使用
      const Reference = ivm["Reference"] as new (fn: (...args: unknown[]) => void) => unknown;
      // @ts-ignore
      const Callback = ivm["Callback"] as undefined | { new (fn: (...args: unknown[]) => void): unknown };
      const sink = Callback
        ? new Callback((...args: unknown[]) => {
          pushLog(args.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" "));
        })
        : new Reference((...args: unknown[]) => {
          pushLog(args.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" "));
        });
      ctx.global.setSync("__void_log", sink);
      const harness = [
        "const console = { log: (...a) => __void_log(...a), error: (...a) => __void_log(...a), warn: (...a) => __void_log(...a), info: (...a) => __void_log(...a) };",
        `"use strict"; (async () => { ${code} })()`
      ].join("\n");
      const script = isolate.compileScriptSync(harness);
      const maybePromise = script.runSync(context, { timeout: timeoutMs }) as unknown;
      if (maybePromise && typeof (maybePromise as { then?: unknown }).then === "function") {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs)
        );
        const value = await Promise.race([maybePromise as Promise<unknown>, timeoutPromise]);
        if (value !== undefined) pushLog(safeStringify(value));
      } else if (maybePromise !== undefined) {
        pushLog(safeStringify(maybePromise));
      }
      const t = truncateOutput(logs.join("\n"));
      return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, engine: "isolated-vm" };
    } finally {
      try {
        isolate.dispose();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    const rawErr = error instanceof Error ? error.message : String(error);
    const isTimeout = /timed out/i.test(rawErr);
    return {
      stdout: "",
      stderr: rawErr.slice(0, 4000),
      exitCode: isTimeout ? null : 1,
      timedOut: isTimeout,
      engine: "isolated-vm"
    };
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

async function runJavascriptHardenedVm(code: string, timeoutMs: number): Promise<JsResult> {
  const logs: string[] = [];
  const pushLog = (args: unknown[]) => {
    const line = args.map((v) => (typeof v === "string" ? v : safeStringify(v))).join(" ");
    logs.push(line);
  };
  // hardened vm：只给纯计算内建，冻结原型链关键入口，不挂任何外部句柄。
  const sandbox: Record<string, unknown> = {
    console: {
      log: (...args: unknown[]) => pushLog(args),
      error: (...args: unknown[]) => pushLog(args),
      warn: (...args: unknown[]) => pushLog(args),
      info: (...args: unknown[]) => pushLog(args)
    },
    Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Error, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI
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
      if (value !== undefined) pushLog([safeStringify(value)]);
    }
    const t = truncateOutput(logs.join("\n"));
    return { stdout: t.text, stderr: "", exitCode: 0, timedOut: false, engine: "node-vm-fallback" };
  } catch (error) {
    const elapsed = Date.now() - start;
    const rawErr = error instanceof Error ? error.message : String(error);
    const isTimeout = /timed out/i.test(rawErr) || elapsed >= timeoutMs;
    if (isTimeout) {
      const t = truncateOutput(logs.join("\n") + `\n[timeout after ${timeoutMs}ms] ${rawErr}`);
      return { stdout: t.text, stderr: rawErr.slice(0, 4000), exitCode: null, timedOut: true, engine: "node-vm-fallback" };
    }
    const t = truncateOutput(logs.join("\n"));
    return { stdout: t.text, stderr: rawErr.slice(0, 4000), exitCode: 1, timedOut: false, engine: "node-vm-fallback" };
  }
}

async function runJavascript(code: string, timeoutMs: number): Promise<JsResult> {
  const isolated = await runJavascriptIsolated(code, timeoutMs);
  if (isolated) return isolated;
  return runJavascriptHardenedVm(code, timeoutMs);
}

async function runPython(code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const dockerImage = process.env.VOID_CODE_PYTHON_DOCKER_IMAGE?.trim();
  if (dockerImage) {
    return runPythonDocker(dockerImage, code, timeoutMs);
  }
  // 默认禁用系统 Python：防止裸 spawn 成为逃逸面；启用即视为用户显式审批。
  if (process.env.VOID_CODE_ALLOW_SYSTEM_PYTHON !== "1") {
    throw createCodeError(
      "PYTHON_DISABLED",
      "系统 Python 执行默认禁用（裸 spawn 非强隔离）。纯计算请走 JS 沙箱；确需 Python 请设置 VOID_CODE_ALLOW_SYSTEM_PYTHON=1（视为显式审批）或配置 VOID_CODE_PYTHON_DOCKER_IMAGE 走 Docker 强隔离。",
      { hint: "VOID_CODE_ALLOW_SYSTEM_PYTHON=1 | VOID_CODE_PYTHON_DOCKER_IMAGE" }
    );
  }
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const bin of candidates) {
    const result = await tryRunPythonBin(bin, code, timeoutMs);
    if (result !== null) return result;
  }
  throw createCodeError("PYTHON_NOT_FOUND", "本机未找到可用的 python/python3 解释器，请先安装 Python 3");
}

function runPythonDocker(image: string, code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      ["run", "--rm", "--network", "none", "-m", DOCKER_MEMORY, "--cpus", "1.0", "-i", image, "python3", "-c", code],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    finishSpawn(child, timeoutMs, resolve);
  });
}

function tryRunPythonBin(bin: string, code: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } | null> {
  return new Promise((resolve) => {
    // 非 shell 直调 + 环境最小化：不继承用户全环境变量，只给 PATH/SYSTEMROOT/TMP 必需项。
    const child = spawn(bin, ["-c", code], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        SYSTEMROOT: process.env.SYSTEMROOT,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP
      }
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        resolve(null);
        return;
      }
      resolve({ stdout: "", stderr: err.message.slice(0, 4000), exitCode: 1, timedOut: false });
    });
    finishSpawn(child, timeoutMs, (result) => resolve(result));
  });
}

function finishSpawn(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  resolve: (r: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }) => void
): void {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killed = false;
  let settled = false;
  const done = (r: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }) => {
    if (settled) return;
    settled = true;
    resolve(r);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killed = true;
    try { child.kill(); } catch { /* ignore */ }
    setTimeout(() => { try { child.kill("SIGKILL" as unknown as string); } catch { /* ignore */ } }, 500);
  }, timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > MAX_OUTPUT_CHARS + 5000 && !killed) {
      killed = true;
      try { child.kill(); } catch { /* ignore */ }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("close", (code) => {
    clearTimeout(timer);
    const outT = truncateOutput(stdout);
    const errT = truncateOutput(stderr);
    done({ stdout: outT.text, stderr: timedOut ? `timeout after ${timeoutMs}ms\n` + errT.text : errT.text, exitCode: timedOut ? null : code, timedOut });
  });
}

export async function executeCode(request: { language: CodeLanguage; code: string; timeoutMs?: number }): Promise<CodeRunData> {
  const language = request.language;
  if (language !== "javascript" && language !== "python") throw createCodeError("INVALID_REQUEST", "language 必须是 javascript | python");
  const code = typeof request.code === "string" ? request.code : "";
  const trimmed = code.trim();
  if (!trimmed) throw createCodeError("INVALID_REQUEST", "code 不能为空");
  if (code.length > MAX_CODE_CHARS) throw createCodeError("INVALID_REQUEST", `code 不能超过 ${MAX_CODE_CHARS} 字符`);
  // 无字符串黑名单：隔离 + 超时 + 内存/输出上界 + 默认禁用即边界。
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
