import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { loadModelConfig, saveModelConfig, type ModelConfig } from "./modelConfig";

type ModelSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());

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
        aria-label="Model settings"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="model-settings-modal__header">
          <div>
            <p className="model-settings-modal__eyebrow">Settings</p>
            <h2>Model</h2>
          </div>
          <button className="model-settings-modal__close" type="button" aria-label="Close settings" onClick={onClose} />
        </div>

        <div className="model-settings-modal__grid">
          <label className="model-settings-modal__field">
            <span>Provider</span>
            <select value={draftConfig.provider} disabled>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </label>

          <label className="model-settings-modal__field">
            <span>API Key</span>
            <input
              type="password"
              value={draftConfig.apiKey}
              autoComplete="off"
              placeholder="Session only"
              onChange={updateTextField("apiKey")}
            />
          </label>

          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>Base URL</span>
            <input type="url" value={draftConfig.baseUrl} onChange={updateTextField("baseUrl")} />
          </label>

          <label className="model-settings-modal__field model-settings-modal__field--wide">
            <span>Model Name</span>
            <input type="text" value={draftConfig.modelName} onChange={updateTextField("modelName")} />
          </label>

          <label className="model-settings-modal__field">
            <span>Temperature</span>
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
            <span>Max Output</span>
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
          <span>Stream output</span>
        </label>

        <div className="model-settings-modal__actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
