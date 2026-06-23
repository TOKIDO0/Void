export type ModelProviderType = "openai-compatible" | "anthropic";

export type ModelRequestMode = "development-proxy";

export type ModelStrength = "low" | "middle" | "high" | "max";

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

export type ModelOption = {
  label: string;
  modelName: string;
  strength: ModelStrength;
};

export type LevelOption = {
  label: string;
  value: number;
};

const MODEL_CONFIG_STORAGE_KEY = "void.modelConfig";
const MODEL_API_KEY_STORAGE_KEY = "void.modelApiKey";

type StoredModelConfig = Omit<ModelConfig, "apiKey">;

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai-compatible",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-5.5",
  temperature: 0.7,
  maxOutputTokens: 2000,
  streamEnabled: false,
  requestMode: "development-proxy"
};

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-5.5"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    modelName: "deepseek-v4-flash"
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
    modelName: "glm-5-flash"
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    modelName: "claude-haiku-4-5"
  }
];

export const MODEL_OPTIONS_BY_PRESET: Record<string, ModelOption[]> = {
  openai: [
    { label: "GPT-5.5", modelName: "gpt-5.5", strength: "max" },
    { label: "GPT-5.4", modelName: "gpt-5.4", strength: "high" },
    { label: "GPT-5.4 mini", modelName: "gpt-5.4-mini", strength: "middle" }
  ],
  deepseek: [
    { label: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash", strength: "low" },
    { label: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", strength: "high" }
  ],
  doubao: [
    { label: "自定义豆包 Ark 模型", modelName: "", strength: "middle" }
  ],
  zhipu: [
    { label: "GLM-5 Flash", modelName: "glm-5-flash", strength: "low" },
    { label: "GLM-5 Turbo", modelName: "glm-5-turbo", strength: "middle" },
    { label: "GLM-5", modelName: "glm-5", strength: "high" },
    { label: "GLM-5.2", modelName: "glm-5.2", strength: "max" }
  ],
  anthropic: [
    { label: "Claude Haiku 4.5", modelName: "claude-haiku-4-5", strength: "low" },
    { label: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", strength: "middle" },
    { label: "Claude Opus 4.8", modelName: "claude-opus-4-8", strength: "high" },
    { label: "Claude Fable 5", modelName: "claude-fable-5", strength: "max" }
  ]
};

export const MODEL_STRENGTH_LABELS: Record<ModelStrength, string> = {
  low: "Low",
  middle: "Middle",
  high: "High",
  max: "Max"
};

export const TEMPERATURE_LEVELS: readonly LevelOption[] = [
  { label: "稳定克制", value: 0.25 },
  { label: "自然平衡", value: 0.7 },
  { label: "发散创造", value: 1.05 }
];

export const MAX_OUTPUT_LEVELS: readonly LevelOption[] = [
  { label: "简短回应", value: 800 },
  { label: "常规任务", value: 2000 },
  { label: "长文/代码", value: 6000 },
  { label: "档案级输出", value: 16000 }
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

  return Math.min(Math.max(Math.round(value), 128), 32768);
}

function isModelProviderType(value: unknown): value is ModelProviderType {
  return value === "openai-compatible" || value === "anthropic";
}
