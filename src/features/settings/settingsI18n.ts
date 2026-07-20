export type SettingsLanguage = "zh-CN" | "en-US";

const SETTINGS_LANGUAGE_STORAGE_KEY = "void.settingsLanguage";

type SettingsCopy = {
  settings: string;
  model: string;
  voice: string;
  language: string;
  preset: string;
  presetGroup: string;
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
  sectionProvider: string;
  sectionGeneration: string;
  sectionVoice: string;
  strengthRuleTitle: string;
  strengthRuleText: string;
  showSecret: string;
  hideSecret: string;
  syncOk: string;
  syncDirty: string;
  doubaoAppId: string;
  doubaoAppIdHint: string;
  doubaoVoiceApiKey: string;
  doubaoVoiceApiKeyHint: string;
  doubaoSpeakerId: string;
  doubaoSpeakerIdHint: string;
  doubaoResourceId: string;
  doubaoResourceIdHint: string;
  fishAudioApiKey: string;
  fishAudioApiKeyHint: string;
  fishAudioVoiceId: string;
  fishAudioVoiceIdHint: string;
  fishAudioModel: string;
  fishAudioModelHint: string;
  minimaxVoiceApiKey: string;
  minimaxVoiceApiKeyHint: string;
  minimaxGroupId: string;
  minimaxGroupIdHint: string;
  cancel: string;
  save: string;
  closeSettings: string;
};

export const SETTINGS_COPY: Record<SettingsLanguage, SettingsCopy> = {
  "zh-CN": {
    settings: "设置",
    model: "模型设置",
    voice: "语音",
    language: "语言",
    preset: "服务预设",
    presetGroup: "厂商快捷预设",
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
    streamOutputHint: "开启后不会等整段回复写完才显示，而是模型生成一点就显示一点。",
    sectionProvider: "01 / 服务商配置",
    sectionGeneration: "02 / 生成参数",
    sectionVoice: "03 / 语音",
    strengthRuleTitle: "关于模型强度",
    strengthRuleText: "模型强度与下拉中的模型档位对应，不会在后台偷偷替换你当前选中的模型名称。",
    showSecret: "显示",
    hideSecret: "隐藏",
    syncOk: "配置已同步",
    syncDirty: "有未保存修改",
    doubaoAppId: "Doubao App ID",
    doubaoAppIdHint: "火山语音控制台的 APP ID，用于 Doubao 流式语音识别鉴权。",
    doubaoVoiceApiKey: "Doubao Access Token",
    doubaoVoiceApiKeyHint: "火山语音控制台的 Access Token，用于 Doubao 流式语音识别；仅当前会话保存。",
    doubaoSpeakerId: "Doubao Speaker ID",
    doubaoSpeakerIdHint: "托管豆包 TTS 音色 ID。可留空使用默认女声；也可从火山语音控制台音色库替换。",
    doubaoResourceId: "Doubao Resource ID",
    doubaoResourceIdHint: "留空时默认使用 seed-tts-2.0。普通豆包官方音色优先用 seed-tts-2.0；只有复刻音色再使用 seed-icl-2.0，不要填写 ASR 资源 ID。",
    fishAudioApiKey: "FishAudio API Key",
    fishAudioApiKeyHint: "用于 FishAudio / Kitta Audio TTS；仅当前会话保存。",
    fishAudioVoiceId: "FishAudio Voice ID",
    fishAudioVoiceIdHint: "FishAudio 同步 TTS 必填音色 ID，可先从官方音色列表接口获取。",
    fishAudioModel: "FishAudio Model",
    fishAudioModelHint: "默认使用 s2-pro。仅在 FishAudio 官方 API 文档明确要求时再修改。",
    minimaxVoiceApiKey: "MiniMax 语音 API Key",
    minimaxVoiceApiKeyHint: "用于 MiniMax TTS；仅当前会话保存。",
    minimaxGroupId: "MiniMax Group ID",
    minimaxGroupIdHint: "如果你的 MiniMax TTS 调用需要 Group ID，请填在这里；没有则可留空。",
    cancel: "取消",
    save: "保存配置",
    closeSettings: "关闭设置"
  },
  "en-US": {
    settings: "Settings",
    model: "Model Preferences",
    voice: "Voice",
    language: "Language",
    preset: "Preset",
    presetGroup: "Quick Presets",
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
    streamOutputHint: "When enabled, the reply appears piece by piece while the model is still generating.",
    sectionProvider: "01 / Provider",
    sectionGeneration: "02 / Generation",
    sectionVoice: "03 / Voice",
    strengthRuleTitle: "About model strength",
    strengthRuleText: "Strength maps to the selected model tier and will not silently replace your current model name.",
    showSecret: "Show",
    hideSecret: "Hide",
    syncOk: "Preferences synced",
    syncDirty: "Unsaved changes",
    doubaoAppId: "Doubao App ID",
    doubaoAppIdHint: "The APP ID from the Volcengine voice console, used for Doubao streaming STT authentication.",
    doubaoVoiceApiKey: "Doubao access token",
    doubaoVoiceApiKeyHint: "The access token from the Volcengine voice console, used for Doubao streaming STT. Stored for the current session only.",
    doubaoSpeakerId: "Doubao speaker ID",
    doubaoSpeakerIdHint: "Managed Doubao TTS speaker ID. Leave empty to use the default female voice, or replace it from the Volcengine voice console.",
    doubaoResourceId: "Doubao resource ID",
    doubaoResourceIdHint: "Leave blank to use seed-tts-2.0. Use seed-tts-2.0 for normal Doubao voices, and seed-icl-2.0 only for cloned voices. Do not enter an ASR resource ID.",
    fishAudioApiKey: "FishAudio API key",
    fishAudioApiKeyHint: "Used for FishAudio / Kitta Audio TTS. Stored for the current session only.",
    fishAudioVoiceId: "FishAudio voice ID",
    fishAudioVoiceIdHint: "Required voice ID for FishAudio sync TTS. Fetch it from the official voices endpoint.",
    fishAudioModel: "FishAudio model",
    fishAudioModelHint: "Defaults to s2-pro. Change it only if the official Fish Audio API docs require a different model.",
    minimaxVoiceApiKey: "MiniMax voice API key",
    minimaxVoiceApiKeyHint: "Used for MiniMax TTS. Stored for the current session only.",
    minimaxGroupId: "MiniMax group ID",
    minimaxGroupIdHint: "Fill this only if your MiniMax TTS account requires a Group ID.",
    cancel: "Cancel",
    save: "Save settings",
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
