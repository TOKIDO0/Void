import { getSecret, setSecret } from "../../lib/runtime/secretStore";

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
  thinkingModeEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
  streamEnabled: boolean;
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

/** 与厂商无关的全局生成参数。 */
type GenerationConfig = {
  thinkingModeEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
  streamEnabled: boolean;
};

/** 单个厂商（preset）独立保存的模型选择，切换厂商时互不覆盖。 */
type ProviderSlot = {
  baseUrl: string;
  modelName: string;
  modelStrength: ModelStrength;
};

/** V2 分仓存储：全局选择 + 每厂商一份配置 + 全局生成参数。 */
type StoredModelConfigV2 = {
  version: 2;
  activePresetId: string;
  slots: Record<string, ProviderSlot>;
  generation: GenerationConfig;
};

/** V1 旧扁平存储（迁移用）。 */
type StoredModelConfigV1 = Partial<Omit<ModelConfig, "apiKey">>;

const MODEL_CONFIG_STORAGE_KEY = "void.modelConfig";
/** 旧版单一 API Key（迁移后清理）。 */
const LEGACY_MODEL_API_KEY_STORAGE_KEY = "void.modelApiKey";

/** 每厂商独立的 API Key secret 键名。 */
function providerApiKeyStorageKey(presetId: string) {
  return `void.modelApiKey.${presetId}`;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: "openai-compatible",
  presetId: "openai",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1",
  modelName: "gpt-5.5",
  modelStrength: "middle",
  thinkingModeEnabled: false,
  temperature: 0.7,
  maxOutputTokens: 2000,
  streamEnabled: false
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
    id: "ollama",
    label: "Ollama (本地)",
    provider: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    modelName: "llama3.1"
  },
  {
    id: "minimax",
    label: "MiniMax",
    provider: "openai-compatible",
    baseUrl: "https://api.minimax.chat/v1",
    modelName: "abab6.5s-chat"
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
  ollama: [
    { label: "Llama 3.1 8B", modelName: "llama3.1", strength: "middle" },
    { label: "Qwen2.5 7B", modelName: "qwen2.5:7b", strength: "middle" },
    { label: "Mistral 7B", modelName: "mistral", strength: "middle" },
    { label: "Gemma 2 9B", modelName: "gemma2:9b", strength: "middle" }
  ],
  minimax: [
    { label: "abab6.5s", modelName: "abab6.5s-chat", strength: "middle" },
    { label: "abab6.5g", modelName: "abab6.5g-chat", strength: "high" }
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
  const store = readStore();
  return composeModelConfig(store, store.activePresetId);
}

export function saveModelConfig(modelConfig: ModelConfig) {
  const provider = modelConfig.provider;
  const presetId = normalizePresetId(modelConfig.presetId, provider);
  const store = readStore();

  // 只写入当前 preset 自己的仓位，其它厂商的 baseUrl/模型/Key 原样保留。
  store.activePresetId = presetId;
  store.slots[presetId] = {
    baseUrl: normalizeBaseUrl(modelConfig.baseUrl, provider),
    modelName: modelConfig.modelName.trim() || fallbackModelName(provider),
    modelStrength: normalizeModelStrength(modelConfig.modelStrength)
  };
  store.generation = {
    thinkingModeEnabled: Boolean(modelConfig.thinkingModeEnabled),
    temperature: normalizeTemperature(modelConfig.temperature),
    maxOutputTokens: normalizeMaxOutputTokens(modelConfig.maxOutputTokens),
    streamEnabled: provider === "openai-compatible" && modelConfig.streamEnabled
  };

  writeStore(store);
  setSecret(providerApiKeyStorageKey(presetId), modelConfig.apiKey);
}

/** 由分仓存储 + 指定 presetId 组装出上层使用的扁平 ModelConfig。 */
function composeModelConfig(store: StoredModelConfigV2, presetId: string): ModelConfig {
  const normalizedPresetId = normalizePresetId(presetId, providerOfPreset(presetId));
  const provider = providerOfPreset(normalizedPresetId);
  const slot = store.slots[normalizedPresetId] ?? defaultSlotForPreset(normalizedPresetId);
  const apiKey = getSecret(providerApiKeyStorageKey(normalizedPresetId));

  return {
    provider,
    presetId: normalizedPresetId,
    apiKey,
    baseUrl: normalizeBaseUrl(slot.baseUrl, provider),
    modelName: slot.modelName.trim() || fallbackModelName(provider),
    modelStrength: normalizeModelStrength(slot.modelStrength),
    thinkingModeEnabled: store.generation.thinkingModeEnabled,
    temperature: store.generation.temperature,
    maxOutputTokens: store.generation.maxOutputTokens,
    streamEnabled: provider === "openai-compatible" && store.generation.streamEnabled
  };
}

/** 读取分仓存储；无存储或旧版则迁移/初始化，且顺带清理已废弃字段。 */
function readStore(): StoredModelConfigV2 {
  const rawConfig = window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY);
  if (!rawConfig) {
    return createDefaultStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return createDefaultStore();
  }

  if (isStoredModelConfigV2(parsed)) {
    return normalizeStore(parsed);
  }

  // V1 → V2 迁移：旧扁平配置塞进对应 preset 仓位，旧单一 Key 迁到该 preset 的 Key 键。
  return migrateFromV1(parsed as StoredModelConfigV1);
}

