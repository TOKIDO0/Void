import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ChangeEvent, CSSProperties, FormEvent, MutableRefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
const MAX_TRAIL_PARTICLES = 96;
const TRAIL_PARTICLE_SPACING = 0.062;
const PARTICLE_VERTICAL_LIMIT = 11;
const PARTICLE_FADE_IN_DURATION = 0.26;
const ORBIT_TRAIL_THEME_STOPS = [
  { progress: 0, glow: "rgba(177, 241, 255, 0.88)", aura: "rgba(116, 231, 255, 0.24)" },
  { progress: 0.33, glow: "rgba(149, 238, 223, 0.9)", aura: "rgba(110, 238, 188, 0.26)" },
  { progress: 0.66, glow: "rgba(255, 215, 138, 0.92)", aura: "rgba(255, 176, 94, 0.3)" },
  { progress: 1, glow: "rgba(255, 154, 103, 0.94)", aura: "rgba(255, 108, 84, 0.34)" }
] as const;
const PLANET_COLOR_STOPS = [
  {
    progress: 0,
    base: "rgba(149, 235, 255, 1)",
    light: "rgba(223, 250, 255, 0.96)",
    shadow: "rgba(42, 110, 140, 1)"
  },
  {
    progress: 0.33,
    base: "rgba(138, 228, 194, 1)",
    light: "rgba(222, 248, 238, 0.95)",
    shadow: "rgba(38, 112, 90, 1)"
  },
  {
    progress: 0.66,
    base: "rgba(241, 198, 118, 1)",
    light: "rgba(255, 241, 211, 0.95)",
    shadow: "rgba(142, 92, 38, 1)"
  },
  {
    progress: 1,
    base: "rgba(214, 131, 88, 1)",
    light: "rgba(255, 229, 212, 0.95)",
    shadow: "rgba(118, 58, 34, 1)"
  }
] as const;

