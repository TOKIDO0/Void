import { getSecret, setSecret, getSecretAsync, setSecretAsync } from "../../lib/runtime/secretStore";
import { isVaultRef } from "../../lib/runtime/secretVault";

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
  // 后台尽力迁入 vault（Stronghold 可用则只留引用清明文），失败不影响本次保存。
  void setSecretAsync(WEB_SEARCH_API_KEY_SECRET, config.apiKey).catch(() => undefined);
}

/** 运行时真相源：vault 引用先解成明文，绝不把引用当 Key 发出去。 */
export async function loadWebSearchConfigAsync(): Promise<WebSearchConfig> {
  const provider = loadWebSearchConfig().provider;
  try {
    const resolved = (await getSecretAsync(WEB_SEARCH_API_KEY_SECRET)).trim();
    if (resolved && !isVaultRef(resolved)) return { provider, apiKey: resolved };
  } catch {}
  return loadWebSearchConfig();
}
