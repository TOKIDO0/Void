export type ModelProviderType = "openai-compatible";

export type ModelConfig = {
  provider: ModelProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  streamEnabled: boolean;
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
  streamEnabled: false
};

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
      provider: parsedConfig.provider === "openai-compatible" ? parsedConfig.provider : DEFAULT_MODEL_CONFIG.provider,
      apiKey: sessionApiKey,
      baseUrl: parsedConfig.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl,
      modelName: parsedConfig.modelName ?? DEFAULT_MODEL_CONFIG.modelName,
      temperature: normalizeTemperature(parsedConfig.temperature),
      maxOutputTokens: normalizeMaxOutputTokens(parsedConfig.maxOutputTokens),
      streamEnabled: parsedConfig.streamEnabled ?? DEFAULT_MODEL_CONFIG.streamEnabled
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
    streamEnabled: modelConfig.streamEnabled
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
