import { createNetworkError, createProxyUnavailableError } from "./providerErrors";

type ProviderFetchTarget = {
  url: string;
  directUrl: string;
  headers: Record<string, string>;
  usesDevelopmentProxy: boolean;
};

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

export function buildFetchTarget(endpointUrl: string) {
  if (!import.meta.env.DEV) {
    return {
      url: endpointUrl,
      directUrl: endpointUrl,
      usesDevelopmentProxy: false,
      headers: {} as Record<string, string>
    } satisfies ProviderFetchTarget;
  }

  return {
    url: "/void-model-proxy",
    directUrl: endpointUrl,
    usesDevelopmentProxy: true,
    headers: {
      "X-VOID-Target-URL": endpointUrl
    } as Record<string, string>
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
    if (!(proxyError instanceof TypeError) || !fetchTarget.usesDevelopmentProxy) {
      if (proxyError instanceof TypeError) {
        throw createNetworkError(
          "模型网络请求失败，请检查 Base URL、网络连通性或目标接口的 CORS 配置。",
          fetchTarget.directUrl,
          proxyError
        );
      }

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
