import { isTauriRuntime } from "../../lib/runtime/voidBridgeRuntime";

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
  // 桌面端每次启动都默认开麦；用户在当前会话中仍可手动关闭。
  // Web 端保留持久化选择，避免页面加载时未经用户操作主动请求麦克风权限。
  const desktopVoiceInputDefault = isTauriRuntime();
  const rawValue = window.localStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
  if (!rawValue) {
    return {
      ...DEFAULT_VOICE_PREFERENCES,
      voiceInputEnabled: desktopVoiceInputDefault
    };
  }

  try {
    const parsedValue = JSON.parse(rawValue) as Partial<VoicePreferences>;
    return {
      voiceInputEnabled: desktopVoiceInputDefault || Boolean(parsedValue.voiceInputEnabled),
      voiceOutputEnabled: parsedValue.voiceOutputEnabled === undefined
        ? DEFAULT_VOICE_PREFERENCES.voiceOutputEnabled
        : Boolean(parsedValue.voiceOutputEnabled)
    };
  } catch {
    return {
      ...DEFAULT_VOICE_PREFERENCES,
      voiceInputEnabled: desktopVoiceInputDefault
    };
  }
}

export function saveVoicePreferences(preferences: VoicePreferences) {
  window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
    voiceInputEnabled: Boolean(preferences.voiceInputEnabled),
    voiceOutputEnabled: Boolean(preferences.voiceOutputEnabled)
  }));
}
