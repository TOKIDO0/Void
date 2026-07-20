import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
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
  saveModelConfig,
  type LevelOption,
  type ModelConfig,
  type ModelProviderType,
  type ModelRequestMode,
  type ModelStrength
} from "./modelConfig";
import {
  SETTINGS_COPY,
  loadSettingsLanguage,
  saveSettingsLanguage,
  type SettingsLanguage
} from "./settingsI18n";
import { loadVoiceRuntimeConfig, saveVoiceRuntimeConfig } from "../voice/voiceRuntimeConfig";

type ModelSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const MODEL_STRENGTH_ORDER: ModelStrength[] = ["low", "middle", "high", "max"];

export function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [voiceRuntimeConfig, setVoiceRuntimeConfig] = useState(() => loadVoiceRuntimeConfig());
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [selectedPresetId, setSelectedPresetId] = useState(() => findPresetId(loadModelConfig()));
  const [isAdvancedModelOpen, setIsAdvancedModelOpen] = useState(false);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const copy = SETTINGS_COPY[language];
  const modelOptions = useMemo(() => getModelOptionsForPreset(selectedPresetId), [selectedPresetId]);
  const availableStrengths = useMemo(() => MODEL_STRENGTH_ORDER, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const storedConfig = loadModelConfig();
    const storedVoiceRuntimeConfig = loadVoiceRuntimeConfig();
    const storedPresetId = findPresetId(storedConfig);
    const storedModelOptions = getModelOptionsForPreset(storedPresetId);

    setDraftConfig(storedConfig);
    setVoiceRuntimeConfig(storedVoiceRuntimeConfig);
    setSelectedPresetId(storedPresetId);
    setIsAdvancedModelOpen(
      !storedModelOptions.some((option: { modelName: string }) => option.modelName === storedConfig.modelName)
    );
    setIsApiKeyVisible(false);
    setIsDirty(false);
  }, [isOpen]);

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

  const applyPreset = (presetId: string) => {
    const preset = findModelPresetById(presetId);
    if (!preset) {
      return;
    }

    const nextModelOptions = getModelOptionsForPreset(preset.id);
    markDirty();
    setSelectedPresetId(preset.id);
    setIsAdvancedModelOpen(false);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      presetId: preset.id,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      modelName: preset.modelName,
      modelStrength:
        nextModelOptions.find(
          (option: { modelName: string; strength: ModelStrength }) => option.modelName === preset.modelName
        )?.strength ?? currentConfig.modelStrength,
      streamEnabled: preset.provider === "openai-compatible" && currentConfig.streamEnabled
    }));
  };

  const handleProviderChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextProvider = event.target.value as ModelProviderType;
    const nextPreset = findDefaultPresetForProvider(nextProvider);
    const nextPresetId = nextPreset?.id ?? "";
    const nextModelOptions = getModelOptionsForPreset(nextPresetId);
    const nextModelName = nextPreset?.modelName ?? "";

    markDirty();
    setSelectedPresetId(nextPresetId);
    setIsAdvancedModelOpen(false);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: nextProvider,
      presetId: nextPresetId,
      baseUrl: nextPreset?.baseUrl ?? currentConfig.baseUrl,
      modelName: nextModelName || currentConfig.modelName,
      modelStrength:
        nextModelOptions.find(
          (option: { modelName: string; strength: ModelStrength }) => option.modelName === nextModelName
        )?.strength ?? currentConfig.modelStrength,
      streamEnabled: nextProvider === "openai-compatible" && currentConfig.streamEnabled
    }));
  };

  const handleLanguageChange = (nextLanguage: SettingsLanguage) => {
    setLanguage(nextLanguage);
    saveSettingsLanguage(nextLanguage);
  };

  const handleModelOptionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextModelName = event.target.value;
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

  const handleStrengthChange = (event: ChangeEvent<HTMLSelectElement>) => {
    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      modelStrength: event.target.value as ModelStrength
    }));
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

  const handleRequestModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    markDirty();
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      requestMode: event.target.value as ModelRequestMode
    }));
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
                    <select value={draftConfig.provider} onChange={handleProviderChange}>
                      <option value="openai-compatible">OpenAI-compatible</option>
                      <option value="anthropic">Anthropic</option>
                    </select>
                  </label>

                  <label className="model-settings-modal__field">
                    <span>{copy.modelName}</span>
                    <select value={modelSelectValue} onChange={handleModelOptionChange}>
                      <option value="" disabled>
                        {copy.modelName}
                      </option>
                      {modelOptions
                        .filter((option: { modelName: string }) => option.modelName)
                        .map((option: { modelName: string; label: string }) => (
                          <option key={option.modelName} value={option.modelName}>
                            {option.label}
                          </option>
                        ))}
                    </select>
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
                    <input type="url" value={draftConfig.baseUrl} onChange={updateTextField("baseUrl")} />
                  </label>
                </div>

                <label className="model-settings-modal__field">
                  <span>{copy.requestMode}</span>
                  <select value={draftConfig.requestMode} onChange={handleRequestModeChange}>
                    <option value="development-proxy">{copy.requestModeDevelopment}</option>
                    <option value="production-proxy">{copy.requestModeProduction}</option>
                  </select>
                  <small>{copy.requestModeHint}</small>
                </label>

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
                  <select value={selectedStrength} onChange={handleStrengthChange}>
                    {availableStrengths.map((strength) => (
                      <option key={strength} value={strength}>
                        {MODEL_STRENGTH_LABELS[strength]}
                      </option>
                    ))}
                  </select>
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
