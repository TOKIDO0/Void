import type { ModelRequestMode } from "../../features/settings/modelConfig";
import { createNetworkError, createProxyUnavailableError } from "./providerErrors";
import { bridgeAuthHeadersForUrl } from "../runtime/voidBridgeAuth";
import { isTauriRuntime, resolveBridgeHttpUrl } from "../runtime/voidBridgeRuntime";

type ProviderFetchTarget = {
  url: string;
  directUrl: string;
  headers: Record<string, string>;
  mode: ModelRequestMode;
};

const DEVELOPMENT_PROXY_PATH = "/void-model-proxy";
const PRODUCTION_PROXY_PATH = "/api/model";

/**
 * 模型请求有界等待：前后端全链原本都没有超时，首轮请求一旦 hung 住，
 * 前端永远停在“正在理解你的需求…”，用户无法区分慢还是死。
 * 这里给每一次 fetch（含直连 fallback）加上限，超时即抛诚实错误，
 * 由现有 mapError → failTextResponse 管道展示，不新增 UI 语义。
 * 可用环境变量覆盖，便于联调与验证（毫秒）。
 */
const MODEL_REQUEST_TIMEOUT_MS = readPositiveIntegerEnv("VOID_MODEL_REQUEST_TIMEOUT_MS", 90_000);
/**
 * 流式空闲超时：响应头到达后，body 长时间没有新数据即判定连接已挂起。
 * 只看空闲不看总时长，正常慢生成（持续吐 token）不受影响。
 */
const MODEL_STREAM_IDLE_TIMEOUT_MS = readPositiveIntegerEnv("VOID_MODEL_STREAM_IDLE_TIMEOUT_MS", 60_000);
/** 全量 body 读取（如非流式 response.json）超时。 */
const MODEL_BODY_READ_TIMEOUT_MS = readPositiveIntegerEnv("VOID_MODEL_BODY_READ_TIMEOUT_MS", 90_000);

export class ModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `模型响应超时（${Math.round(timeoutMs / 1000)}秒内没有返回）。可能是模型服务繁忙或网络较慢，请稍后重试；若反复超时，可在设置里更换模型或检查网络。`
    );
    this.name = "ModelRequestTimeoutError";
  }
}

export class ModelStreamStallError extends Error {
  constructor(idleMs: number) {
    super(
      `模型连接已挂起（${Math.round(idleMs / 1000)}秒没有新内容）。服务端接受了请求但不再返回数据，这通常是中转站/网关把连接挂住了，不是你问错了。请直接重试；若反复出现，可更换模型或检查网络。`
    );
    this.name = "ModelStreamStallError";
  }
}

