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
  requestMode: string;
  developmentProxy: string;
  browserDirect: string;
  temperature: string;
  maxOutput: string;
  streamOutput: string;
  cancel: string;
  save: string;
  closeSettings: string;
  requestModeNote: string;
};

export const SETTINGS_COPY: Record<SettingsLanguage, SettingsCopy> = {
  "zh-CN": {
    settings: "设置",
    model: "模型",
    language: "语言",
    preset: "服务预设",
    presetPlaceholder: "选择一个模型服务预设",
    provider: "请求格式",
    apiKey: "API Key",
    apiKeyHint: "仅当前会话保存",
    baseUrl: "Base URL",
    modelName: "模型名称",
    requestMode: "请求方式",
    developmentProxy: "开发代理",
    browserDirect: "浏览器直连",
    temperature: "温度",
    maxOutput: "最大输出",
    streamOutput: "流式输出",
    cancel: "取消",
    save: "保存",
    closeSettings: "关闭设置",
    requestModeNote: "开发代理只用于本地验证；生产 Web 或 Tauri 不能长期依赖它。"
  },
  "en-US": {
    settings: "Settings",
    model: "Model",
    language: "Language",
    preset: "Preset",
    presetPlaceholder: "Select a provider preset",
    provider: "Provider",
    apiKey: "API Key",
    apiKeyHint: "Session only",
    baseUrl: "Base URL",
    modelName: "Model Name",
    requestMode: "Request Mode",
    developmentProxy: "Development proxy",
    browserDirect: "Browser direct",
    temperature: "Temperature",
    maxOutput: "Max Output",
    streamOutput: "Stream output",
    cancel: "Cancel",
    save: "Save",
    closeSettings: "Close settings",
    requestModeNote: "The development proxy is only for local verification. Production Web or Tauri needs a formal proxy."
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