type TrailParticle = {
  id: number;
  element: HTMLSpanElement;
  position: number;
  offsetY: number;
  driftX: number;
  driftY: number;
  size: number;
  blur: number;
  breatheSpeed: number;
  twinklePhase: number;
  alpha: number;
  bornAt: number;
};

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
    const nextPreset = findDefaultPresetForProvider(nextProvider);
    const nextPresetId = nextPreset?.id ?? "";

    setSelectedPresetId(nextPresetId);
    setIsAdvancedModelOpen(false);
    setDraftConfig((currentConfig) => ({
      ...currentConfig,
      provider: nextProvider,
      presetId: nextPresetId,
      baseUrl: nextPreset?.baseUrl ?? currentConfig.baseUrl,
      modelName: nextPreset?.modelName ?? currentConfig.modelName,
      modelStrength: nextPreset ? findModelStrength(nextPreset.id, nextPreset.modelName) ?? currentConfig.modelStrength : currentConfig.modelStrength
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
      modelName: event.target.value,
      modelStrength: findModelStrength(selectedPresetId, event.target.value) ?? currentConfig.modelStrength
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
    if (!isOpen) {
      return;
    }

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
          onComplete: () => {
            gsap.set(contentElement, { height: "auto" });
          },
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
  }, [isAdvancedModelOpen, isOpen]);

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
  const controlRef = useRef<HTMLDivElement>(null);
  const particleLayerRef = useRef<HTMLDivElement>(null);
  const actualProgressRef = useRef(progress);
  const planetRotationRef = useRef(progress * 480);
  const particlesRef = useRef<TrailParticle[]>([]);
  const particleIdRef = useRef(0);
  const previousTargetProgressRef = useRef(progress);
  const nextEmissionProgressRef = useRef(findNextEmissionProgress(progress));

  const applyPlanetColor = (nextProgress: number) => {
    if (!controlRef.current) {
      return;
    }

    const palette = resolvePlanetPalette(nextProgress, variant);
    controlRef.current.style.setProperty("--planet-base-color", palette.base);
    controlRef.current.style.setProperty("--planet-light-color", palette.light);
    controlRef.current.style.setProperty("--planet-shadow-color", palette.shadow);
  };

  useGSAP(() => {
    const controlElement = controlRef.current;
    const planetElement = controlElement?.querySelector(".model-settings-modal__planet");
    const particleLayerElement = particleLayerRef.current;

    if (!controlElement || !planetElement || !particleLayerElement) {
      return;
    }

    const nextTarget = progress;
    const startProgress = actualProgressRef.current;
    const travelDistance = Math.abs(nextTarget - startProgress);
    const direction = nextTarget >= startProgress ? 1 : -1;
    const tweenState = { value: startProgress };

    gsap.killTweensOf(tweenState);

    gsap.to(tweenState, {
      value: nextTarget,
      duration: Math.max(0.82, 0.64 + travelDistance * 1.55),
      ease: "power2.out",
      overwrite: "auto",
      onUpdate: () => {
        const previousProgress = actualProgressRef.current;
        const currentProgress = tweenState.value;
        const delta = currentProgress - previousProgress;

        if (delta === 0) {
          return;
        }

        const nextRotation = planetRotationRef.current + (delta * 780);

        gsap.set(controlElement, {
          "--planet-progress": currentProgress,
          "--slider-heat": currentProgress
        });
        gsap.set(planetElement, { rotation: nextRotation });
        applyPlanetColor(currentProgress);

        if (currentProgress > previousProgress) {
          emitTrailParticles({
            layerElement: particleLayerElement,
            particlesRef,
            particleIdRef,
            nextEmissionProgressRef,
            fromProgress: previousProgress,
            toProgress: currentProgress,
            variant
          });
        } else {
          clearCoveredParticles(particlesRef, currentProgress);
          nextEmissionProgressRef.current = findNextEmissionProgress(currentProgress);
        }

        actualProgressRef.current = currentProgress;
        planetRotationRef.current = nextRotation;
      },
      onComplete: () => {
        actualProgressRef.current = nextTarget;
        previousTargetProgressRef.current = nextTarget;
        if (direction < 0) {
          clearCoveredParticles(particlesRef, nextTarget);
          nextEmissionProgressRef.current = findNextEmissionProgress(nextTarget);
        }
      }
    });

    if (travelDistance === 0) {
      gsap.set(controlElement, {
        "--planet-progress": nextTarget,
        "--slider-heat": nextTarget
      });
      applyPlanetColor(nextTarget);
      if (previousTargetProgressRef.current > nextTarget) {
        clearCoveredParticles(particlesRef, nextTarget);
        nextEmissionProgressRef.current = findNextEmissionProgress(nextTarget);
      }
    }
  }, { dependencies: [progress, variant], scope: controlRef });

  useGSAP(() => {
    resetTrailParticles(particlesRef);
    nextEmissionProgressRef.current = findNextEmissionProgress(progress);
    if (particleLayerRef.current) {
      seedTrailParticles({
        layerElement: particleLayerRef.current,
        particlesRef,
        particleIdRef,
        progress,
        variant
      });
    }
    actualProgressRef.current = progress;
    previousTargetProgressRef.current = progress;
    gsap.set(controlRef.current, {
      "--planet-progress": progress,
      "--slider-heat": progress
    });
    applyPlanetColor(progress);
  }, { dependencies: [variant], scope: controlRef });

  useGSAP(() => {
    const ticker = () => {
      updateTrailParticles(particlesRef);
    };

    gsap.ticker.add(ticker);
    return () => {
      gsap.ticker.remove(ticker);
      resetTrailParticles(particlesRef);
    };
  }, { scope: controlRef });

  return (
    <div className="model-settings-modal__field model-settings-modal__level-field">
      <span>{label}</span>
      <div
        ref={controlRef}
        className={`model-settings-modal__energy-control model-settings-modal__energy-control--${variant}`}
        style={{
          "--slider-progress": `${actualProgressRef.current * 100}%`,
          "--planet-progress": actualProgressRef.current,
          "--slider-heat": actualProgressRef.current
        } as CSSProperties}
      >
        <div ref={particleLayerRef} className="model-settings-modal__energy-particles" aria-hidden="true" />
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
  return findDefaultPresetForProvider(provider)?.id ?? "";
}

function findDefaultPresetForProvider(provider: ModelProviderType) {
  return MODEL_PRESETS.find((preset) => preset.provider === provider);
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

function seedTrailParticles({
  layerElement,
  particlesRef,
  particleIdRef,
  progress,
  variant
}: {
  layerElement: HTMLDivElement;
  particlesRef: MutableRefObject<TrailParticle[]>;
  particleIdRef: MutableRefObject<number>;
  progress: number;
  variant: "response" | "output";
}) {
  if (progress <= 0) {
    return;
  }

  const seedCount = Math.min(MAX_TRAIL_PARTICLES, Math.floor(progress / TRAIL_PARTICLE_SPACING));
  for (let index = 0; index < seedCount; index += 1) {
    const baseProgress = (index + 1) * TRAIL_PARTICLE_SPACING;
    const jitteredProgress = clampNumber(
      baseProgress + ((Math.random() - 0.5) * TRAIL_PARTICLE_SPACING * 0.55),
      0.008,
      progress
    );
    spawnTrailParticle(layerElement, particlesRef, particleIdRef, jitteredProgress, variant);
  }
}

function emitTrailParticles({
  layerElement,
  particlesRef,
  particleIdRef,
  nextEmissionProgressRef,
  fromProgress,
  toProgress,
  variant
}: {
  layerElement: HTMLDivElement;
  particlesRef: MutableRefObject<TrailParticle[]>;
  particleIdRef: MutableRefObject<number>;
  nextEmissionProgressRef: MutableRefObject<number>;
  fromProgress: number;
  toProgress: number;
  variant: "response" | "output";
}) {
  if (toProgress <= fromProgress) {
    return;
  }

  if (nextEmissionProgressRef.current < fromProgress) {
    nextEmissionProgressRef.current = findNextEmissionProgress(fromProgress);
  }

  while (nextEmissionProgressRef.current <= toProgress) {
    const particleProgress = clampNumber(
      nextEmissionProgressRef.current + ((Math.random() - 0.5) * TRAIL_PARTICLE_SPACING * 0.28),
      fromProgress,
      toProgress
    );
    spawnTrailParticle(layerElement, particlesRef, particleIdRef, particleProgress, variant);
    nextEmissionProgressRef.current += TRAIL_PARTICLE_SPACING;
  }

  while (particlesRef.current.length > MAX_TRAIL_PARTICLES) {
    const removableIndex = particlesRef.current.findIndex((particle) => particle.position < toProgress - 0.22);
    const indexToRemove = removableIndex >= 0 ? removableIndex : 0;
    const removableParticle = particlesRef.current.splice(indexToRemove, 1)[0];
    removableParticle?.element.remove();
  }
}

function spawnTrailParticle(
  layerElement: HTMLDivElement,
  particlesRef: MutableRefObject<TrailParticle[]>,
  particleIdRef: MutableRefObject<number>,
  progress: number,
  variant: "response" | "output"
) {
  const element = document.createElement("span");
  element.className = "model-settings-modal__energy-particle";

  const theme = resolveTrailTheme(progress, variant);
  const size = 1.2 + (Math.random() * 1.8);
  const offsetY = clampNumber((Math.random() - 0.5) * 2 * PARTICLE_VERTICAL_LIMIT, -PARTICLE_VERTICAL_LIMIT, PARTICLE_VERTICAL_LIMIT);
  const driftX = (Math.random() - 0.5) * 0.16;
  const driftY = (Math.random() - 0.5) * 0.42;
  const blur = 0.2 + (Math.random() * 0.8);
  const alpha = 0.42 + (Math.random() * 0.42);
  const breatheSpeed = 0.22 + (Math.random() * 0.28);
  const twinklePhase = Math.random() * Math.PI * 2;
  const bornAt = performance.now() * 0.001;

  element.style.setProperty("--particle-position", `${progress}`);
  element.style.setProperty("--particle-offset-y", `${offsetY.toFixed(2)}px`);
  element.style.setProperty("--particle-size", `${size.toFixed(2)}px`);
  element.style.setProperty("--particle-blur", `${blur.toFixed(2)}px`);
  element.style.setProperty("--particle-core-color", theme.glow);
  element.style.setProperty("--particle-aura-color", theme.aura);
  element.style.opacity = "0";

  layerElement.appendChild(element);

  particlesRef.current.push({
    id: particleIdRef.current,
    element,
    position: progress,
    offsetY,
    driftX,
    driftY,
    size,
    blur,
    breatheSpeed,
    twinklePhase,
    alpha,
    bornAt
  });
  particleIdRef.current += 1;
}

function updateTrailParticles(particlesRef: MutableRefObject<TrailParticle[]>) {
  const time = performance.now() * 0.001;

  particlesRef.current.forEach((particle) => {
    const floatX = particle.driftX;
    const floatY = Math.cos((time * particle.breatheSpeed) + particle.twinklePhase) * particle.driftY;
    const shimmer = 0.92 + (Math.sin((time * (particle.breatheSpeed * 1.18)) + particle.twinklePhase) * 0.08);
    const age = Math.max(time - particle.bornAt, 0);
    const revealProgress = clampNumber(age / PARTICLE_FADE_IN_DURATION, 0, 1);
    const revealEase = 1 - ((1 - revealProgress) * (1 - revealProgress));
    const opacity = clampNumber(particle.alpha * shimmer * revealEase, 0, 0.94);
    const scale = 0.72 + (revealEase * 0.28);

    particle.element.style.transform = `translate(calc(-50% + ${floatX.toFixed(2)}px), calc(-50% + ${(particle.offsetY + floatY).toFixed(2)}px)) scale(${scale.toFixed(3)})`;
    particle.element.style.opacity = opacity.toFixed(3);
  });
}

function clearCoveredParticles(
  particlesRef: MutableRefObject<TrailParticle[]>,
  progress: number
) {
  const remainingParticles: TrailParticle[] = [];

  particlesRef.current.forEach((particle) => {
    if (particle.position > progress) {
      particle.element.remove();
      return;
    }

    remainingParticles.push(particle);
  });

  particlesRef.current = remainingParticles;
}

function resetTrailParticles(particlesRef: MutableRefObject<TrailParticle[]>) {
  particlesRef.current.forEach((particle) => particle.element.remove());
  particlesRef.current = [];
}

function resolveTrailTheme(progress: number, variant: "response" | "output") {
  const tintedStops = ORBIT_TRAIL_THEME_STOPS.map((themeStop) => {
    if (variant === "response") {
      return themeStop;
    }

    return {
      progress: themeStop.progress,
      glow: shiftColor(themeStop.glow, 0.92),
      aura: shiftColor(themeStop.aura, 1.08)
    };
  });

  const nextStopIndex = tintedStops.findIndex((themeStop) => progress <= themeStop.progress);
  if (nextStopIndex <= 0) {
    return tintedStops[0];
  }

  const upperStop = tintedStops[nextStopIndex] ?? tintedStops[tintedStops.length - 1];
  const lowerStop = tintedStops[nextStopIndex - 1] ?? tintedStops[0];
  const segmentProgress = (progress - lowerStop.progress) / Math.max(upperStop.progress - lowerStop.progress, 0.0001);

  return {
    glow: mixRgba(lowerStop.glow, upperStop.glow, segmentProgress),
    aura: mixRgba(lowerStop.aura, upperStop.aura, segmentProgress)
  };
}

function resolvePlanetPalette(progress: number, variant: "response" | "output") {
  const tintedStops = PLANET_COLOR_STOPS.map((colorStop) => {
    if (variant === "response") {
      return colorStop;
    }

    return {
      progress: colorStop.progress,
      base: shiftColor(colorStop.base, 0.96),
      light: shiftColor(colorStop.light, 1.02),
      shadow: shiftColor(colorStop.shadow, 0.9)
    };
  });

  const nextStopIndex = tintedStops.findIndex((colorStop) => progress <= colorStop.progress);
  if (nextStopIndex <= 0) {
    return tintedStops[0];
  }

  const upperStop = tintedStops[nextStopIndex] ?? tintedStops[tintedStops.length - 1];
  const lowerStop = tintedStops[nextStopIndex - 1] ?? tintedStops[0];
  const segmentProgress = (progress - lowerStop.progress) / Math.max(upperStop.progress - lowerStop.progress, 0.0001);

  return {
    base: mixRgba(lowerStop.base, upperStop.base, segmentProgress),
    light: mixRgba(lowerStop.light, upperStop.light, segmentProgress),
    shadow: mixRgba(lowerStop.shadow, upperStop.shadow, segmentProgress)
  };
}

function shiftColor(color: string, brightness: number) {
  const matched = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!matched) {
    return color;
  }

  const [, red, green, blue, alpha] = matched;
  return `rgba(${clampColor(Number(red) * brightness)}, ${clampColor(Number(green) * brightness)}, ${clampColor(Number(blue) * brightness)}, ${alpha})`;
}

function clampColor(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function mixRgba(startColor: string, endColor: string, progress: number) {
  const start = parseRgba(startColor);
  const end = parseRgba(endColor);

  if (!start || !end) {
    return progress >= 0.5 ? endColor : startColor;
  }

  const mix = (from: number, to: number) => from + ((to - from) * progress);
  return `rgba(${clampColor(mix(start.red, end.red))}, ${clampColor(mix(start.green, end.green))}, ${clampColor(mix(start.blue, end.blue))}, ${mix(start.alpha, end.alpha).toFixed(3)})`;
}

function parseRgba(color: string) {
  const matched = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  if (!matched) {
    return null;
  }

  const [, red, green, blue, alpha] = matched;
  return {
    red: Number(red),
    green: Number(green),
    blue: Number(blue),
    alpha: Number(alpha)
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function findNextEmissionProgress(progress: number) {
  return Math.floor(progress / TRAIL_PARTICLE_SPACING) * TRAIL_PARTICLE_SPACING + TRAIL_PARTICLE_SPACING;
}
