import { getSecret, setSecret } from "../../lib/runtime/secretStore";

/** 联网搜索服务商：用户自备 Key，默认 Tavily（RAG 即用，无需二次抓取）。 */
export type WebSearchProviderId = "tavily" | "brave" | "exa";

export type WebSearchConfig = {
  provider: WebSearchProviderId;
  apiKey: string;
};

const WEB_SEARCH_STORAGE_KEY = "void.webSearchConfig.v1";
const WEB_SEARCH_API_KEY_SECRET = "void.webSearchApiKey";

export const WEB_SEARCH_KEY_URLS: Record<WebSearchProviderId, string> = {
  tavily: "https://app.tavily.com/home",
  brave: "https://brave.com/search/api/get-started/",
  exa: "https://dashboard.exa.ai/api-keys"
};

export const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProviderId, string> = {
  tavily: "Tavily（推荐）",
  brave: "Brave Search",
  exa: "Exa"
};

export function isWebSearchProviderId(value: unknown): value is WebSearchProviderId {
  return value === "tavily" || value === "brave" || value === "exa";
}

export function getWebSearchKeyUrl(provider: WebSearchProviderId): string {
  return WEB_SEARCH_KEY_URLS[provider];
}

export function loadWebSearchConfig(): WebSearchConfig {
  try {
    const raw = window.localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WebSearchConfig>;
      if (isWebSearchProviderId(parsed.provider)) {
        return { provider: parsed.provider, apiKey: getSecret(WEB_SEARCH_API_KEY_SECRET) };
      }
    }
  } catch {}
  return { provider: "tavily", apiKey: getSecret(WEB_SEARCH_API_KEY_SECRET) };
}

export function saveWebSearchConfig(config: WebSearchConfig): void {
  const provider = isWebSearchProviderId(config.provider) ? config.provider : "tavily";
  window.localStorage.setItem(WEB_SEARCH_STORAGE_KEY, JSON.stringify({ provider }));
  setSecret(WEB_SEARCH_API_KEY_SECRET, config.apiKey);
}
