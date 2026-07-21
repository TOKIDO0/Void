import type { VoiceRequestMode } from "./voiceProviderConfig";

export type VoiceRuntimeConfig = {
  requestMode: VoiceRequestMode;
  doubaoSpeakerId: string;
};

/**
 * 语音请求链路模式：与模型链路同理，属运行环境属性而非用户偏好。
 * 仅按运行时事实（Vite dev 与否）判定，不读任何持久化配置。
 * 真正的目标地址解析在 buildVoiceFetchTarget（Tauri/dev/prod 分流），此值只用于错误话术区分。
 */
function resolveVoiceRequestMode(): VoiceRequestMode {
  const isViteDev = Boolean(
    typeof import.meta !== "undefined"
    && import.meta.env
    && import.meta.env.DEV
  );
  return isViteDev ? "development-proxy" : "production-proxy";
}

const DOUBAO_SPEAKER_ID_STORAGE_KEY = "void.voice.doubaoSpeakerId";

/**
 * 托管语音默认音色。
 * 语音密钥已上移到 Cloudflare Worker，客户端只需要非敏感的 speakerId。
 * 若用户尚未在设置里填写，使用官方可用女声，避免「语音输出开着却整段无声」。
 */
export const DEFAULT_DOUBAO_SPEAKER_ID = "zh_female_xiaohe_uranus_bigtts";

const LEGACY_CLIENT_VOICE_SECRET_KEYS = [
  "void.voice.doubaoAppId",
  "void.voice.doubaoApiKey",
  "void.voice.doubaoResourceId",
  "void.voice.fishAudioApiKey",
  "void.voice.minimaxApiKey"
] as const;

export function loadVoiceRuntimeConfig(): VoiceRuntimeConfig {
  clearLegacyClientVoiceSecrets();
  const storedSpeakerId = window.localStorage.getItem(DOUBAO_SPEAKER_ID_STORAGE_KEY)?.trim() ?? "";
  return {
    requestMode: resolveVoiceRequestMode(),
    // 设置里可覆盖；空值回落到默认音色，保证托管 TTS 可直接发声。
    doubaoSpeakerId: storedSpeakerId || DEFAULT_DOUBAO_SPEAKER_ID
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
