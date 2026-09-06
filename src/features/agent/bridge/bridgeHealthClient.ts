import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";

const BRIDGE_HEALTH_TIMEOUT_MS = 1500;

/** 工具回合前的只读健康检查，避免本机服务未连接时仍让模型规划一串必然失败的调用。 */
export async function isVoidBridgeReachable(signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BRIDGE_HEALTH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const url = `${resolveVoidBridgeOrigin()}/void-bridge/health`;
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      method: "GET",
      headers: authHeaders,
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
