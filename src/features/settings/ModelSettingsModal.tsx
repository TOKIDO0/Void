import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import {
  MODEL_PRESETS,
  loadModelConfig,
  saveModelConfig,
  type ModelConfig,
  type ModelProviderType,
  type ModelRequestMode
} from "./modelConfig";
import {
  SETTINGS_COPY,
  loadSettingsLanguage,
  saveSettingsLanguage,
  type SettingsLanguage
} from "./settingsI18n";

type ModelSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const copy = SETTINGS_COPY[language];

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDraftConfig(loadModelConfig());
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

  if (!isOpen) {
    return null;
  }

  const updateTextField = (fieldName: "apiKey" | "baseUrl" | "modelName") => {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setDraftConfig((currentConfig) => ({
        ...currentConfig,
        [fieldName]: event.target.value
      }));
    };
  };

  const handleProviderChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: event.target.value as ModelProviderType
    }));
  };

  const handleRequestModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      requestMode: event.target.value as ModelRequestMode
    }));
  };

  const handleLanguageChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = event.target.value as SettingsLanguage;
    setLanguage(nextLanguage);
    saveSettingsLanguage(nextLanguage);
  };

  const handlePresetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const preset = MODEL_PRESETS.find((currentPreset) => currentPreset.id === event.target.value);
    if (!preset) {
      return;
    }

    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      modelName: preset.modelName || currentConfig.modelName
    }));
  };

  const handleTemperatureChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      temperature: Number(event.target.value)
    }));
  };

  const handleMaxOutputTokensChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      maxOutputTokens: Number(event.target.value)
    }));
  };

  const handleStreamEnabledChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      streamEnabled: event.target.checked
    }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveModelConfig(draftConfig);
    onClose();
  };

  return (
    <div className="model-settings-modal" role="presentation" onMouseDown={onClose}>
      <form
        className="model-settings-modal__panel"
        aria-label={copy.model}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="model-settings-modal__header">
          <div>
            <p className="model-settings-modal__eyebrow">{copy.settings}</p>
            <h2>{copy.model}</h2>
          </div>
          <div className="model-settings-modal__header-actions">
            <label className="model-settings-modal__language">
              <span>{copy.language}</span>
              <select value={language} onChange={handleLanguageChange}>
                <option value="zh-CN">中文</option>
                <option value="en-US">English</option>
              </select>
            </label>
            <button
              className="model-settings-modal__close"
              type="button"
              aria-label={copy.closeSettings}
              onClick={onClose}
            />
          </div>
        </div>

        <div className="model-settings-modal__grid">
          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>{copy.preset}</span>
            <select defaultValue="" onChange={handlePresetChange}>
              <option value="" disabled>
                {copy.presetPlaceholder}
              </option>
              {MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>

          <label className="model-settings-modal__field">
            <span>{copy.provider}</span>
            <select value={draftConfig.provider} onChange={handleProviderChange}>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>

          <label className="model-settings-modal__field">
            <span>{copy.apiKey}</span>
            <input
              type="password"
              value={draftConfig.apiKey}
              autoComplete="off"
              placeholder={copy.apiKeyHint}
              onChange={updateTextField("apiKey")}
            />
          </label>

          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>{copy.baseUrl}</span>
            <input type="url" value={draftConfig.baseUrl} onChange={updateTextField("baseUrl")} />
          </label>

          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>{copy.modelName}</span>
            <input type="text" value={draftConfig.modelName} onChange={updateTextField("modelName")} />
          </label>

          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>{copy.requestMode}</span>
            <select value={draftConfig.requestMode} onChange={handleRequestModeChange}>
              <option value="development-proxy">{copy.developmentProxy}</option>
              <option value="direct">{copy.browserDirect}</option>
            </select>
            <small>{copy.requestModeNote}</small>
          </label>

          <label className="model-settings-modal__field">
            <span>{copy.temperature}</span>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={draftConfig.temperature}
              onChange={handleTemperatureChange}
            />
          </label>

          <label className="model-settings-modal__field">
            <span>{copy.maxOutput}</span>
            <input
              type="number"
              min="128"
              max="8192"
              step="128"
              value={draftConfig.maxOutputTokens}
              onChange={handleMaxOutputTokensChange}
            />
          </label>
        </div>

        <label className="model-settings-modal__toggle">
          <input type="checkbox" checked={draftConfig.streamEnabled} onChange={handleStreamEnabledChange} />
          <span>{copy.streamOutput}</span>
        </label>

        <div className="model-settings-modal__actions">
          <button type="button" onClick={onClose}>
            {copy.cancel}
          </button>
          <button type="submit">{copy.save}</button>
        </div>
      </form>
    </div>
  );
}
