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
  /** 左侧厂商快捷区：一句话讲清点预设会发生什么。 */
  presetExplainer: string;
  /** 预设列表为空时的空态兜底。 */
  presetEmpty: string;
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
  /** 唯一的连通按钮：检查连通并刷新模型下拉。 */
  verifyAndRefreshCatalog: string;
  /** 地址或密钥没填时的连通提示。 */
  catalogKeyMissing: string;
  modelCatalogLoading: string;
  modelCatalogLoaded: string;
  modelCatalogFallback: string;
  modelStrength: string;
  temperature: string;
  temperatureHint: string;
  maxOutput: string;
  maxOutputHint: string;
  streamOutput: string;
  streamOutputHint: string;
  sectionProvider: string;
  sectionGeneration: string;
  sectionMemory: string;
  sectionVoice: string;
  semanticSearch: string;
  semanticSearchHint: string;
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
  menuThinkingOn: string;
  menuThinkingOff: string;
  menuVoiceInputOn: string;
  menuVoiceInputOff: string;
  menuVoiceOutputOn: string;
  menuVoiceOutputOff: string;
  menuUploadFile: string;
  menuHistory: string;
  menuMemory: string;
  menuSettings: string;
  /** 设置模态顶部页签：安全状态（2026-08-24 信息架构调整：从操作栏迁入设置中心）。 */
  securityTab: string;
  /** 设置模态顶部页签：后台任务台账（调度任务 + 接管会话）。 */
  tasksTab: string;
};

