export type ModelProviderType = "openai-compatible";

export type ModelConfig = {
  provider: ModelProviderType;
  apiKey: string;
  baseUrl: string;
  modelName: string;
};

const MODEL_CONFIG_STORAGE_KEY = "void.modelConfig";

type StoredModelConfig = Omit<ModelConfig, "apiKey">;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai-compatible",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-4o-mini"
};

export function loadModelConfig(): ModelConfig {
  const rawConfig = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY);
  if (!rawConfig) {
    return DEFAULT_MODEL_CONFIG;
  }

  try {
    const parsedConfig = JSON.parse(rawConfig) as Partial<StoredModelConfig>;
    return {
      provider: parsedConfig.provider === "openai-compatible" ? parsedConfig.provider : DEFAULT_MODEL_CONFIG.provider,
      apiKey: "",
      baseUrl: parsedConfig.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl,
      modelName: parsedConfig.modelName ?? DEFAULT_MODEL_CONFIG.modelName
    };
  } catch {
    return DEFAULT_MODEL_CONFIG;
  }
}

export function saveModelConfig(modelConfig: ModelConfig) {
  const storedConfig: StoredModelConfig = {
    provider: modelConfig.provider,
    baseUrl: modelConfig.baseUrl,
    modelName: modelConfig.modelName
  };

  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(storedConfig));
}
