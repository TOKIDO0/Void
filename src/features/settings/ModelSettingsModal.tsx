import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ChangeEvent, CSSProperties, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_OUTPUT_LEVELS,
  MODEL_OPTIONS_BY_PRESET,
  MODEL_PRESETS,
  MODEL_STRENGTH_LABELS,
  TEMPERATURE_LEVELS,
  loadModelConfig,
  saveModelConfig,
  type LevelOption,
  type ModelConfig,
  type ModelProviderType,
  type ModelStrength
} from "./modelConfig";
import {
  SETTINGS_COPY,
  loadSettingsLanguage,
  saveSettingsLanguage,
  type SettingsLanguage
} from "./settingsI18n";

gsap.registerPlugin(useGSAP);

type ModelSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const MODEL_STRENGTH_ORDER: ModelStrength[] = ["low", "middle", "high", "max"];
const ORBIT_TRAIL_PARTICLES = [
  { position: 0.08, y: -4, size: 2 },
  { position: 0.16, y: 4, size: 3 },
  { position: 0.24, y: -1, size: 2 },
  { position: 0.33, y: 5, size: 2 },
  { position: 0.42, y: -5, size: 3 },
  { position: 0.52, y: 2, size: 2 },
  { position: 0.62, y: -3, size: 3 },
  { position: 0.71, y: 5, size: 2 },
  { position: 0.8, y: -2, size: 3 },
  { position: 0.89, y: 3, size: 2 }
] as const;

