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
  baseUrlHint: string;
  modelName: string;
  customModelName: string;
  customModelNameHint: string;
  advancedModel: string;
  advancedModelHint: string;
  modelStrength: string;
  temperature: string;
  temperatureHint: string;
  maxOutput: string;
  maxOutputHint: string;
  requestMode: string;
  requestModeHint: string;
  requestModeDevelopment: string;
  requestModeProduction: string;
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
    baseUrlHint: "修改地址不会改变当前厂商系列，普通情况下优先通过预设和模型下拉完成配置。",
    modelName: "模型选择",
    customModelName: "自定义模型名",
    customModelNameHint: "例如 glm-5.2、doubao-1-5-lite-32k，或豆包 Ark Endpoint ID",
    advancedModel: "高级模型入口",
    advancedModelHint: "仅在使用中转站、私有 Endpoint 或下拉列表里没有目标模型时填写。",
    modelStrength: "模型强度",
    temperature: "回应风格",
    temperatureHint: "控制回复的稳定程度和发散程度",
    maxOutput: "输出规模",
    maxOutputHint: "控制单次回复可生成的内容量",
    requestMode: "请求链路",
    requestModeHint: "开发环境使用本地代理；生产环境必须使用正式代理，避免浏览器暴露第三方密钥。",
    requestModeDevelopment: "开发代理",
    requestModeProduction: "正式代理",
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
    baseUrlHint: "Changing the URL keeps the current provider family. Prefer presets and the model dropdown for normal setup.",
    modelName: "Model",
    customModelName: "Custom model",
    customModelNameHint: "For example glm-5.2, doubao-1-5-lite-32k, or a Doubao Ark endpoint ID",
    advancedModel: "Advanced model",
    advancedModelHint: "Use this only for relays, private endpoints, or models missing from the list.",
    modelStrength: "Model strength",
    temperature: "Response style",
    temperatureHint: "Controls how stable or exploratory the response feels",
    maxOutput: "Output scale",
    maxOutputHint: "Controls how much content a single response can generate",
    requestMode: "Request route",
    requestModeHint: "Development uses a local proxy. Production must use a formal server-side proxy so browser clients do not expose third-party API keys.",
    requestModeDevelopment: "Development proxy",
    requestModeProduction: "Formal proxy",
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
