import { loadModelConfig } from "../settings/modelConfig";
import { normalizeFishAudioModel, type VoiceRequestMode } from "./voiceProviderConfig";

// 豆包 TTS 合成模式：bidirectional=双向流式（整段单 session，根治句界音调跳变，默认）；
// http=逐句单向 HTTP（旧路径，作回退）。仅影响主供应商豆包；Fish/MiniMax 不受此开关影响。
export type DoubaoTtsMode = "bidirectional" | "http";

export type VoiceRuntimeConfig = {
  requestMode: VoiceRequestMode;
  doubaoAppId: string;
  doubaoApiKey: string;
  doubaoSpeakerId: string;
  doubaoResourceId: string;
  doubaoTtsMode: DoubaoTtsMode;
  fishAudioApiKey: string;
  fishAudioVoiceId: string;
  fishAudioModel: string;
  minimaxApiKey: string;
  minimaxGroupId: string;
};

const DOUBAO_APP_ID_STORAGE_KEY = "void.voice.doubaoAppId";
const DOUBAO_API_KEY_STORAGE_KEY = "void.voice.doubaoApiKey";
const DOUBAO_SPEAKER_ID_STORAGE_KEY = "void.voice.doubaoSpeakerId";
const DOUBAO_RESOURCE_ID_STORAGE_KEY = "void.voice.doubaoResourceId";
const DOUBAO_TTS_MODE_STORAGE_KEY = "void.voice.doubaoTtsMode";
const FISHAUDIO_API_KEY_STORAGE_KEY = "void.voice.fishAudioApiKey";
const FISHAUDIO_VOICE_ID_STORAGE_KEY = "void.voice.fishAudioVoiceId";
const FISHAUDIO_MODEL_STORAGE_KEY = "void.voice.fishAudioModel";
const MINIMAX_API_KEY_STORAGE_KEY = "void.voice.minimaxApiKey";
const MINIMAX_GROUP_ID_STORAGE_KEY = "void.voice.minimaxGroupId";

export function loadVoiceRuntimeConfig(): VoiceRuntimeConfig {
  return {
    requestMode: loadModelConfig().requestMode,
    doubaoAppId: window.localStorage.getItem(DOUBAO_APP_ID_STORAGE_KEY) ?? "",
    doubaoApiKey: window.sessionStorage.getItem(DOUBAO_API_KEY_STORAGE_KEY) ?? "",
    doubaoSpeakerId: window.localStorage.getItem(DOUBAO_SPEAKER_ID_STORAGE_KEY) ?? "",
    doubaoResourceId: window.localStorage.getItem(DOUBAO_RESOURCE_ID_STORAGE_KEY) ?? "",
    // 默认双向流式；仅当显式存过 "http" 才回退旧逐句路径。
    doubaoTtsMode: window.localStorage.getItem(DOUBAO_TTS_MODE_STORAGE_KEY) === "http" ? "http" : "bidirectional",
    fishAudioApiKey: window.sessionStorage.getItem(FISHAUDIO_API_KEY_STORAGE_KEY) ?? "",
    fishAudioVoiceId: window.localStorage.getItem(FISHAUDIO_VOICE_ID_STORAGE_KEY) ?? "",
    fishAudioModel: normalizeFishAudioModel(window.localStorage.getItem(FISHAUDIO_MODEL_STORAGE_KEY) ?? ""),
    minimaxApiKey: window.sessionStorage.getItem(MINIMAX_API_KEY_STORAGE_KEY) ?? "",
    minimaxGroupId: window.localStorage.getItem(MINIMAX_GROUP_ID_STORAGE_KEY) ?? ""
  };
}

export function saveVoiceRuntimeConfig(
  config: Partial<Pick<VoiceRuntimeConfig, "doubaoAppId" | "doubaoApiKey" | "doubaoSpeakerId" | "doubaoResourceId" | "fishAudioApiKey" | "fishAudioVoiceId" | "fishAudioModel" | "minimaxApiKey" | "minimaxGroupId">>
) {
  if (config.doubaoAppId !== undefined) {
    persistLocalValue(DOUBAO_APP_ID_STORAGE_KEY, config.doubaoAppId);
  }

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
