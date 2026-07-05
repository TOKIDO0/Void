import { loadModelConfig } from "../settings/modelConfig";
import { FISHAUDIO_TTS_MODEL, type VoiceRequestMode } from "./voiceProviderConfig";

export type VoiceRuntimeConfig = {
  requestMode: VoiceRequestMode;
  doubaoApiKey: string;
  doubaoSpeakerId: string;
  doubaoResourceId: string;
  fishAudioApiKey: string;
  fishAudioVoiceId: string;
  fishAudioModel: string;
  minimaxApiKey: string;
  minimaxGroupId: string;
};

const DOUBAO_API_KEY_STORAGE_KEY = "void.voice.doubaoApiKey";
const DOUBAO_SPEAKER_ID_STORAGE_KEY = "void.voice.doubaoSpeakerId";
const DOUBAO_RESOURCE_ID_STORAGE_KEY = "void.voice.doubaoResourceId";
const FISHAUDIO_API_KEY_STORAGE_KEY = "void.voice.fishAudioApiKey";
const FISHAUDIO_VOICE_ID_STORAGE_KEY = "void.voice.fishAudioVoiceId";
const FISHAUDIO_MODEL_STORAGE_KEY = "void.voice.fishAudioModel";
const MINIMAX_API_KEY_STORAGE_KEY = "void.voice.minimaxApiKey";
const MINIMAX_GROUP_ID_STORAGE_KEY = "void.voice.minimaxGroupId";

export function loadVoiceRuntimeConfig(): VoiceRuntimeConfig {
  return {
    requestMode: loadModelConfig().requestMode,
    doubaoApiKey: window.sessionStorage.getItem(DOUBAO_API_KEY_STORAGE_KEY) ?? "",
    doubaoSpeakerId: window.localStorage.getItem(DOUBAO_SPEAKER_ID_STORAGE_KEY) ?? "",
    doubaoResourceId: window.localStorage.getItem(DOUBAO_RESOURCE_ID_STORAGE_KEY) ?? "",
    fishAudioApiKey: window.sessionStorage.getItem(FISHAUDIO_API_KEY_STORAGE_KEY) ?? "",
    fishAudioVoiceId: window.localStorage.getItem(FISHAUDIO_VOICE_ID_STORAGE_KEY) ?? "",
    fishAudioModel: normalizeFishAudioModel(window.localStorage.getItem(FISHAUDIO_MODEL_STORAGE_KEY) ?? ""),
    minimaxApiKey: window.sessionStorage.getItem(MINIMAX_API_KEY_STORAGE_KEY) ?? "",
    minimaxGroupId: window.localStorage.getItem(MINIMAX_GROUP_ID_STORAGE_KEY) ?? ""
  };
}

export function saveVoiceRuntimeConfig(
  config: Partial<Pick<VoiceRuntimeConfig, "doubaoApiKey" | "doubaoSpeakerId" | "doubaoResourceId" | "fishAudioApiKey" | "fishAudioVoiceId" | "fishAudioModel" | "minimaxApiKey" | "minimaxGroupId">>
) {
  if (config.doubaoApiKey !== undefined) {
    persistSessionValue(DOUBAO_API_KEY_STORAGE_KEY, config.doubaoApiKey);
  }

  if (config.doubaoSpeakerId !== undefined) {
    persistLocalValue(DOUBAO_SPEAKER_ID_STORAGE_KEY, config.doubaoSpeakerId);
  }

  if (config.doubaoResourceId !== undefined) {
    persistLocalValue(DOUBAO_RESOURCE_ID_STORAGE_KEY, config.doubaoResourceId);
  }

  if (config.fishAudioApiKey !== undefined) {
    persistSessionValue(FISHAUDIO_API_KEY_STORAGE_KEY, config.fishAudioApiKey);
  }

  if (config.fishAudioVoiceId !== undefined) {
    persistLocalValue(FISHAUDIO_VOICE_ID_STORAGE_KEY, config.fishAudioVoiceId);
  }

  if (config.fishAudioModel !== undefined) {
    persistLocalValue(FISHAUDIO_MODEL_STORAGE_KEY, normalizeFishAudioModel(config.fishAudioModel));
  }

  if (config.minimaxApiKey !== undefined) {
    persistSessionValue(MINIMAX_API_KEY_STORAGE_KEY, config.minimaxApiKey);
  }

  if (config.minimaxGroupId !== undefined) {
    persistLocalValue(MINIMAX_GROUP_ID_STORAGE_KEY, config.minimaxGroupId);
  }
}

function persistSessionValue(key: string, value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    window.sessionStorage.removeItem(key);
    return;
  }

  window.sessionStorage.setItem(key, trimmedValue);
}

function persistLocalValue(key: string, value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, trimmedValue);
}

function normalizeFishAudioModel(model: string) {
  const trimmedModel = model.trim().toLowerCase();
  // 官方支持的模型标识；其余（含空值、历史遗留的 kitta-tts-v1）统一回落到默认免费模型 s2.1-pro
  const supportedModels = new Set(["s2.1-pro", "s2-pro", "s1"]);
  if (supportedModels.has(trimmedModel)) {
    return trimmedModel;
  }

  return FISHAUDIO_TTS_MODEL;
}
