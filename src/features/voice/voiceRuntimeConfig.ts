import type { VoiceRequestMode } from "./voiceProviderConfig";
import { normalizeQwen3Speaker } from "./tts/qwen3Voices";

export type VoiceTtsProviderMode = "local" | "cloud";
export type LocalTtsEngine = "qwen3" | "kokoro";

export type VoiceRuntimeConfig = {
  requestMode: VoiceRequestMode;
  doubaoSpeakerId: string;
  /** 本地优先；云端 TTS 需要付费且当前资源未授权，默认不走云端。 */
  voiceTtsProvider: VoiceTtsProviderMode;
  /** 本地语音引擎：Qwen3 质量优先，Kokoro 低配/快速兜底。 */
  localTtsEngine: LocalTtsEngine;
  /** Qwen3 CustomVoice 内置音色 id，默认 ono_anna。 */
  qwenSpeaker: string;
  /** Kokoro 音色 id（47=zf_xiaoxiao）。 */
  localTtsVoiceId: number;
  /**
   * 本地平滑优先：先攒够 2 个合成块再开口。
   * 本地 Qwen3 的 RTF≈1.8，不等缓冲会每 ~2 秒断一次；代价是首字多等约 2–3 秒。
   */
  localTtsSmoothStart: boolean;
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
const VOICE_TTS_PROVIDER_STORAGE_KEY = "void.voice.ttsProvider";
const LOCAL_TTS_ENGINE_STORAGE_KEY = "void.voice.localTtsEngine";
const QWEN_SPEAKER_STORAGE_KEY = "void.voice.qwenSpeaker";
const LOCAL_TTS_VOICE_STORAGE_KEY = "void.voice.localTtsVoiceId";
const LOCAL_TTS_SMOOTH_START_STORAGE_KEY = "void.voice.smoothStart";
const DEFAULT_LOCAL_TTS_VOICE_ID = 47;

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
  const storedProvider = window.localStorage.getItem(VOICE_TTS_PROVIDER_STORAGE_KEY)?.trim();
  const storedEngine = window.localStorage.getItem(LOCAL_TTS_ENGINE_STORAGE_KEY)?.trim();
  const storedQwenSpeaker = window.localStorage.getItem(QWEN_SPEAKER_STORAGE_KEY)?.trim() ?? "";
  const storedSmoothStart = window.localStorage.getItem(LOCAL_TTS_SMOOTH_START_STORAGE_KEY)?.trim();
  const storedVoiceId = Number.parseInt(
    window.localStorage.getItem(LOCAL_TTS_VOICE_STORAGE_KEY)?.trim() ?? "",
    10
  );
  return {
    requestMode: resolveVoiceRequestMode(),
    // 设置里可覆盖；空值回落到默认音色，保证托管 TTS 可直接发声。
    doubaoSpeakerId: storedSpeakerId || DEFAULT_DOUBAO_SPEAKER_ID,
    // 默认本地：Qwen3 质量优先，引擎不可用时由 LocalTtsProvider 回退 Kokoro。
    voiceTtsProvider: storedProvider === "cloud" ? "cloud" : "local",
    localTtsEngine: storedEngine === "kokoro" ? "kokoro" : "qwen3",
    qwenSpeaker: normalizeQwen3Speaker(storedQwenSpeaker),
    localTtsVoiceId: Number.isInteger(storedVoiceId) && storedVoiceId >= 0 && storedVoiceId <= 53
      ? storedVoiceId
      : DEFAULT_LOCAL_TTS_VOICE_ID,
    localTtsSmoothStart: storedSmoothStart === "1"
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
  config: Partial<Pick<
    VoiceRuntimeConfig,
    "doubaoSpeakerId" | "localTtsEngine" | "qwenSpeaker" | "voiceTtsProvider" | "localTtsSmoothStart"
  >>
) {
  if (config.doubaoSpeakerId !== undefined) {
    persistLocalValue(DOUBAO_SPEAKER_ID_STORAGE_KEY, config.doubaoSpeakerId);
  }
  if (config.localTtsEngine !== undefined) {
    persistLocalValue(LOCAL_TTS_ENGINE_STORAGE_KEY, config.localTtsEngine === "kokoro" ? "kokoro" : "qwen3");
  }
  if (config.qwenSpeaker !== undefined) {
    persistLocalValue(QWEN_SPEAKER_STORAGE_KEY, normalizeQwen3Speaker(config.qwenSpeaker));
  }
  if (config.voiceTtsProvider !== undefined) {
    persistLocalValue(VOICE_TTS_PROVIDER_STORAGE_KEY, config.voiceTtsProvider === "cloud" ? "cloud" : "local");
  }
  if (config.localTtsSmoothStart !== undefined) {
    persistLocalValue(LOCAL_TTS_SMOOTH_START_STORAGE_KEY, config.localTtsSmoothStart ? "1" : "");
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
