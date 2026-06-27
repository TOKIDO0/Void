export type SettingsLanguage = "zh-CN" | "en-US";

const SETTINGS_LANGUAGE_STORAGE_KEY = "void.settingsLanguage";

type SettingsCopy = {
  settings: string;
  model: string;
  language: string;
  preset: string;
  presetPlaceholder: string;
  provider: string;
  apiKey: string;
  apiKeyHint: string;
  baseUrl: string;
  modelName: string;
  customModelName: string;
  customModelNameHint: string;
  modelStrength: string;
  temperature: string;
  temperatureHint: string;
  maxOutput: string;
  maxOutputHint: string;
  streamOutput: string;
  streamOutputHint: string;
  cancel: string;
  save: string;
  closeSettings: string;
};

export const SETTINGS_COPY: Record<SettingsLanguage, SettingsCopy> = {
  "zh-CN": {
    settings: "设置",
    model: "模型",
    language: "语言",
    preset: "服务预设",
    presetPlaceholder: "选择官方模型服务",
    provider: "接口格式",
    apiKey: "API Key",
    apiKeyHint: "仅当前会话保存；豆包请填 API Key Secret",
    baseUrl: "Base URL",
    modelName: "模型选择",
    customModelName: "自定义模型名",
    customModelNameHint: "例如 glm-5.2、doubao-1-5-lite-32k 或豆包 Ark Endpoint ID",
    modelStrength: "模型强度",
    temperature: "回应风格",
    temperatureHint: "控制回复的稳定程度和发散程度",
    maxOutput: "输出规模",
    maxOutputHint: "控制单次回复可生成的内容量",
    streamOutput: "流式输出",
    streamOutputHint: "开启后不会等整段回复写完才显示，而是模型生成一点就显示一点。长回复会更快看到开头。",
    cancel: "取消",
    save: "保存",
    closeSettings: "关闭设置"
  },
  "en-US": {
    settings: "Settings",
    model: "Model",
    language: "Language",
    preset: "Preset",
    presetPlaceholder: "Select an official provider",
    provider: "API format",
    apiKey: "API Key",
    apiKeyHint: "Session only; use Ark API Key Secret for Doubao",
    baseUrl: "Base URL",
    modelName: "Model",
    customModelName: "Custom model",
    customModelNameHint: "For example glm-5.2, doubao-1-5-lite-32k, or a Doubao Ark endpoint ID",
    modelStrength: "Model strength",
    temperature: "Response style",
    temperatureHint: "Controls how stable or exploratory the response feels",
    maxOutput: "Output scale",
    maxOutputHint: "Controls how much content a single response can generate",
    streamOutput: "Stream output",
    streamOutputHint: "When enabled, the reply appears piece by piece while the model is still generating instead of waiting for the full answer.",
    cancel: "Cancel",
    save: "Save",
    closeSettings: "Close settings"
  }
};

export function loadSettingsLanguage(): SettingsLanguage {
  const storedLanguage = window.localStorage.getItem(SETTINGS_LANGUAGE_STORAGE_KEY);
  return isSettingsLanguage(storedLanguage) ? storedLanguage : "zh-CN";
}

export function saveSettingsLanguage(language: SettingsLanguage) {
  window.localStorage.setItem(SETTINGS_LANGUAGE_STORAGE_KEY, language);
}

function isSettingsLanguage(value: unknown): value is SettingsLanguage {
  return value === "zh-CN" || value === "en-US";
}
