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
  const rawValue = window.localStorage.getItem(VOICE_PREFERENCES_STORAGE_KEY);
  if (!rawValue) {
    return DEFAULT_VOICE_PREFERENCES;
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
    return DEFAULT_VOICE_PREFERENCES;
  }
}

export function saveVoicePreferences(preferences: VoicePreferences) {
  window.localStorage.setItem(VOICE_PREFERENCES_STORAGE_KEY, JSON.stringify({
    voiceInputEnabled: Boolean(preferences.voiceInputEnabled),
    voiceOutputEnabled: Boolean(preferences.voiceOutputEnabled)
  }));
}
