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
  try {
    const authHeaders = isTauriRuntime() ? await bridgeAuthHeadersForUrl(fetchTarget.url) : {};
    return await fetch(fetchTarget.url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...fetchTarget.headers,
        ...authHeaders
      }
    });
  } catch (proxyError) {
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
      return await fetch(fetchTarget.directUrl, init);
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

export function buildProxyMissingMessage(mode: ModelRequestMode) {
  if (mode === "production-proxy") {
    return "正式模型代理不可用，请检查服务端 /api/model 是否已部署并可访问。";
  }

  return "开发代理 /void-model-proxy 不可用，请确认本地开发服务正在运行。";
}

export function createProxyNetworkError(message: string, endpointUrl: string, cause?: unknown) {
  return createNetworkError(message, endpointUrl, cause);
}