export function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [selectedPresetId, setSelectedPresetId] = useState(() => findPresetId(loadModelConfig()));
  const copy = SETTINGS_COPY[language];
  const modelOptions = useMemo(() => MODEL_OPTIONS_BY_PRESET[selectedPresetId] ?? [], [selectedPresetId]);
  const availableStrengths = useMemo(() => {
    return MODEL_STRENGTH_ORDER;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const storedConfig = loadModelConfig();
    setDraftConfig(storedConfig);
    setSelectedPresetId(findPresetId(storedConfig));
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

    setSelectedPresetId(preset.id);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      modelName: preset.modelName,
      modelStrength: findModelStrength(preset.id, preset.modelName) ?? currentConfig.modelStrength
    }));
  };

  const handleModelOptionChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      modelName: event.target.value
    }));
  };

  const handleStrengthChange = (event: ChangeEvent<HTMLSelectElement>) => {
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

    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      maxOutputTokens: level.value
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
    saveModelConfig({
      ...draftConfig,
      streamEnabled: draftConfig.provider === "openai-compatible" && draftConfig.streamEnabled
    });
    onClose();
  };

  const selectedTemperatureIndex = findClosestLevelIndex(TEMPERATURE_LEVELS, draftConfig.temperature);
  const selectedMaxOutputIndex = findClosestLevelIndex(MAX_OUTPUT_LEVELS, draftConfig.maxOutputTokens);
  const selectedModel = modelOptions.find((option) => option.modelName === draftConfig.modelName);
  const selectedStrength = draftConfig.modelStrength;
  const modelSelectValue = selectedModel ? draftConfig.modelName : "";
  const canStream = draftConfig.provider === "openai-compatible";

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

        <div className="model-settings-modal__content">
          <section className="model-settings-modal__section">
            <label className="model-settings-modal__field">
              <span>{copy.preset}</span>
              <select value={selectedPresetId} onChange={handlePresetChange}>
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

            <label className="model-settings-modal__field">
              <span>{copy.baseUrl}</span>
              <input type="url" value={draftConfig.baseUrl} onChange={updateTextField("baseUrl")} />
            </label>
          </section>

          <section className="model-settings-modal__section">
            <label className="model-settings-modal__field">
              <span>{copy.modelName}</span>
              <select value={modelSelectValue} onChange={handleModelOptionChange}>
                <option value="" disabled>
                  {copy.modelName}
                </option>
                {modelOptions
                  .filter((option) => option.modelName)
                  .map((option) => (
                    <option key={option.modelName} value={option.modelName}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </label>

            <label className="model-settings-modal__field">
              <span>{copy.customModelName}</span>
              <input
                type="text"
                value={draftConfig.modelName}
                placeholder={copy.customModelNameHint}
                onChange={updateTextField("modelName")}
              />
            </label>

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
              variant="response"
              onSelect={handleTemperatureLevelChange}
            />

            <LevelSlider
              label={copy.maxOutput}
              hint={copy.maxOutputHint}
              levels={MAX_OUTPUT_LEVELS}
              selectedIndex={selectedMaxOutputIndex}
              variant="output"
              onSelect={handleMaxOutputLevelChange}
            />
          </section>
        </div>

        <div className="model-settings-modal__footer">
          <label className="model-settings-modal__toggle">
            <input
              type="checkbox"
              checked={draftConfig.streamEnabled && canStream}
              disabled={!canStream}
              onChange={handleStreamEnabledChange}
            />
            <span>{copy.streamOutput}</span>
            <span className="model-settings-modal__hint-trigger" tabIndex={0} aria-label={copy.streamOutputHint}>
              ?
              <span className="model-settings-modal__tooltip" role="tooltip">
                {copy.streamOutputHint}
              </span>
            </span>
          </label>

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
  variant,
  onSelect
}: {
  label: string;
  hint: string;
  levels: readonly LevelOption[];
  selectedIndex: number;
  variant: "response" | "output";
  onSelect: (levelIndex: number) => void;
}) {
  const progress = selectedIndex / Math.max(levels.length - 1, 1);
  const heat = progress;
  const controlRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const planetElement = controlRef.current?.querySelector(".model-settings-modal__planet");
    const trailElements = controlRef.current?.querySelectorAll(".model-settings-modal__trail-particle");

    if (!planetElement || !trailElements?.length) {
      return;
    }

    gsap.to(controlRef.current, {
      "--planet-progress": progress,
      duration: 0.58,
      ease: "power3.out",
      overwrite: "auto"
    });

    trailElements.forEach((trailElement, particleIndex) => {
      const particle = ORBIT_TRAIL_PARTICLES[particleIndex];
      const isVisible = progress >= particle.position;
      const distanceFromPlanet = Math.max(progress - particle.position, 0);

      gsap.to(trailElement, {
        autoAlpha: isVisible ? Math.min(0.32 + distanceFromPlanet * 0.72, 0.86) : 0,
        scale: isVisible ? Math.min(0.72 + distanceFromPlanet * 0.72, 1) : 0.36,
        duration: 0.36,
        ease: "power2.out",
        overwrite: "auto"
      });
    });
  }, { dependencies: [progress], scope: controlRef });

  return (
    <div className="model-settings-modal__field model-settings-modal__level-field">
      <span>{label}</span>
      <div
        ref={controlRef}
        className={`model-settings-modal__energy-control model-settings-modal__energy-control--${variant}`}
        style={{
          "--slider-progress": `${progress * 100}%`,
          "--planet-progress": progress,
          "--slider-heat": heat
        } as CSSProperties}
      >
        <div className="model-settings-modal__energy-particles" aria-hidden="true">
          {ORBIT_TRAIL_PARTICLES.map((particle) => (
            <span
              className="model-settings-modal__trail-particle"
              key={particle.position}
              style={{
                "--trail-position": particle.position,
                "--trail-y": `${particle.y}px`,
                "--trail-size": `${particle.size}px`
              } as CSSProperties}
            />
          ))}
        </div>
        <div className="model-settings-modal__planet" aria-hidden="true" />
        <input
          className="model-settings-modal__range"
          type="range"
          min="0"
          max={levels.length - 1}
          step="1"
          value={selectedIndex}
          onChange={(event) => onSelect(Number(event.target.value))}
        />
      </div>
      <div
        className="model-settings-modal__level-labels"
        style={{ "--level-count": levels.length } as CSSProperties}
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
  return MODEL_PRESETS.find((preset) => preset.baseUrl === config.baseUrl && preset.provider === config.provider)?.id ?? "";
}

function findModelStrength(presetId: string, modelName: string) {
  return MODEL_OPTIONS_BY_PRESET[presetId]?.find((option) => option.modelName === modelName)?.strength;
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
