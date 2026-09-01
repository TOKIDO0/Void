export type VoicePreferences = {
  voiceInputEnabled: boolean;
  voiceOutputEnabled: boolean;
};

const VOICE_PREFERENCES_STORAGE_KEY = "void.voicePreferences";

const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  voiceInputEnabled: false,
  voiceOutputEnabled: true
};

export function loadVoicePreferences(): VoicePreferences {
  // 06 号文档 §1：默认不开启主动监听，软件启动后麦克风默认关闭，需用户明确授权后才可保持监听。
  // 桌面/Web 一致为 false，避免启动即请求麦克风权限或误录背景音。
  const rawValue = window.localStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
  if (!rawValue) {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }

  try {
    const parsedValue = JSON.parse(rawValue) as Partial<VoicePreferences>;
    return {
      voiceInputEnabled: Boolean(parsedValue.voiceInputEnabled),
      voiceOutputEnabled: parsedValue.voiceOutputEnabled === undefined
        ? DEFAULT_VOICE_PREFERENCES.voiceOutputEnabled
        : Boolean(parsedValue.voiceOutputEnabled)
    };
  } catch {
    return { ...DEFAULT_VOICE_PREFERENCES };
  }
}

export function saveVoicePreferences(preferences: VoicePreferences) {
  window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
    voiceInputEnabled: Boolean(preferences.voiceInputEnabled),
    voiceOutputEnabled: Boolean(preferences.voiceOutputEnabled)
  }));
}
