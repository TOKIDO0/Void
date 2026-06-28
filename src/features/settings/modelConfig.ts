export type ModelProviderType = "openai-compatible" | "anthropic";

export type ModelRequestMode = "development-proxy" | "production-proxy";

export type ModelStrength = "low" | "middle" | "high" | "max";

export type ModelConfig = {
  provider: ModelProviderType;
  presetId: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  modelStrength: ModelStrength;
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

type StoredModelConfig = Omit<ModelConfig, "apiKey">;

const MODEL_CONFIG_STORAGE_KEY = "void.modelConfig";
const MODEL_API_KEY_STORAGE_KEY = "void.modelApiKey";

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai-compatible",
  presetId: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-5.5",
  modelStrength: "middle",
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
    modelName: "doubao-1-5-lite-32k-250115"
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    provider: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    modelName: "glm-5.2"
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
    { label: "GPT-5.4 Pro", modelName: "gpt-5.4-pro", strength: "max" },
    { label: "GPT-5.4 Thinking", modelName: "gpt-5.4-thinking", strength: "high" },
    { label: "GPT-5.4", modelName: "gpt-5.4", strength: "high" },
    { label: "GPT-5.4 mini", modelName: "gpt-5.4-mini", strength: "middle" },
    { label: "GPT-5.3 Codex", modelName: "gpt-5.3-codex", strength: "high" },
    { label: "GPT-5.2", modelName: "gpt-5.2", strength: "middle" },
    { label: "GPT-5.2 mini", modelName: "gpt-5.2-mini", strength: "low" }
  ],
  deepseek: [
    { label: "DeepSeek V4 Flash", modelName: "deepseek-v4-flash", strength: "low" },
    { label: "DeepSeek V4 Pro", modelName: "deepseek-v4-pro", strength: "high" }
  ],
  doubao: [
    { label: "Doubao-1.5-lite-32k", modelName: "doubao-1-5-lite-32k-250115", strength: "middle" },
    { label: "Doubao-1.5-pro-32k", modelName: "doubao-1-5-pro-32k-250115", strength: "high" },
    { label: "Doubao-Seed-Translation", modelName: "doubao-seed-translation-250915", strength: "middle" },
    { label: "Doubao-Seed-2.1-pro", modelName: "doubao-seed-2-1-pro-260628", strength: "max" },
    { label: "Doubao-Seed-Evolving", modelName: "doubao-seed-evolving", strength: "high" },
    { label: "Doubao-Seed-2.1-turbo", modelName: "doubao-seed-2-1-turbo-260628", strength: "middle" }
  ],
  zhipu: [
    { label: "GLM-5.2", modelName: "glm-5.2", strength: "max" }
  ],
  anthropic: [
    { label: "Claude Haiku 4.5", modelName: "claude-haiku-4-5", strength: "low" },
    { label: "Claude Haiku 4.6", modelName: "claude-haiku-4-6", strength: "low" },
    { label: "Claude Haiku 4.7", modelName: "claude-haiku-4-7", strength: "middle" },
    { label: "Claude Haiku 4.8", modelName: "claude-haiku-4-8", strength: "middle" },
    { label: "Claude Sonnet 4.5", modelName: "claude-sonnet-4-5", strength: "middle" },
    { label: "Claude Sonnet 4.6", modelName: "claude-sonnet-4-6", strength: "middle" },
    { label: "Claude Sonnet 4.7", modelName: "claude-sonnet-4-7", strength: "high" },
    { label: "Claude Sonnet 4.8", modelName: "claude-sonnet-4-8", strength: "high" },
    { label: "Claude Opus 4.5", modelName: "claude-opus-4-5", strength: "high" },
    { label: "Claude Opus 4.6", modelName: "claude-opus-4-6", strength: "high" },
    { label: "Claude Opus 4.7", modelName: "claude-opus-4-7", strength: "max" },
    { label: "Claude Opus 4.8", modelName: "claude-opus-4-8", strength: "max" },
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
  { label: "发散创意", value: 0.95 }
];

