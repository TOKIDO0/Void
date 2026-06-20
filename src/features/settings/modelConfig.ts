export type ModelProviderType = "openai-compatible" | "anthropic";

export type ModelRequestMode = "development-proxy";

export type ModelConfig = {
  provider: ModelProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  streamEnabled: boolean;
  requestMode: ModelRequestMode;
};

export type ModelPreset = {
  id: string;
  label: string;
  provider: ModelProviderType;
  baseUrl: string;
  modelName: string;
};

const MODEL_CONFIG_STORAGE_KEY = "void.modelConfig";
const MODEL_API_KEY_STORAGE_KEY = "void.modelApiKey";

type StoredModelConfig = Omit<ModelConfig, "apiKey">;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai-compatible",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-4o-mini",
  temperature: 0.7,
  maxOutputTokens: 1200,
  streamEnabled: false,
  requestMode: "development-proxy"
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4o-mini"
  },
  {
    id: "freemodel-default",
    label: "FreeModel 默认线路",
    provider: "openai-compatible",
    baseUrl: "https://api.freemodel.dev/v1",
    modelName: "gpt-4o-mini"
  },
  {
    id: "freemodel-sg",
    label: "FreeModel openai-t1-sg",
    provider: "openai-compatible",
    baseUrl: "https://vip-sg.freemodel.dev/v1",
    modelName: "gpt-4o-mini"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    modelName: "deepseek-chat"
  },
  {
    id: "doubao",
    label: "豆包 Ark",
    provider: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    modelName: ""
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    provider: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelName: "glm-4-flash"
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    modelName: "claude-3-5-haiku-latest"
  }
];

export function loadModelConfig(): ModelConfig {
  const rawConfig = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY);
  const sessionApiKey = window.sessionStorage.getItem(MODEL_API_KEY_STORAGE_KEY) ?? "";
  if (!rawConfig) {
    return {
      ...DEFAULT_MODEL_CONFIG,
      apiKey: sessionApiKey
    };
  }

  try {
    const parsedConfig = JSON.parse(rawConfig) as Partial<StoredModelConfig>;
    return {
      provider: isModelProviderType(parsedConfig.provider) ? parsedConfig.provider : DEFAULT_MODEL_CONFIG.provider,
      apiKey: sessionApiKey,
      baseUrl: parsedConfig.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl,
      modelName: parsedConfig.modelName ?? DEFAULT_MODEL_CONFIG.modelName,
      temperature: normalizeTemperature(parsedConfig.temperature),
      maxOutputTokens: normalizeMaxOutputTokens(parsedConfig.maxOutputTokens),
      streamEnabled: parsedConfig.streamEnabled ?? DEFAULT_MODEL_CONFIG.streamEnabled,
      requestMode: "development-proxy"
    };
  } catch {
    return {
      ...DEFAULT_MODEL_CONFIG,
      apiKey: sessionApiKey
    };
  }
}

export function saveModelConfig(modelConfig: ModelConfig) {
  const storedConfig: StoredModelConfig = {
    provider: modelConfig.provider,
    baseUrl: modelConfig.baseUrl,
    modelName: modelConfig.modelName,
    temperature: normalizeTemperature(modelConfig.temperature),
    maxOutputTokens: normalizeMaxOutputTokens(modelConfig.maxOutputTokens),
    streamEnabled: modelConfig.streamEnabled,
    requestMode: "development-proxy"
  };

  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(storedConfig));
  if (modelConfig.apiKey.trim()) {
    window.sessionStorage.setItem(MODEL_API_KEY_STORAGE_KEY, modelConfig.apiKey.trim());
  } else {
    window.sessionStorage.removeItem(MODEL_API_KEY_STORAGE_KEY);
  }
}

function normalizeTemperature(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_MODEL_CONFIG.temperature;
  }

  return Math.min(Math.max(value, 0), 2);
}

function normalizeMaxOutputTokens(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_MODEL_CONFIG.maxOutputTokens;
  }

  return Math.min(Math.max(Math.round(value), 128), 8192);
}

function isModelProviderType(value: unknown): value is ModelProviderType {
  return value === "openai-compatible" || value === "anthropic";
}
