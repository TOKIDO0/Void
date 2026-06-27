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
  } catch (error) {
    if (!(error instanceof TypeError) || !fetchTarget.usesDevelopmentProxy) {
      throw error;
    }

    return fetch(fetchTarget.directUrl, init);
  }
}
