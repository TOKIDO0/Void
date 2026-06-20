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
      headers: {} as Record<string, string>
    };
  }

  return {
    url: "/void-model-proxy",
    headers: {
      "X-VOID-Target-URL": endpointUrl
    } as Record<string, string>
  };
}