function writeStore(store: StoredModelConfigV2) {
  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify(store));
}

function createDefaultStore(): StoredModelConfigV2 {
  return {
    version: 2,
    activePresetId: DEFAULT_MODEL_CONFIG.presetId,
    slots: {},
    generation: {
      thinkingModeEnabled: DEFAULT_MODEL_CONFIG.thinkingModeEnabled,
      temperature: DEFAULT_MODEL_CONFIG.temperature,
      maxOutputTokens: DEFAULT_MODEL_CONFIG.maxOutputTokens,
      streamEnabled: DEFAULT_MODEL_CONFIG.streamEnabled
    }
  };
}

function migrateFromV1(v1: StoredModelConfigV1): StoredModelConfigV2 {
  const provider = isModelProviderType(v1.provider) ? v1.provider : DEFAULT_MODEL_CONFIG.provider;
  const presetId = normalizePresetId(v1.presetId, provider);
  const store = createDefaultStore();

  store.activePresetId = presetId;
  store.slots[presetId] = {
    baseUrl: normalizeBaseUrl(v1.baseUrl, provider),
    modelName: typeof v1.modelName === "string" && v1.modelName.trim()
      ? v1.modelName.trim()
      : fallbackModelName(provider),
    modelStrength: normalizeModelStrength(v1.modelStrength)
  };
  store.generation = {
    thinkingModeEnabled: Boolean(v1.thinkingModeEnabled),
    temperature: normalizeTemperature(v1.temperature),
    maxOutputTokens: normalizeMaxOutputTokens(v1.maxOutputTokens),
    streamEnabled: provider === "openai-compatible" && Boolean(v1.streamEnabled)
  };

  // 旧单一 API Key 迁移到当前 preset 的 Key 位，然后清除旧键（含已废弃的 requestMode 字段随整份重写丢弃）。
  const legacyApiKey = getSecret(LEGACY_MODEL_API_KEY_STORAGE_KEY);
  if (legacyApiKey) {
    setSecret(providerApiKeyStorageKey(presetId), legacyApiKey);
    setSecret(LEGACY_MODEL_API_KEY_STORAGE_KEY, "");
  }

  writeStore(store);
  return store;
}

function normalizeStore(store: StoredModelConfigV2): StoredModelConfigV2 {
  const activePresetId = normalizePresetId(store.activePresetId, providerOfPreset(store.activePresetId));
  const slots: Record<string, ProviderSlot> = {};
  for (const [presetId, slot] of Object.entries(store.slots ?? {})) {
    if (!MODEL_PRESETS.some((preset) => preset.id === presetId)) {
      continue;
    }
    const provider = providerOfPreset(presetId);
    slots[presetId] = {
      baseUrl: normalizeBaseUrl(slot?.baseUrl, provider),
      modelName: typeof slot?.modelName === "string" && slot.modelName.trim()
        ? slot.modelName.trim()
        : fallbackModelName(provider),
      modelStrength: normalizeModelStrength(slot?.modelStrength)
    };
  }

  return {
    version: 2,
    activePresetId,
    slots,
    generation: {
      thinkingModeEnabled: Boolean(store.generation?.thinkingModeEnabled),
      temperature: normalizeTemperature(store.generation?.temperature),
      maxOutputTokens: normalizeMaxOutputTokens(store.generation?.maxOutputTokens),
      streamEnabled: Boolean(store.generation?.streamEnabled)
    }
  };
}

function isStoredModelConfigV2(value: unknown): value is StoredModelConfigV2 {
  return Boolean(
    value
    && typeof value === "object"
    && (value as { version?: unknown }).version === 2
  );
}

function providerOfPreset(presetId: string): ModelProviderType {
  return MODEL_PRESETS.find((preset) => preset.id === presetId)?.provider ?? DEFAULT_MODEL_CONFIG.provider;
}

function defaultSlotForPreset(presetId: string): ProviderSlot {
  const preset = findModelPresetById(presetId) ?? getDefaultPresetForProvider(DEFAULT_MODEL_CONFIG.provider);
  return {
    baseUrl: preset?.baseUrl ?? DEFAULT_MODEL_CONFIG.baseUrl,
    modelName: preset?.modelName ?? DEFAULT_MODEL_CONFIG.modelName,
    modelStrength: findModelStrengthForPreset(presetId, preset?.modelName ?? "") ?? DEFAULT_MODEL_CONFIG.modelStrength
  };
}

function fallbackModelName(provider: ModelProviderType) {
  return getDefaultPresetForProvider(provider)?.modelName ?? DEFAULT_MODEL_CONFIG.modelName;
}

export function updateThinkingModeEnabled(thinkingModeEnabled: boolean) {
  const currentConfig = loadModelConfig();
  saveModelConfig({
    ...currentConfig,
    thinkingModeEnabled
  });
}

/**
 * 读取指定厂商（preset）已保存的仓位配置，用于设置面板切换厂商时恢复该厂商上次的选择，
 * 不影响当前 activePresetId（切换尚未提交保存前不改全局状态）。
 */
export function loadModelConfigForPreset(presetId: string): ModelConfig {
  const store = readStore();
  return composeModelConfig(store, presetId);
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
