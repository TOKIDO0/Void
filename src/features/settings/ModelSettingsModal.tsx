import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  MAX_OUTPUT_LEVELS,
  MODEL_PRESETS,
  MODEL_STRENGTH_LABELS,
  TEMPERATURE_LEVELS,
  getModelOptionsForPreset,
  findModelPresetById,
  findPresetByProvider,
  findPresetIdForModelConfig,
  loadModelConfig,
  loadModelConfigForPreset,
  saveModelConfig,
  type LevelOption,
  type ModelConfig,
  type ModelOption,
  type ModelProviderType,
  type ModelStrength
} from "./modelConfig";
import { DarkSelect } from "./DarkSelect";
import { fetchModelCatalog } from "./modelCatalogFetcher";
import {
  SETTINGS_COPY,
  loadSettingsLanguage,
  saveSettingsLanguage,
  type SettingsLanguage
} from "./settingsI18n";
import { isSemanticSearchEnabled, setSemanticSearchEnabled } from "../memory/memorySemanticConfig";
import { loadVoiceRuntimeConfig, saveVoiceRuntimeConfig } from "../voice/voiceRuntimeConfig";
import { SecurityStatusContent } from "../agent/security/SecurityStatusContent";
import { TasksContent } from "../agent/scheduler/TasksContent";
import { isHighPermissionMode, setHighPermissionMode } from "./highPermissionMode";
import { SETTINGS_COPY as SHARED_SETTINGS_COPY } from "./settingsI18n";

/** 单厂商模型列表拉取状态。 */
type CatalogStatus = "idle" | "loading" | "error" | "ready";

/** 设置模态顶部页签：模型设置（默认）/ 安全状态 / 高级等系统级不常用功能（2026-08-24 信息架构调整）。 */
export type SettingsTab = "model" | "security" | "tasks" | "advanced";

type ModelSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时定位的页签；缺省 "model"。仅作为打开瞬间的初值，之后由用户点击切换。 */
  initialTab?: SettingsTab;
};

const MODEL_STRENGTH_ORDER: ModelStrength[] = ["low", "middle", "high", "max"];

