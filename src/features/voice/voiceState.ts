export type VoiceInputState = "mic_off" | "standby" | "listening" | "transcribing";

export type VoiceOutputState = "idle" | "speaking";

export type VoiceActivityLevel = "silent" | "active";

export type VoiceStateSnapshot = {
  inputState: VoiceInputState;
  outputState: VoiceOutputState;
  activityLevel: VoiceActivityLevel;
};

export const DEFAULT_VOICE_STATE: VoiceStateSnapshot = {
  inputState: "mic_off",
  outputState: "idle",
  activityLevel: "silent"
};
