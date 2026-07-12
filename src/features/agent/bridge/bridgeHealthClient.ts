const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";
const BRIDGE_HEALTH_TIMEOUT_MS = 1500;

function resolveBridgeOrigin() {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const origin = env?.VOID_BRIDGE_ORIGIN?.trim();
  if (origin) {
    return origin.replace(/\/$/, "");
  }
  const port = env?.VOID_BRIDGE_PORT?.trim();
  return port ? `http://127.0.0.1:${port}` : DEFAULT_BRIDGE_ORIGIN;
}

/** 工具回合前的只读健康检查，避免本机服务未连接时仍让模型规划一串必然失败的调用。 */
export async function isVoidBridgeReachable(signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${resolveBridgeOrigin()}/void-bridge/health`, {
      method: "GET",
      signal: controller.signal
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { status?: unknown };
    return payload.status === "ok";
  } catch {
    if (signal?.aborted) {
      throw new DOMException("请求已取消", "AbortError");
    }
    return false;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}