export function ModelSettingsModal({ isOpen, onClose, initialTab = "model" }: ModelSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("model");
  const [highPermissionEnabled, setHighPermissionEnabled] = useState(() => isHighPermissionMode());
  const [showHighPermissionConfirm, setShowHighPermissionConfirm] = useState(false);
  // AL 开机自启：默认关；本机 OS 登录项，打开设置即读一次真实状态。
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartLoaded, setAutostartLoaded] = useState(false);
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [voiceRuntimeConfig, setVoiceRuntimeConfig] = useState(() => loadVoiceRuntimeConfig());
  const [semanticSearchDraft, setSemanticSearchDraft] = useState(() => isSemanticSearchEnabled());
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [selectedPresetId, setSelectedPresetId] = useState(() => findPresetId(loadModelConfig()));
  const [isAdvancedModelOpen, setIsAdvancedModelOpen] = useState(false);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  // 自动拉取的模型列表（按 presetId 缓存），与内置列表合并展示。
  const [fetchedModelsByPreset, setFetchedModelsByPreset] = useState<Record<string, ModelOption[]>>({});
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus>("idle");
  const [catalogMessage, setCatalogMessage] = useState("");
  const [testConnectionStatus, setTestConnectionStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [testConnectionMessage, setTestConnectionMessage] = useState("");

  const copy = SETTINGS_COPY[language];
  // 优先展示自动拉取的模型；拉取失败或未拉取时回退内置列表，保证下拉框不空白。
  const modelOptions = useMemo(() => {
    const fetched = fetchedModelsByPreset[selectedPresetId];
    if (fetched && fetched.length) {
      return fetched;
    }
    return getModelOptionsForPreset(selectedPresetId);
  }, [fetchedModelsByPreset, selectedPresetId]);
  const availableStrengths = useMemo(() => MODEL_STRENGTH_ORDER, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const storedConfig = loadModelConfig();
    const storedVoiceRuntimeConfig = loadVoiceRuntimeConfig();
    const storedSemanticSearchEnabled = isSemanticSearchEnabled();
    const storedPresetId = findPresetId(storedConfig);
    const storedModelOptions = getModelOptionsForPreset(storedPresetId);

    setDraftConfig(storedConfig);
    setVoiceRuntimeConfig(storedVoiceRuntimeConfig);
    setSemanticSearchDraft(storedSemanticSearchEnabled);
    setSelectedPresetId(storedPresetId);
    setIsAdvancedModelOpen(
      !storedModelOptions.some((option: { modelName: string }) => option.modelName === storedConfig.modelName)
    );
    setIsApiKeyVisible(false);
    setIsDirty(false);
    setActiveTab(initialTab);
    setHighPermissionEnabled(isHighPermissionMode());
    setShowHighPermissionConfirm(false);
  }, [isOpen, initialTab]);

  // AL 开机自启：打开设置即读一次 OS 真实状态；失败（纯 Web 预览）保持关闭态。
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    let cancelled = false;
    setAutostartLoaded(false);
    void import("@tauri-apps/plugin-autostart")
      .then(async ({ isEnabled }) => {
        try {
          const enabled = await isEnabled();
          if (!cancelled) {
            setAutostartEnabled(enabled);
            setAutostartLoaded(true);
          }
        } catch {
          if (!cancelled) {
            setAutostartLoaded(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAutostartLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleAutostartToggle = useCallback(async (next: boolean) => {
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (next) {
        await enable();
      } else {
        await disable();
      }
      setAutostartEnabled(next);
    } catch {
      // 失败保持原态，不误显示
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const markDirty = () => {
    setIsDirty(true);
  };

  const updateTextField = (fieldName: "apiKey" | "baseUrl" | "modelName") => {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      markDirty();
      setDraftConfig((currentConfig) => ({
        ...currentConfig,
        [fieldName]: nextValue
      }));
    };
  };

  const updateVoiceRuntimeField = (fieldName: "doubaoSpeakerId") => {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      markDirty();
      setVoiceRuntimeConfig((currentConfig) => ({
        ...currentConfig,
        [fieldName]: nextValue
      }));
    };
  };

  // 切换厂商时恢复该厂商上次保存的仓位（baseUrl / API Key / 模型），
  // 其它厂商的配置原样保留，切来切去互不覆盖。
  const switchToPreset = (presetId: string) => {
    const preset = findModelPresetById(presetId);
    if (!preset) {
      return;
    }

    const restoredConfig = loadModelConfigForPreset(preset.id);
    const restoredModelOptions = resolveModelOptions(preset.id, fetchedModelsByPreset);
    markDirty();
    setSelectedPresetId(preset.id);
    setIsAdvancedModelOpen(
      !restoredModelOptions.some((option) => option.modelName === restoredConfig.modelName)
    );
    // 保留全局生成参数（temperature / maxOutput / thinking），仅切换厂商相关字段。
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: restoredConfig.provider,
      presetId: restoredConfig.presetId,
      apiKey: restoredConfig.apiKey,
      baseUrl: restoredConfig.baseUrl,
      modelName: restoredConfig.modelName,
      modelStrength: restoredConfig.modelStrength,
      streamEnabled: restoredConfig.provider === "openai-compatible" && currentConfig.streamEnabled
    }));
  };

  const applyPreset = (presetId: string) => {
    switchToPreset(presetId);
  };

  const handleProviderChange = (nextProviderValue: string) => {
    const nextProvider = nextProviderValue as ModelProviderType;
    const nextPreset = findDefaultPresetForProvider(nextProvider);
    if (nextPreset) {
      switchToPreset(nextPreset.id);
    }
  };

  const handleLanguageChange = (nextLanguage: SettingsLanguage) => {
    setLanguage(nextLanguage);
    saveSettingsLanguage(nextLanguage);
  };

  const handleModelOptionChange = (nextModelName: string) => {
    const matchedOption = modelOptions.find(
      (option: { modelName: string; strength: ModelStrength }) => option.modelName === nextModelName
    );

    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      modelName: nextModelName,
      modelStrength: matchedOption?.strength ?? currentConfig.modelStrength
    }));
  };

  const handleStrengthChange = (nextStrength: string) => {
    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      modelStrength: nextStrength as ModelStrength
    }));
  };

  // 向厂商拉取该 Key 可用的模型列表，成功则缓存到对应 preset 并展示在下拉框。
  const refreshModelCatalog = async () => {
    const presetId = selectedPresetId;
    const { provider, baseUrl, apiKey } = draftConfig;
    if (!baseUrl.trim() || !apiKey.trim()) {
      return;
    }

    setCatalogStatus("loading");
    setCatalogMessage("");
    const result = await fetchModelCatalog(provider, baseUrl, apiKey);
    if (result.ok) {
      const options: ModelOption[] = result.models.map((model) => ({
        label: model.label,
        modelName: model.modelName,
        strength: model.strength
      }));
      setFetchedModelsByPreset((current) => ({ ...current, [presetId]: options }));
      setCatalogStatus("ready");
      setCatalogMessage(copy.modelCatalogLoaded.replace("{count}", String(options.length)));
    } else {
      setCatalogStatus("error");
      setCatalogMessage(`${result.message} ${copy.modelCatalogFallback}`);
    }
  };

  // Base URL / API Key 失焦后，若两者齐备则自动拉取一次（避免逐字符打接口）。
  const handleProviderFieldBlur = () => {
    if (draftConfig.baseUrl.trim() && draftConfig.apiKey.trim()) {
      void refreshModelCatalog();
    }
  };

  const handleTestConnection = async () => {
    if (!draftConfig.baseUrl.trim() || !draftConfig.apiKey.trim()) {
      setTestConnectionStatus("error");
      setTestConnectionMessage(language === "zh-CN" ? "请先填写 Base URL 和 API Key" : "Please fill Base URL and API Key");
      return;
    }
    setTestConnectionStatus("loading");
    setTestConnectionMessage("");
    const result = await fetchModelCatalog(draftConfig.provider, draftConfig.baseUrl, draftConfig.apiKey);
    if (result.ok) {
      setTestConnectionStatus("success");
      setTestConnectionMessage(
        language === "zh-CN"
          ? `连接成功，发现 ${result.models.length} 个可用模型`
          : `Connected, found ${result.models.length} models`
      );
    } else {
      setTestConnectionStatus("error");
      // 针对推理模型额度耗尽等常见情况，给出更具体的提示已在 provider 层处理，这里直接展示原始信息并追加 Base URL 检查提示
      const extraHint =
        result.message.includes("no_available_channel") || result.message.includes("503")
          ? language === "zh-CN"
            ? "（提示：请确认 Base URL 是否包含 /v1，如 https://api.a6api.com/v1）"
            : " (hint: ensure Base URL includes /v1)"
          : "";
      setTestConnectionMessage(`${result.message}${extraHint}`);
    }
  };

  const handleTemperatureLevelChange = (levelIndex: number) => {
    const level = TEMPERATURE_LEVELS[levelIndex];
    if (!level) {
      return;
    }

    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      temperature: level.value
    }));
  };

  const handleMaxOutputLevelChange = (levelIndex: number) => {
    const level = MAX_OUTPUT_LEVELS[levelIndex];
    if (!level) {
      return;
    }

    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      maxOutputTokens: level.value
    }));
  };

  const handleStreamEnabledChange = (event: ChangeEvent<HTMLInputElement>) => {
    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      streamEnabled: event.target.checked
    }));
  };

  const handleSemanticSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    markDirty();
    setSemanticSearchDraft(event.target.checked);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveModelConfig({
      ...draftConfig,
      presetId: selectedPresetId,
      streamEnabled: draftConfig.provider === "openai-compatible" && draftConfig.streamEnabled
    });
    saveVoiceRuntimeConfig({
      doubaoSpeakerId: voiceRuntimeConfig.doubaoSpeakerId
    });
    setSemanticSearchEnabled(semanticSearchDraft);
    if (semanticSearchDraft) {
      void import("../memory/memorySemanticWarmup").then(({ scheduleIdleSemanticWarmup, warmupSemanticEmbedIfEnabled }) => {
        void warmupSemanticEmbedIfEnabled();
        scheduleIdleSemanticWarmup();
      });
    }
    setIsDirty(false);
    onClose();
  };

  const selectedTemperatureIndex = findClosestLevelIndex(TEMPERATURE_LEVELS, draftConfig.temperature);
  const selectedMaxOutputIndex = findClosestLevelIndex(MAX_OUTPUT_LEVELS, draftConfig.maxOutputTokens);
  const selectedModel = modelOptions.find((option: { modelName: string }) => option.modelName === draftConfig.modelName);
  const selectedStrength = draftConfig.modelStrength;
  const modelSelectValue = selectedModel ? draftConfig.modelName : "";
  const canStream = draftConfig.provider === "openai-compatible";

  if (!isOpen) {
    return null;
  }

  // 顶部页签（用户 2026-08-24 反馈：系统级/不常用功能收进设置模态顶部条中间，操作栏只留高频入口）。
  const settingsTabsNode = (
    <nav className="model-settings-modal__tabs" aria-label={copy.settings}>
      <button
        type="button"
        className={`model-settings-modal__tab${activeTab === "model" ? " is-active" : ""}`}
        aria-pressed={activeTab === "model"}
        onClick={() => setActiveTab("model")}
      >
        {copy.model}
      </button>
      <button
        type="button"
        className={`model-settings-modal__tab${activeTab === "security" ? " is-active" : ""}`}
        aria-pressed={activeTab === "security"}
        onClick={() => setActiveTab("security")}
      >
        {SHARED_SETTINGS_COPY[language].securityTab}
      </button>
      <button
        type="button"
        className={`model-settings-modal__tab${activeTab === "tasks" ? " is-active" : ""}`}
        aria-pressed={activeTab === "tasks"}
        onClick={() => setActiveTab("tasks")}
      >
        {SHARED_SETTINGS_COPY[language].tasksTab}
      </button>
      <button
        type="button"
        className={`model-settings-modal__tab${activeTab === "advanced" ? " is-active" : ""}`}
        aria-pressed={activeTab === "advanced"}
        onClick={() => setActiveTab("advanced")}
      >
        {language === "zh-CN" ? "高级" : "Advanced"}
      </button>
    </nav>
  );

  // 安全状态页签：独立早退渲染，不进入模型设置的 form（避免大表单条件嵌套）。
  if (activeTab === "security") {
    return (
      <div className="model-settings-modal" role="presentation" onMouseDown={onClose}>
        <div
          className="model-settings-modal__panel"
          role="dialog"
          aria-label={SHARED_SETTINGS_COPY[language].securityTab}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="model-settings-modal__header">
            <div className="model-settings-modal__title-group">
              <div className="model-settings-modal__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a5.25 5.25 0 1010.5 0v-3A5.25 5.25 0 0012 1.5z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5h15" />
                </svg>
              </div>
              <div>
                <p className="model-settings-modal__eyebrow">{copy.settings}</p>
                <h2>{SHARED_SETTINGS_COPY[language].securityTab}</h2>
              </div>
            </div>
            {settingsTabsNode}
            <button
              className="model-settings-modal__close"
              type="button"
              aria-label={copy.closeSettings}
              onClick={onClose}
            />
          </div>
          <div className="model-settings-modal__body model-settings-modal__body--single">
            <SecurityStatusContent />
          </div>
        </div>
      </div>
    );
  }

  // 任务台账页签：与安全状态同形，独立早退渲染。
  if (activeTab === "tasks") {
    return (
      <div className="model-settings-modal" role="presentation" onMouseDown={onClose}>
        <div
          className="model-settings-modal__panel"
          role="dialog"
          aria-label={SHARED_SETTINGS_COPY[language].tasksTab}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="model-settings-modal__header">
            <div className="model-settings-modal__title-group">
              <div>
                <p className="model-settings-modal__eyebrow">{copy.settings}</p>
                <h2>{SHARED_SETTINGS_COPY[language].tasksTab}</h2>
              </div>
            </div>
            {settingsTabsNode}
            <button
              className="model-settings-modal__close"
              type="button"
              aria-label={copy.closeSettings}
              onClick={onClose}
            />
          </div>
          <div className="model-settings-modal__body model-settings-modal__body--single">
            <TasksContent />
          </div>
        </div>
      </div>
    );
  }

  if (activeTab === "advanced") {
    return (
      <div className="model-settings-modal" role="presentation" onMouseDown={onClose}>
        <div
          className="model-settings-modal__panel"
          role="dialog"
          aria-label={language === "zh-CN" ? "高级设置" : "Advanced"}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="model-settings-modal__header">
            <div className="model-settings-modal__title-group">
              <div className="model-settings-modal__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 00-1 1.51V11a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
              </div>
              <div>
                <p className="model-settings-modal__eyebrow">{copy.settings}</p>
                <h2>{language === "zh-CN" ? "高级" : "Advanced"}</h2>
              </div>
            </div>
            {settingsTabsNode}
            <button
              className="model-settings-modal__close"
              type="button"
              aria-label={copy.closeSettings}
              onClick={onClose}
            />
          </div>
          <div className="model-settings-modal__body model-settings-modal__body--single">
            <div className="model-settings-modal__advanced">
              <section className="model-settings-modal__field">
                <label className="model-settings-modal__advanced-toggle">
                  <span>
                    <strong>{language === "zh-CN" ? "高权限模式" : "High permission mode"}</strong>
                    <p>{language === "zh-CN" ? "开启后，文件写入、应用启动等操作将减少确认次数，但敏感文件读取与红线拦截保持不变。" : "When enabled, file and app operations require fewer confirmations, but sensitive file access and hard blocks remain."}</p>
                  </span>
                  <span className="model-settings-modal__switch">
                    <input
                      type="checkbox"
                      checked={highPermissionEnabled}
                      onChange={(event) => {
                        if (event.target.checked) {
                          setShowHighPermissionConfirm(true);
                        } else {
                          setHighPermissionMode(false);
                          setHighPermissionEnabled(false);
                        }
                      }}
                    />
                    <span className="model-settings-modal__switch-slider" />
                  </span>
                </label>
                {highPermissionEnabled ? (
                  <p className="model-settings-modal__hint model-settings-modal__hint--warning">
                    {language === "zh-CN"
                      ? "高权限已开启：VOID 将更主动地执行操作。请仅在信任当前任务时保持开启。"
                      : "High permission is on: VOID will act more autonomously. Keep it on only for trusted tasks."}
                  </p>
                ) : null}
              </section>
              <section className="model-settings-modal__field">
                <label className="model-settings-modal__advanced-toggle">
                  <span>
                    <strong>{language === "zh-CN" ? "开机自启动" : "Launch at login"}</strong>
                    <p>{language === "zh-CN" ? "开机后自动启动 VOID（托盘常驻），关窗口不退出。默认关闭；开发预览下可能指向开发进程，以正式安装包为准。" : "Start VOID automatically at login (tray resident). Off by default; dev preview may point at the dev process."}</p>
                  </span>
                  <span className="model-settings-modal__switch">
                    <input
                      type="checkbox"
                      checked={autostartEnabled}
                      disabled={!autostartLoaded}
                      onChange={(event) => void handleAutostartToggle(event.target.checked)}
                    />
                    <span className="model-settings-modal__switch-slider" />
                  </span>
                </label>
              </section>
              {showHighPermissionConfirm ? (
                <div className="model-settings-modal__confirm" role="alertdialog" aria-modal="true">
                  <h4>{language === "zh-CN" ? "确认开启高权限模式？" : "Enable high permission mode?"}</h4>
                  <p>
                    {language === "zh-CN"
                      ? "开启后，以下操作将从“需要确认”降为“直接执行”：应用启动、文件写入/移动、下载落盘等。敏感文件（.env、密钥等）与红线内容（身份证/密码）仍会要求确认或直接拦截。此模式仅影响本机，关闭设置即失效，可随时关闭。"
                      : "When enabled, app launches, file writes/moves and downloads will run without extra confirmation. Sensitive files and hard-blocked secrets still require confirmation or remain blocked. This only affects this device and can be turned off anytime."}
                  </p>
                  <div className="model-settings-modal__confirm-actions">
                    <button type="button" onClick={() => setShowHighPermissionConfirm(false)}>
                      {language === "zh-CN" ? "取消" : "Cancel"}
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => {
                        setHighPermissionMode(true);
                        setHighPermissionEnabled(true);
                        setShowHighPermissionConfirm(false);
                      }}
                    >
                      {language === "zh-CN" ? "确认开启" : "Enable"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="model-settings-modal" role="presentation" onMouseDown={onClose}>
      <form
        className="model-settings-modal__panel"
        aria-label={copy.model}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="model-settings-modal__header">
          <div className="model-settings-modal__title-group">
            <div className="model-settings-modal__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p className="model-settings-modal__eyebrow">{copy.settings}</p>
              <h2>{copy.model}</h2>
            </div>
          </div>
          {settingsTabsNode}
          <button
            className="model-settings-modal__close"
            type="button"
            aria-label={copy.closeSettings}
            onClick={onClose}
          />
        </div>

        <div className="model-settings-modal__body">
          <aside className="model-settings-modal__sidebar">
            <div className="model-settings-modal__sidebar-label">{copy.presetGroup}</div>
            <div className="model-settings-modal__preset-list">
              {MODEL_PRESETS.map((preset) => {
                const isActive = selectedPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`model-settings-modal__preset-card${isActive ? " is-active" : ""}`}
                    onClick={() => applyPreset(preset.id)}
                  >
                    <span>{preset.label}</span>
                    <span className="model-settings-modal__preset-dot" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            <div className="model-settings-modal__sidebar-note">
              <strong>{copy.strengthRuleTitle}</strong>
              <p>{copy.strengthRuleText}</p>
            </div>
          </aside>

          <div className="model-settings-modal__content">
            <section className="model-settings-modal__section">
              <h3 className="model-settings-modal__section-title">{copy.sectionProvider}</h3>
              <div className="model-settings-modal__card">
                <div className="model-settings-modal__grid">
                  <label className="model-settings-modal__field">
                    <span>{copy.provider}</span>
                    <DarkSelect
                      aria-label={copy.provider}
                      value={draftConfig.provider}
                      onChange={handleProviderChange}
                      options={[
                        { value: "openai-compatible", label: "OpenAI-compatible" },
                        { value: "anthropic", label: "Anthropic" }
                      ]}
                    />
                  </label>

                  <label className="model-settings-modal__field">
                    <span>{copy.modelName}</span>
                    <div className="model-settings-modal__input-with-action model-settings-modal__input-with-action--select">
                      <DarkSelect
                        aria-label={copy.modelName}
                        value={modelSelectValue}
                        placeholder={copy.modelName}
                        onChange={handleModelOptionChange}
                        options={modelOptions
                          .filter((option: { modelName: string }) => option.modelName)
                          .map((option: { modelName: string; label: string }) => ({
                            value: option.modelName,
                            label: option.label
                          }))}
                      />
                      <button
                        type="button"
                        className="model-settings-modal__input-action"
                        onClick={() => void refreshModelCatalog()}
                        disabled={catalogStatus === "loading" || !draftConfig.baseUrl.trim() || !draftConfig.apiKey.trim()}
                      >
                        {copy.refreshModelCatalog}
                      </button>
                    </div>
                    {catalogStatus !== "idle" ? (
                      <small>
                        {catalogStatus === "loading" ? copy.modelCatalogLoading : catalogMessage}
                      </small>
                    ) : null}
                  </label>

                  <label className="model-settings-modal__field">
                    <span>{copy.apiKey}</span>
                    <div className="model-settings-modal__input-with-action">
                      <input
                        type={isApiKeyVisible ? "text" : "password"}
                        value={draftConfig.apiKey}
                        autoComplete="off"
                        placeholder={copy.apiKeyHint}
                        onChange={updateTextField("apiKey")}
                        onBlur={handleProviderFieldBlur}
                      />
                      <button
                        type="button"
                        className="model-settings-modal__input-action"
                        onClick={() => setIsApiKeyVisible((current) => !current)}
                      >
                        {isApiKeyVisible ? copy.hideSecret : copy.showSecret}
                      </button>
                    </div>
                  </label>

                  <label className="model-settings-modal__field">
                    <span>{copy.baseUrl}</span>
                    <input
                      type="url"
                      value={draftConfig.baseUrl}
                      onChange={updateTextField("baseUrl")}
                      onBlur={handleProviderFieldBlur}
                    />
                  </label>
                </div>

                <div className="model-settings-modal__test-connection">
                  <button
                    type="button"
                    className="model-settings-modal__input-action"
                    onClick={() => void handleTestConnection()}
                    disabled={testConnectionStatus === "loading"}
                  >
                    {testConnectionStatus === "loading"
                      ? language === "zh-CN"
                        ? "测试中..."
                        : "Testing..."
                      : language === "zh-CN"
                        ? "测试连接"
                        : "Test connection"}
                  </button>
                  {testConnectionStatus !== "idle" ? (
                    <small
                      className={
                        testConnectionStatus === "success"
                          ? "model-settings-modal__test-success"
                          : testConnectionStatus === "error"
                            ? "model-settings-modal__test-error"
                            : ""
                      }
                    >
                      {testConnectionMessage}
                    </small>
                  ) : null}
                </div>

                <div className="model-settings-modal__advanced-model">
                  <button
                    className="model-settings-modal__advanced-toggle"
                    type="button"
                    aria-expanded={isAdvancedModelOpen}
                    onClick={() => setIsAdvancedModelOpen((current) => !current)}
                  >
                    {copy.advancedModel}
                  </button>
                  {isAdvancedModelOpen ? (
                    <label className="model-settings-modal__field">
                      <span>{copy.customModelName}</span>
                      <input
                        type="text"
                        value={draftConfig.modelName}
                        placeholder={copy.customModelNameHint}
                        onChange={updateTextField("modelName")}
                      />
                      <small>{copy.advancedModelHint}</small>
                    </label>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="model-settings-modal__section">
              <h3 className="model-settings-modal__section-title">{copy.sectionGeneration}</h3>
              <div className="model-settings-modal__card">
                <label className="model-settings-modal__field">
                  <span>{copy.modelStrength}</span>
                  <DarkSelect
                    aria-label={copy.modelStrength}
                    value={selectedStrength}
                    onChange={handleStrengthChange}
                    options={availableStrengths.map((strength) => ({
                      value: strength,
                      label: MODEL_STRENGTH_LABELS[strength]
                    }))}
                  />
                </label>

                <LevelSlider
                  label={copy.temperature}
                  hint={copy.temperatureHint}
                  levels={TEMPERATURE_LEVELS}
                  selectedIndex={selectedTemperatureIndex}
                  onSelect={handleTemperatureLevelChange}
                />

                <LevelSlider
                  label={copy.maxOutput}
                  hint={copy.maxOutputHint}
                  levels={MAX_OUTPUT_LEVELS}
                  selectedIndex={selectedMaxOutputIndex}
                  onSelect={handleMaxOutputLevelChange}
                />

                <div className={`model-settings-modal__switch-row${!canStream ? " is-disabled" : ""}`}>
                  <div>
                    <span className="model-settings-modal__switch-title">{copy.streamOutput}</span>
                    <small>{copy.streamOutputHint}</small>
                  </div>
                  <label className="model-settings-modal__switch">
                    <input
                      type="checkbox"
                      checked={draftConfig.streamEnabled && canStream}
                      disabled={!canStream}
                      onChange={handleStreamEnabledChange}
                    />
                    <span className="model-settings-modal__switch-track">
                      <span className="model-settings-modal__switch-thumb" />
                    </span>
                  </label>
                </div>
              </div>
            </section>

            <section className="model-settings-modal__section">
              <h3 className="model-settings-modal__section-title">{copy.sectionMemory}</h3>
              <div className="model-settings-modal__card">
                <div className="model-settings-modal__switch-row">
                  <div>
                    <span className="model-settings-modal__switch-title">{copy.semanticSearch}</span>
                    <small>{copy.semanticSearchHint}</small>
                  </div>
                  <label className="model-settings-modal__switch">
                    <input
                      type="checkbox"
                      checked={semanticSearchDraft}
                      onChange={handleSemanticSearchChange}
                    />
                    <span className="model-settings-modal__switch-track">
                      <span className="model-settings-modal__switch-thumb" />
                    </span>
                  </label>
                </div>
              </div>
            </section>

            <section className="model-settings-modal__section">
              <h3 className="model-settings-modal__section-title">{copy.sectionVoice}</h3>
              <div className="model-settings-modal__card">
                <label className="model-settings-modal__field">
                  <span>{copy.doubaoSpeakerId}</span>
                  <input
                    type="text"
                    value={voiceRuntimeConfig.doubaoSpeakerId}
                    autoComplete="off"
                    placeholder={copy.doubaoSpeakerIdHint}
                    onChange={updateVoiceRuntimeField("doubaoSpeakerId")}
                  />
                  <small>{copy.doubaoSpeakerIdHint}</small>
                </label>
              </div>
            </section>
          </div>
        </div>

        <div className="model-settings-modal__footer">
          <div className="model-settings-modal__footer-left">
            <div className="model-settings-modal__sync">
              <span className={`model-settings-modal__sync-dot${isDirty ? " is-dirty" : ""}`} />
              <span>{isDirty ? copy.syncDirty : copy.syncOk}</span>
            </div>
            <div className="model-settings-modal__lang-switch" aria-label={copy.language}>
              <button
                type="button"
                className={language === "zh-CN" ? "is-active" : ""}
                onClick={() => handleLanguageChange("zh-CN")}
              >
                简
              </button>
              <span>/</span>
              <button
                type="button"
                className={language === "en-US" ? "is-active" : ""}
                onClick={() => handleLanguageChange("en-US")}
              >
                EN
              </button>
            </div>
          </div>

          <div className="model-settings-modal__actions">
            <button type="button" onClick={onClose}>
              {copy.cancel}
            </button>
            <button type="submit">{copy.save}</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function LevelSlider({
  label,
  hint,
  levels,
  selectedIndex,
  onSelect
}: {
  label: string;
  hint: string;
  levels: readonly LevelOption[];
  selectedIndex: number;
  onSelect: (levelIndex: number) => void;
}) {
  const progress = levels.length <= 1 ? 0 : (selectedIndex / (levels.length - 1)) * 100;
  const selectedLabel = levels[selectedIndex]?.label ?? "";

  return (
    <div className="model-settings-modal__field model-settings-modal__level-field">
      <div className="model-settings-modal__level-header">
        <span>{label}</span>
        <strong>{selectedLabel}</strong>
      </div>
      <div className="model-settings-modal__slider-shell">
        <input
          className="model-settings-modal__range"
          type="range"
          min={0}
          max={levels.length - 1}
          step={1}
          value={selectedIndex}
          style={{ ["--range-progress" as string]: `${progress}%` }}
          onChange={(event) => onSelect(Number(event.target.value))}
        />
      </div>
      <div
        className="model-settings-modal__level-labels"
        style={{ ["--level-count" as string]: levels.length }}
      >
        {levels.map((level, index) => (
          <button
            key={level.label}
            className={index === selectedIndex ? "is-active" : ""}
            type="button"
            onClick={() => onSelect(index)}
          >
            {level.label}
          </button>
        ))}
      </div>
      <small>{hint}</small>
    </div>
  );
}

function findPresetId(config: ModelConfig) {
  return findPresetIdForModelConfig(config);
}

/** 取某 preset 的展示模型列表：优先自动拉取缓存，否则内置列表。 */
function resolveModelOptions(presetId: string, fetchedByPreset: Record<string, ModelOption[]>): ModelOption[] {
  const fetched = fetchedByPreset[presetId];
  if (fetched && fetched.length) {
    return fetched;
  }
  return getModelOptionsForPreset(presetId);
}

function findDefaultPresetForProvider(provider: ModelProviderType) {
  return findPresetByProvider(provider);
}

function findClosestLevelIndex(levels: readonly LevelOption[], value: number) {
  let selectedIndex = 0;
  let smallestDistance = Number.POSITIVE_INFINITY;

  levels.forEach((level, index) => {
    const distance = Math.abs(level.value - value);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      selectedIndex = index;
    }
  });

  return selectedIndex;
}
