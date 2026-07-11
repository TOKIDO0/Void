import { loadModelConfig } from "../settings/modelConfig";
import type { VoiceRequestMode } from "./voiceProviderConfig";

export type VoiceRuntimeConfig = {
  requestMode: VoiceRequestMode;
  doubaoSpeakerId: string;
};

const DOUBAO_SPEAKER_ID_STORAGE_KEY = "void.voice.doubaoSpeakerId";
const LEGACY_CLIENT_VOICE_SECRET_KEYS = [
  "void.voice.doubaoAppId",
  "void.voice.doubaoApiKey",
  "void.voice.doubaoResourceId",
  "void.voice.fishAudioApiKey",
  "void.voice.minimaxApiKey"
] as const;

export function loadVoiceRuntimeConfig(): VoiceRuntimeConfig {
  clearLegacyClientVoiceSecrets();
  return {
    requestMode: loadModelConfig().requestMode,
    doubaoSpeakerId: window.localStorage.getItem(DOUBAO_SPEAKER_ID_STORAGE_KEY) ?? ""
  };
}

/** 清除旧版本曾写入浏览器存储的语音鉴权信息，避免迁移后仍残留在客户端。 */
function clearLegacyClientVoiceSecrets() {
  for (const storageKey of LEGACY_CLIENT_VOICE_SECRET_KEYS) {
    window.localStorage.removeItem(storageKey);
    window.sessionStorage.removeItem(storageKey);
  }
}

export function saveVoiceRuntimeConfig(
  config: Partial<Pick<VoiceRuntimeConfig, "doubaoSpeakerId">>
) {
  if (config.doubaoSpeakerId !== undefined) {
    persistLocalValue(DOUBAO_SPEAKER_ID_STORAGE_KEY, config.doubaoSpeakerId);
  }
}

function persistLocalValue(key: string, value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    window.localStorage.removeItem(key);
    return;
  }

  window.localStorage.setItem(key, trimmedValue);
}
