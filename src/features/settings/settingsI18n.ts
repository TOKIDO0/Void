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
    apiKeyHint: "仅当前会话保存",
    baseUrl: "Base URL",
    modelName: "模型选择",
    modelStrength: "模型强度",
    temperature: "回应风格",
    temperatureHint: "控制回复的稳定程度和发散程度",
    maxOutput: "输出规模",
    maxOutputHint: "控制单次回复可生成的内容量",
    streamOutput: "流式输出",
    streamOutputHint: "开启后模型会边生成边显示回复，体感更快。当前 MVP 先保留配置，真实流式链路后续接入。",
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
    apiKeyHint: "Session only",
    baseUrl: "Base URL",
    modelName: "Model",
    modelStrength: "Model strength",
    temperature: "Response style",
    temperatureHint: "Controls how stable or exploratory the response feels",
    maxOutput: "Output scale",
    maxOutputHint: "Controls how much content a single response can generate",
    streamOutput: "Stream output",
    streamOutputHint: "When enabled, responses can appear while the model is still generating. The MVP stores this setting before the real streaming path is connected.",
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