export function getModelStreamIdleTimeoutMs(): number {
  return MODEL_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * 带超时的全量 body 读取：body 挂起时主动 cancel，避免 response.json()/text() 永不 settle。
 * 超时错误复用 ModelRequestTimeoutError，由现有 mapError → failTextResponse 管道诚实展示。
 */
/** 尽力取消挂起的 body 读取：locked/disturbed 流上 cancel 可能同步抛错或返回拒绝 promise，一律吞掉。 */
function cancelBodyQuietly(response: Response): void {
  try {
    const result = response.body?.cancel() as unknown;
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // cancel 失败不影响超时语义
  }
}

export async function readResponseTextWithTimeout(response: Response, timeoutMs = MODEL_BODY_READ_TIMEOUT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelBodyQuietly(response);
        reject(new ModelRequestTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    return await Promise.race([response.text(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readResponseJsonWithTimeout<T>(response: Response, timeoutMs = MODEL_BODY_READ_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelBodyQuietly(response);
        reject(new ModelRequestTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    return await Promise.race([response.json() as Promise<T>, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeEndpointBaseUrl(baseUrl: string, terminalPath: string) {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const normalizedTerminalPath = `/${terminalPath.replace(/^\/+/, "")}`;

  if (trimmedBaseUrl.endsWith(normalizedTerminalPath)) {
    return trimmedBaseUrl.slice(0, -normalizedTerminalPath.length).replace(/\/+$/, "");
  }

  return trimmedBaseUrl;
}

export function buildProviderEndpointUrl(baseUrl: string, terminalPath: string) {
  const endpointBaseUrl = normalizeEndpointBaseUrl(baseUrl, terminalPath);
  return `${endpointBaseUrl}/${terminalPath.replace(/^\/+/, "")}`;
}

/**
 * 解析模型请求的转发目标。
 *
 * 关键设计：请求走哪条链路是【运行环境属性】，不是用户偏好，因此只依据运行时事实判定，
 * 绝不读取任何持久化配置（历史缺陷：requestMode 被持久化成 production-proxy 后，
 * 在本地环境打到不存在的 /api/model，导致模型请求全灭、工具链瘫痪）。
 *
 * 判定顺序：
 *   1) Tauri WebView → sidecar 回环地址上的 /void-model-proxy（打包/开发同路径）。
 *   2) 非浏览器（Node 联调脚本）→ 无同源代理，直连目标 API。
 *   3) 浏览器 + Vite dev → 同源 /void-model-proxy（vite 中间件转发）。
 *   4) 浏览器 + 非 dev（未来 Web 部署）→ 同源 /api/model（服务端代理）。
 */
export function buildFetchTarget(endpointUrl: string) {
  if (isTauriRuntime()) {
    return {
      url: resolveBridgeHttpUrl(DEVELOPMENT_PROXY_PATH),
      directUrl: endpointUrl,
      mode: "development-proxy",
      headers: {
        "X-VOID-Target-URL": endpointUrl
      }
    } satisfies ProviderFetchTarget;
  }

  // Node 联调脚本 / 非浏览器：无 Vite 同源代理，直接打目标 API
  if (typeof window === "undefined") {
    const headers: Record<string, string> = {};
    return {
      url: endpointUrl,
      directUrl: endpointUrl,
      mode: "development-proxy",
      headers
    } satisfies ProviderFetchTarget;
  }

  // Vite 注入 import.meta.env；非 Vite 打包上下文可能没有，不能裸读 DEV
  const isViteDev = Boolean(
    typeof import.meta !== "undefined"
    && import.meta.env
    && import.meta.env.DEV
  );

  if (!isViteDev) {
    return {
      url: PRODUCTION_PROXY_PATH,
      directUrl: endpointUrl,
      mode: "production-proxy",
      headers: {
        "X-VOID-Target-URL": endpointUrl
      }
    } satisfies ProviderFetchTarget;
  }

  return {
    url: DEVELOPMENT_PROXY_PATH,
    directUrl: endpointUrl,
    mode: "development-proxy",
    headers: {
      "X-VOID-Target-URL": endpointUrl
    }
  } satisfies ProviderFetchTarget;
}

export async function fetchWithProxyFallback(fetchTarget: ProviderFetchTarget, init: RequestInit) {
  const timeout = startRequestTimeout(init.signal);
  try {
    return await fetchWithTimeout(fetchTarget, init, timeout);
  } finally {
    timeout.cleanup();
  }
}

/**
 * 超时控制器：用户打断信号与超时二选一，先到先生效。
 * 超时触发只记标记，由调用方把 AbortError 翻译成诚实超时错误；
 * 用户主动打断则原样重抛，保持现有打断语义不变。
 */
function startRequestTimeout(userSignal: AbortSignal | null | undefined) {
  const controller = new AbortController();
  let timedOut = false;
  const onUserAbort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MODEL_REQUEST_TIMEOUT_MS);
  if (userSignal) {
    if (userSignal.aborted) {
      controller.abort();
    } else {
      userSignal.addEventListener("abort", onUserAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      userSignal?.removeEventListener("abort", onUserAbort);
    }
  };
}

async function fetchWithTimeout(
  fetchTarget: ProviderFetchTarget,
  init: RequestInit,
  timeout: ReturnType<typeof startRequestTimeout>
) {
  const requestInit: RequestInit = { ...init, signal: timeout.signal };
  try {
    try {
      const authHeaders = isTauriRuntime() ? await bridgeAuthHeadersForUrl(fetchTarget.url) : {};
      return await fetch(fetchTarget.url, {
        ...requestInit,
        headers: {
          ...(requestInit.headers as Record<string, string> | undefined),
          ...fetchTarget.headers,
          ...authHeaders
        }
      });
    } catch (proxyError) {
      throw normalizeTimeoutError(proxyError, timeout);
    }
  } catch (proxyError) {
    if (proxyError instanceof ModelRequestTimeoutError) {
      throw proxyError;
    }
    if (fetchTarget.mode === "production-proxy") {
      throw createProxyUnavailableError(
        "正式模型代理不可用，请检查服务端代理链路或部署配置。",
        fetchTarget.directUrl,
        proxyError
      );
    }

    if (!(proxyError instanceof TypeError)) {
      throw proxyError;
    }

    try {
      return await fetch(fetchTarget.directUrl, requestInit);
    } catch (directError) {
      if (!(directError instanceof TypeError)) {
        throw directError;
      }

      throw createProxyUnavailableError(
        "开发代理 /void-model-proxy 不可用，且浏览器直连目标接口也失败了。",
        fetchTarget.directUrl,
        {
          proxyError,
          directError
        }
      );
    }
  }
}

function normalizeTimeoutError(error: unknown, timeout: ReturnType<typeof startRequestTimeout>): unknown {
  if (timeout.timedOut() && error instanceof DOMException && error.name === "AbortError") {
    return new ModelRequestTimeoutError(MODEL_REQUEST_TIMEOUT_MS);
  }
  return error;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildProxyMissingMessage(mode: ModelRequestMode) {
  if (mode === "production-proxy") {
    return "正式模型代理不可用，请检查服务端 /api/model 是否已部署并可访问。";
  }

  return "开发代理 /void-model-proxy 不可用，请确认本地开发服务正在运行。";
}

export function createProxyNetworkError(message: string, endpointUrl: string, cause?: unknown) {
  return createNetworkError(message, endpointUrl, cause);
}
