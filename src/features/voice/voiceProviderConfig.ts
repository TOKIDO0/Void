export type VoiceRequestMode = "development-proxy" | "production-proxy";

export type VoiceTtsProviderKind = "doubao" | "minimax" | "fishaudio";

export type VoicePersonaGender = "female" | "male";

export type VoiceSceneMode = "default" | "story" | "horror" | "companion";

export type VoiceCatalogEntry = {
  provider: VoiceTtsProviderKind;
  voiceId: string;
  label: string;
  gender: VoicePersonaGender;
  scene: VoiceSceneMode;
};

export const DOUBAO_TTS_RESOURCE_ID = "seed-tts-2.0";
export const DOUBAO_TTS_MODEL = "seed-tts-2.0-standard";
export const DOUBAO_TTS_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream";
export const DOUBAO_TTS_HTTP_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
export const DOUBAO_ASR_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
export const DOUBAO_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration";

export const MINIMAX_TTS_ENDPOINT = "https://api.minimaxi.com/v1/t2a_v2";
export const MINIMAX_TTS_MODEL = "speech-02-turbo";

export const FISHAUDIO_TTS_ENDPOINT = "https://api.fish.audio/v1/tts";
// s2.1-pro 为官方免费开放模型（见 https://fish.audio/zh-CN/blog/s2-1-pro-free-api/），已实测返回真实音频
export const FISHAUDIO_TTS_MODEL = "s2.1-pro";

export const DEFAULT_FEMALE_MINIMAX_VOICE_ID = "Chinese (Mandarin)_Mature_Woman";
export const DEFAULT_MALE_MINIMAX_VOICE_ID = "Chinese (Mandarin)_Gentleman";

export const VOICE_CATALOG: readonly VoiceCatalogEntry[] = [
  {
    provider: "minimax",
    voiceId: DEFAULT_FEMALE_MINIMAX_VOICE_ID,
    label: "默认女性人格音色",
    gender: "female",
    scene: "default"
  },
  {
    provider: "minimax",
    voiceId: DEFAULT_MALE_MINIMAX_VOICE_ID,
    label: "默认男性人格音色",
    gender: "male",
    scene: "default"
  },
  {
    provider: "minimax",
    voiceId: "Chinese (Mandarin)_Warm_HeartedGirl",
    label: "轻陪伴",
    gender: "female",
    scene: "companion"
  },
  {
    provider: "minimax",
    voiceId: "Chinese_radio_host_male_nv1",
    label: "讲故事",
    gender: "male",
    scene: "story"
  },
  {
    provider: "minimax",
    voiceId: "Chinese_gravelly_storyteller_nv1",
    label: "低沉叙事",
    gender: "male",
    scene: "horror"
  },
  {
    provider: "minimax",
    voiceId: "Chinese (Mandarin)_Sweet_Lady",
    label: "甜系女声",
    gender: "female",
    scene: "companion"
  }
] as const;

export function resolveDefaultVoiceCatalogEntry(gender: VoicePersonaGender) {
  return VOICE_CATALOG.find((entry) => entry.scene === "default" && entry.gender === gender) ?? VOICE_CATALOG[0];
}

export function resolveSceneVoiceCatalogEntry(scene: VoiceSceneMode, preferredGender: VoicePersonaGender) {
  return VOICE_CATALOG.find((entry) => entry.scene === scene && entry.gender === preferredGender)
    ?? VOICE_CATALOG.find((entry) => entry.scene === scene)
    ?? resolveDefaultVoiceCatalogEntry(preferredGender);
}
