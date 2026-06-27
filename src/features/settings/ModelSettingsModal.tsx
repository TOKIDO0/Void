import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ChangeEvent, CSSProperties, FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  { position: 0.08, y: -4, size: 3, delay: 0.04 },
  { position: 0.15, y: 5, size: 4, delay: 0.02 },
  { position: 0.23, y: -2, size: 2, delay: 0.08 },
  { position: 0.31, y: 6, size: 3, delay: 0.01 },
  { position: 0.4, y: -6, size: 4, delay: 0.06 },
  { position: 0.48, y: 1, size: 2, delay: 0.03 },
  { position: 0.58, y: -4, size: 3, delay: 0.09 },
  { position: 0.67, y: 5, size: 4, delay: 0.05 },
  { position: 0.77, y: -1, size: 3, delay: 0.07 },
  { position: 0.87, y: 4, size: 2, delay: 0.02 },
  { position: 0.93, y: -5, size: 3, delay: 0.1 }
] as const;

export function ModelSettingsModal({ isOpen, onClose }: ModelSettingsModalProps) {
  const [draftConfig, setDraftConfig] = useState<ModelConfig>(() => loadModelConfig());
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [selectedPresetId, setSelectedPresetId] = useState(() => findPresetId(loadModelConfig()));
  const [isAdvancedModelOpen, setIsAdvancedModelOpen] = useState(false);
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
    const storedPresetId = findPresetId(storedConfig);
    const storedModelOptions = MODEL_OPTIONS_BY_PRESET[storedPresetId] ?? [];

    setDraftConfig(storedConfig);
    setSelectedPresetId(storedPresetId);
    setIsAdvancedModelOpen(!storedModelOptions.some((option) => option.modelName === storedConfig.modelName));
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
    const nextProvider = event.target.value as ModelProviderType;
    const nextPresetId = findDefaultPresetIdForProvider(nextProvider);

    setSelectedPresetId(nextPresetId);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: nextProvider,
      presetId: nextPresetId
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
    setIsAdvancedModelOpen(false);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      presetId: preset.id,
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

  const handleAdvancedModelToggle = () => {
    setIsAdvancedModelOpen((currentIsOpen) => !currentIsOpen);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveModelConfig({
      ...draftConfig,
      presetId: selectedPresetId,
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
  const advancedContentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const contentElement = advancedContentRef.current;
    if (!contentElement) {
      return;
    }

    gsap.killTweensOf(contentElement);
    gsap.set(contentElement, { height: "auto" });
    const expandedHeight = contentElement.offsetHeight;

    if (isAdvancedModelOpen) {
      gsap.fromTo(
        contentElement,
        { height: 0, autoAlpha: 0, y: -12 },
        {
          height: expandedHeight,
          autoAlpha: 1,
          y: 0,
          duration: 0.48,
          ease: "power3.out",
          clearProps: "height",
          overwrite: "auto"
        }
      );
      return;
    }

    gsap.fromTo(
      contentElement,
      { height: expandedHeight, autoAlpha: 1, y: 0 },
      {
        height: 0,
        autoAlpha: 0,
        y: -10,
        duration: 0.4,
        ease: "power2.inOut",
        overwrite: "auto"
      }
    );
  }, [isAdvancedModelOpen]);

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

            <div className="model-settings-modal__advanced-model">
              <button
                className="model-settings-modal__advanced-toggle"
                type="button"
                aria-expanded={isAdvancedModelOpen}
                onClick={handleAdvancedModelToggle}
              >
                {copy.advancedModel}
              </button>
              <div
                ref={advancedContentRef}
                className="model-settings-modal__advanced-panel"
                aria-hidden={!isAdvancedModelOpen}
              >
                <label className="model-settings-modal__field">
                  <span>{copy.customModelName}</span>
                  <input
                    type="text"
                    disabled={!isAdvancedModelOpen}
                    value={draftConfig.modelName}
                    placeholder={copy.customModelNameHint}
                    onChange={updateTextField("modelName")}
                  />
                  <small>{copy.advancedModelHint}</small>
                </label>
              </div>
            </div>

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
  const previousProgressRef = useRef(progress);
  const planetRotationRef = useRef(progress * 360);

  useGSAP(() => {
    const controlElement = controlRef.current;
    const planetElement = controlElement?.querySelector(".model-settings-modal__planet");
    const trailElements = controlRef.current?.querySelectorAll(".model-settings-modal__trail-particle");

    if (!controlElement || !planetElement || !trailElements?.length) {
      return;
    }

    const previousProgress = previousProgressRef.current;
    const delta = progress - previousProgress;
    const direction = delta === 0 ? 0 : delta > 0 ? 1 : -1;
    const travelDistance = Math.abs(delta);
    const nextRotation = planetRotationRef.current + (delta * 720);

    gsap.to(controlElement, {
      "--planet-progress": progress,
      duration: Math.max(0.52, travelDistance * 1.25),
      ease: "power3.inOut",
      overwrite: "auto"
    });

    gsap.to(planetElement, {
      rotation: nextRotation,
      duration: Math.max(0.52, travelDistance * 1.25),
      ease: "power3.inOut",
      overwrite: "auto"
    });

    trailElements.forEach((trailElement, particleIndex) => {
      const particle = ORBIT_TRAIL_PARTICLES[particleIndex];
      const seededDrift = (((selectedIndex + 1) * (particleIndex + 3) * 17) % 11) - 5;
      const driftX = direction === 0 ? 0 : seededDrift * Math.min(travelDistance * 7, 7);
      const driftY = particle.y + (direction === 0 ? 0 : seededDrift * 0.6);
      const distanceFromPlanet = direction >= 0
        ? Math.max(progress - particle.position, 0)
        : Math.max(particle.position - progress, 0);
      const shouldGlow = direction >= 0
        ? progress >= particle.position && particle.position >= progress - Math.max(travelDistance * 1.35, 0.22)
        : progress <= particle.position && particle.position <= progress + Math.max(travelDistance * 1.35, 0.22);
      const particleOpacity = shouldGlow ? Math.min(0.38 + distanceFromPlanet * 1.4, 0.94) : 0.04;
      const particleScale = shouldGlow ? Math.min(0.7 + distanceFromPlanet * 1.2, 1.45) : 0.28;

      gsap.to(trailElement, {
        autoAlpha: particleOpacity,
        scale: particleScale,
        x: driftX,
        y: driftY,
        filter: shouldGlow ? "blur(0px)" : "blur(1.6px)",
        duration: 0.28 + particle.delay,
        ease: "power2.out",
        overwrite: "auto"
      });
    });

    previousProgressRef.current = progress;
    planetRotationRef.current = nextRotation;
  }, { dependencies: [progress, selectedIndex], scope: controlRef });

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
  if (MODEL_PRESETS.some((preset) => preset.id === config.presetId && preset.provider === config.provider)) {
    return config.presetId;
  }

  return MODEL_PRESETS.find((preset) => preset.baseUrl === config.baseUrl && preset.provider === config.provider)?.id
    ?? findDefaultPresetIdForProvider(config.provider);
}

function findModelStrength(presetId: string, modelName: string) {
  return MODEL_OPTIONS_BY_PRESET[presetId]?.find((option) => option.modelName === modelName)?.strength;
}

function findDefaultPresetIdForProvider(provider: ModelProviderType) {
  return MODEL_PRESETS.find((preset) => preset.provider === provider)?.id ?? "";
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
