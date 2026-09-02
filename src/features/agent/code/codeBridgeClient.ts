import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";

function resolveBridgeOrigin(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const origin = env?.VOID_BRIDGE_ORIGIN;
  if (origin && origin.trim()) return origin.replace(/\/$/, "");
  const port = env?.VOID_BRIDGE_PORT;
  if (port && port.trim()) return `http://127.0.0.1:${port.trim()}`;
  return DEFAULT_BRIDGE_ORIGIN;
}

export type CodeRunRequest = { language: "javascript" | "python"; code: string; timeoutMs?: number };
export type CodeRunData = {
  language: "javascript" | "python";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  ranAt: number;
};

function createCodeBridgeError(code: string, message: string, details?: Record<string, unknown>) {
  const error = new Error(message) as Error & { codeBridgeCode: string; details?: Record<string, unknown> };
  error.codeBridgeCode = code;
  error.details = details;
  return error;
}

export function getCodeBridgeErrorInfo(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (typeof error === "object" && error !== null && "codeBridgeCode" in error && typeof (error as { codeBridgeCode?: unknown }).codeBridgeCode === "string") {
    const coded = error as Error & { codeBridgeCode: string; details?: Record<string, unknown> };
    return { code: coded.codeBridgeCode, message: coded.message, details: coded.details };
  }
  if (error instanceof Error) return { code: "INTERNAL_ERROR", message: error.message };
  return { code: "INTERNAL_ERROR", message: "代码执行未知错误" };
}

export async function runCode(input: CodeRunRequest, signal?: AbortSignal): Promise<CodeRunData> {
  const url = `${resolveBridgeOrigin()}/void-code/run`;
  const timeoutController = new AbortController();
  const timeoutMs = Math.max(15_000, (input.timeoutMs ?? 5_000) + 5_000);
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let response: Response;
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(input),
      signal: timeoutController.signal
    });
  } catch (error) {
    const aborted = timeoutController.signal.aborted;
    const message = error instanceof Error ? error.message : "无法连接代码执行服务";
    throw createCodeBridgeError(aborted && signal?.aborted ? "CANCELLED" : aborted ? "TIMEOUT" : "BRIDGE_UNREACHABLE", aborted && signal?.aborted ? "代码执行已取消" : aborted ? `代码执行超时（${url}）` : `代码执行服务不可达（${url}）：${message}`);
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }
  let payload: { ok: boolean; data?: CodeRunData; error?: { code: string; message: string; details?: Record<string, unknown> } };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw createCodeBridgeError("INTERNAL_ERROR", `代码执行返回非 JSON（HTTP ${response.status}）`);
  }
  if (!payload.ok) throw createCodeBridgeError(payload.error?.code ?? "INTERNAL_ERROR", payload.error?.message ?? "代码执行失败", payload.error?.details);
  return payload.data as CodeRunData;
}