export const MAX_OUTPUT_LEVELS: readonly LevelOption[] = [
  { label: "简短回答", value: 800 },
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
      apiKey: sessionApiKey,
      requestMode: resolveDefaultRequestMode()
    };
  }

  try {
    const parsedConfig = JSON.parse(rawConfig) as Partial<StoredModelConfig>;
    const provider = isModelProviderType(parsedConfig.provider)
      ? parsedConfig.provider
      : DEFAULT_MODEL_CONFIG.provider;
    const presetId = normalizePresetId(parsedConfig.presetId, provider);
    const modelName = typeof parsedConfig.modelName === "string" && parsedConfig.modelName.trim()
      ? parsedConfig.modelName.trim()
      : getDefaultPresetForProvider(provider)?.modelName ?? DEFAULT_MODEL_CONFIG.modelName;

    return {
      provider,
      presetId,
      apiKey: sessionApiKey,
      baseUrl: normalizeBaseUrl(parsedConfig.baseUrl, provider),
      modelName,
      modelStrength: normalizeModelStrength(parsedConfig.modelStrength),
      temperature: normalizeTemperature(parsedConfig.temperature),
      maxOutputTokens: normalizeMaxOutputTokens(parsedConfig.maxOutputTokens),
      streamEnabled: provider === "openai-compatible" && Boolean(parsedConfig.streamEnabled),
      requestMode: normalizeRequestMode(parsedConfig.requestMode)
    };
  } catch {
    return {
      ...DEFAULT_MODEL_CONFIG,
      apiKey: sessionApiKey,
      requestMode: resolveDefaultRequestMode()
    };
  }
}

export function saveModelConfig(modelConfig: ModelConfig) {
  const provider = modelConfig.provider;
  const normalizedPresetId = normalizePresetId(modelConfig.presetId, provider);
  const storedConfig: StoredModelConfig = {
    provider,
    presetId: normalizedPresetId,
    baseUrl: normalizeBaseUrl(modelConfig.baseUrl, provider),
    modelName: modelConfig.modelName.trim(),
    modelStrength: normalizeModelStrength(modelConfig.modelStrength),
    temperature: normalizeTemperature(modelConfig.temperature),
    maxOutputTokens: normalizeMaxOutputTokens(modelConfig.maxOutputTokens),
    streamEnabled: provider === "openai-compatible" && modelConfig.streamEnabled,
    requestMode: normalizeRequestMode(modelConfig.requestMode)
  };

  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(storedConfig));
  if (modelConfig.apiKey.trim()) {
    window.sessionStorage.setItem(MODEL_API_KEY_STORAGE_KEY, modelConfig.apiKey.trim());
  } else {
    window.sessionStorage.removeItem(MODEL_API_KEY_STORAGE_KEY);
  }
}

export function getModelOptionsForConfig(config: Pick<ModelConfig, "presetId" | "provider">) {
  return MODEL_OPTIONS_BY_PRESET[resolvePresetIdForProvider(config.presetId, config.provider)] ?? [];
}

export function getModelOptionsForPreset(presetId: string) {
  return MODEL_OPTIONS_BY_PRESET[presetId] ?? [];
}

export function findModelStrengthForPreset(presetId: string, modelName: string) {
  return MODEL_OPTIONS_BY_PRESET[presetId]?.find((option) => option.modelName === modelName)?.strength;
}

export function findModelPresetById(presetId: string) {
  return MODEL_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export function findPresetByProvider(provider: ModelProviderType) {
  return MODEL_PRESETS.find((preset) => preset.provider === provider) ?? null;
}

export function findPresetIdForModelConfig(config: Pick<ModelConfig, "provider" | "presetId">) {
  return resolvePresetIdForProvider(config.presetId, config.provider);
}

function resolvePresetIdForProvider(presetId: string, provider: ModelProviderType) {
  const directMatch = MODEL_PRESETS.find((preset) => preset.id === presetId && preset.provider === provider);
  if (directMatch) {
    return directMatch.id;
  }

  return getDefaultPresetForProvider(provider)?.id ?? DEFAULT_MODEL_CONFIG.presetId;
}

function getDefaultPresetForProvider(provider: ModelProviderType) {
  return MODEL_PRESETS.find((preset) => preset.provider === provider) ?? null;
}

function normalizeBaseUrl(value: unknown, provider: ModelProviderType) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return getDefaultPresetForProvider(provider)?.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl;
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

function normalizeModelStrength(value: unknown): ModelStrength {
  if (value === "low" || value === "middle" || value === "high" || value === "max") {
    return value;
  }

  return DEFAULT_MODEL_CONFIG.modelStrength;
}

function normalizePresetId(value: unknown, provider: ModelProviderType) {
  if (typeof value === "string") {
    return resolvePresetIdForProvider(value, provider);
  }

  return getDefaultPresetForProvider(provider)?.id ?? DEFAULT_MODEL_CONFIG.presetId;
}

function isModelProviderType(value: unknown): value is ModelProviderType {
  return value === "openai-compatible" || value === "anthropic";
}

function normalizeRequestMode(value: unknown): ModelRequestMode {
  if (value === "development-proxy" || value === "production-proxy") {
    return value;
  }

  return resolveDefaultRequestMode();
}

function resolveDefaultRequestMode(): ModelRequestMode {
  return import.meta.env.DEV ? "development-proxy" : "production-proxy";
}