export const SETTINGS_COPY: Record<SettingsLanguage, SettingsCopy> = {
  "zh-CN": {
    settings: "设置",
    model: "模型设置",
    voice: "语音",
    language: "语言",
    preset: "服务预设",
    presetGroup: "选一家服务商开始",
    presetPlaceholder: "选择官方模型服务",
    presetExplainer: "点一家服务商，右侧会自动填好它的服务地址和默认模型，你只需要粘贴密钥，再点一次连通检查即可用。切换服务商不会丢掉之前填过的内容。",
    presetEmpty: "暂时没有可选的服务商，请先保存当前配置。",
    provider: "服务类型",
    apiKey: "密钥",
    apiKeyHint: "去服务商官网申请的钥匙，只保存在本机，换服务商要重新填。",
    baseUrl: "服务地址",
    baseUrlHint: "一般不用改，选预设会自动填好；只有服务商另外给了你地址才需要手动改。",
    modelName: "用哪个模型",
    customModelName: "手动指定模型",
    customModelNameHint: "例如 glm-5.2，或豆包火山方舟上为你生成的专属模型编号",
    advancedModel: "下拉里没有想要的模型？",
    advancedModelHint: "只有下拉列表里找不到你的模型时才需要手动填写。",
    verifyAndRefreshCatalog: "检查连通并刷新模型",
    catalogKeyMissing: "请先填好服务地址和密钥，再检查连通。",
    modelCatalogLoading: "正在用你的密钥连接服务商…",
    modelCatalogLoaded: "连接成功，这个密钥可用 {count} 个模型，已刷新到下拉框。",
    modelCatalogFallback: "先用内置的常用模型顶着，不影响保存。",
    modelStrength: "模型档位",
    temperature: "回答风格",
    temperatureHint: "越往左越稳重，越往右越发散有创意",
    maxOutput: "单次回答长度",
    maxOutputHint: "一次回答最多写多长，写报告、代码时可以调大",
    streamOutput: "边想边显示",
    streamOutputHint: "打开后不用等整段写完，想到哪显示到哪。",
    sectionProvider: "服务商配置",
    sectionGeneration: "回答偏好",
    sectionMemory: "记忆",
    sectionVoice: "语音",
    semanticSearch: "更懂你的记忆搜索",
    semanticSearchHint: "打开后找过去的记忆更准确，第一次用会多花一点时间准备，失败会自动用回普通搜索。",
    strengthRuleTitle: "档位说明",
    strengthRuleText: "档位跟着你选的模型走，只帮你记住偏好，不会背着你换模型。",
    showSecret: "显示",
    hideSecret: "隐藏",
    syncOk: "已保存",
    syncDirty: "改动还没保存",
    doubaoAppId: "豆包应用编号",
    doubaoAppIdHint: "火山语音控制台里的应用编号，给语音听写用。",
    doubaoVoiceApiKey: "豆包语音口令",
    doubaoVoiceApiKeyHint: "火山语音控制台里的访问口令，给语音听写用，只保存在本机。",
    doubaoSpeakerId: "朗读声音",
    doubaoSpeakerIdHint: "豆包朗读的声音编号，不填就用默认女声，也可以去火山语音控制台换一个。",
    doubaoResourceId: "朗读资源编号",
    doubaoResourceIdHint: "一般不用填；只有你用的是自己复刻的声音，才需要到控制台复制对应的资源编号。",
    fishAudioApiKey: "FishAudio 密钥",
    fishAudioApiKeyHint: "FishAudio 朗读服务的钥匙，只保存在本机。",
    fishAudioVoiceId: "FishAudio 声音编号",
    fishAudioVoiceIdHint: "FishAudio 朗读必填的声音编号，先去官网声音列表里挑一个。",
    fishAudioModel: "FishAudio 朗读模型",
    fishAudioModelHint: "默认即可，只有官网文档明确让你改时再改。",
    minimaxVoiceApiKey: "MiniMax 语音密钥",
    minimaxVoiceApiKeyHint: "MiniMax 朗读服务的钥匙，只保存在本机。",
    minimaxGroupId: "MiniMax 分组编号",
    minimaxGroupIdHint: "你的 MiniMax 账号如果要求填分组编号就填在这里，没有就空着。",
    cancel: "取消",
    save: "保存配置",
    closeSettings: "关闭设置",
    menuThinkingOn: "深度思考已开启",
    menuThinkingOff: "深度思考已关闭",
    menuVoiceInputOn: "语音输入已开启",
    menuVoiceInputOff: "语音输入已关闭",
    menuVoiceOutputOn: "语音播报已开启",
    menuVoiceOutputOff: "语音播报已关闭",
    menuUploadFile: "上传文件",
    menuHistory: "历史记录",
    menuMemory: "记忆面板",
    menuSettings: "设置",
    securityTab: "安全状态",
    tasksTab: "任务台账"
  },
  "en-US": {
    settings: "Settings",
    model: "Model Preferences",
    voice: "Voice",
    language: "Language",
    preset: "Preset",
    presetGroup: "Pick a provider to start",
    presetPlaceholder: "Select an official provider",
    presetExplainer: "Pick a provider and the address and default model on the right fill in automatically. Just paste your key, then run the connection check. Switching providers keeps what you already entered.",
    presetEmpty: "No providers available right now. Please save your current setup first.",
    provider: "Service type",
    apiKey: "API key",
    apiKeyHint: "The key from your provider's website. Stored on this device only; each provider needs its own key.",
    baseUrl: "Service address",
    baseUrlHint: "Usually no need to touch this — picking a preset fills it in. Change it only if your provider gave you a different address.",
    modelName: "Model",
    customModelName: "Specify a model manually",
    customModelNameHint: "For example glm-5.2, or your dedicated model ID from the Doubao Ark console",
    advancedModel: "Model not in the list?",
    advancedModelHint: "Only type here when the dropdown doesn't have your model.",
    verifyAndRefreshCatalog: "Check connection & refresh models",
    catalogKeyMissing: "Fill in the service address and key first, then check the connection.",
    modelCatalogLoading: "Connecting with your key…",
    modelCatalogLoaded: "Connected — this key can use {count} models, now in the dropdown.",
    modelCatalogFallback: "Showing the built-in popular models for now; saving still works.",
    modelStrength: "Model tier",
    temperature: "Response style",
    temperatureHint: "Left is steadier, right is more creative",
    maxOutput: "Reply length",
    maxOutputHint: "How long a single reply can be; turn it up for reports or code",
    streamOutput: "Show while thinking",
    streamOutputHint: "When on, the reply appears piece by piece instead of all at once.",
    sectionProvider: "Provider setup",
    sectionGeneration: "Reply preferences",
    sectionMemory: "Memory",
    sectionVoice: "Voice",
    semanticSearch: "Smarter memory search",
    semanticSearchHint: "Finds past memories more accurately. The first use takes a little extra setup time, and falls back to normal search if anything fails.",
    strengthRuleTitle: "About tiers",
    strengthRuleText: "The tier follows the model you pick. It only remembers your preference and never swaps your model behind your back.",
    showSecret: "Show",
    hideSecret: "Hide",
    syncOk: "Saved",
    syncDirty: "Unsaved changes",
    doubaoAppId: "Doubao app ID",
    doubaoAppIdHint: "The app ID from the Volcengine voice console, used for voice dictation.",
    doubaoVoiceApiKey: "Doubao voice token",
    doubaoVoiceApiKeyHint: "The access token from the Volcengine voice console, used for voice dictation. Stored on this device only.",
    doubaoSpeakerId: "Reading voice",
    doubaoSpeakerIdHint: "The voice for read-aloud. Leave empty for the default female voice, or pick another from the Volcengine voice console.",
    doubaoResourceId: "Reading resource ID",
    doubaoResourceIdHint: "Usually leave empty. Only needed when you use your own cloned voice — copy its resource ID from the console.",
    fishAudioApiKey: "FishAudio API key",
    fishAudioApiKeyHint: "The key for FishAudio read-aloud. Stored on this device only.",
    fishAudioVoiceId: "FishAudio voice ID",
    fishAudioVoiceIdHint: "Required voice ID for FishAudio read-aloud. Pick one from the official voice list first.",
    fishAudioModel: "FishAudio reading model",
    fishAudioModelHint: "Leave the default unless the official docs tell you to change it.",
    minimaxVoiceApiKey: "MiniMax voice API key",
    minimaxVoiceApiKeyHint: "The key for MiniMax read-aloud. Stored on this device only.",
    minimaxGroupId: "MiniMax group ID",
    minimaxGroupIdHint: "Fill this only if your MiniMax account requires a group ID.",
    cancel: "Cancel",
    save: "Save settings",
    closeSettings: "Close settings",
    menuThinkingOn: "Thinking on",
    menuThinkingOff: "Thinking off",
    menuVoiceInputOn: "Voice input on",
    menuVoiceInputOff: "Voice input off",
    menuVoiceOutputOn: "Voice output on",
    menuVoiceOutputOff: "Voice output off",
    menuUploadFile: "Upload file",
    menuHistory: "History",
    menuMemory: "Memory",
    menuSettings: "Settings",
    securityTab: "Security",
    tasksTab: "Tasks"
  }
};

export function loadSettingsLanguage(): SettingsLanguage {
  const storedLanguage = window.localStorage.getItem(SETTINGS_LANGUAGE_STORAGE_KEY);
  return isSettingsLanguage(storedLanguage) ? storedLanguage : "zh-CN";
}

/** 语言变更事件：设置面板切换语言后，选项栏等同页组件据此实时刷新文案。 */
export const SETTINGS_LANGUAGE_CHANGE_EVENT = "void:settings-language-changed";

export function saveSettingsLanguage(language: SettingsLanguage) {
  window.localStorage.setItem(SETTINGS_LANGUAGE_STORAGE_KEY, language);
  window.dispatchEvent(new CustomEvent(SETTINGS_LANGUAGE_CHANGE_EVENT, { detail: language }));
}

function isSettingsLanguage(value: unknown): value is SettingsLanguage {
  return value === "zh-CN" || value === "en-US";
}
