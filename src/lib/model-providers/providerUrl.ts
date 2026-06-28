import type { ModelRequestMode } from "../../features/settings/modelConfig";
import { createNetworkError, createProxyUnavailableError } from "./providerErrors";

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

export function buildFetchTarget(endpointUrl: string, requestMode: ModelRequestMode) {
  if (requestMode === "production-proxy") {
    return {
      url: PRODUCTION_PROXY_PATH,
      directUrl: endpointUrl,
      mode: "production-proxy",
      headers: {
        "X-VOID-Target-URL": endpointUrl
      }
    } satisfies ProviderFetchTarget;
  }

  if (!import.meta.env.DEV) {
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
    return await fetch(fetchTarget.url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...fetchTarget.headers
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
