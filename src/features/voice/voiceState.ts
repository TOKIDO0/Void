export type VoiceInputState = "mic_off" | "standby" | "listening" | "transcribing";

export type VoiceOutputState = "idle" | "speaking";

export type VoiceActivityLevel = "silent" | "active";

export type VoiceInputRuntimeStatus = "off" | "starting" | "ready" | "recovering" | "error";

export type VoiceStateSnapshot = {
  inputState: VoiceInputState;
  outputState: VoiceOutputState;
  activityLevel: VoiceActivityLevel;
  runtimeStatus: VoiceInputRuntimeStatus;
};

export const DEFAULT_VOICE_STATE: VoiceStateSnapshot = {
  inputState: "mic_off",
  outputState: "idle",
  activityLevel: "silent",
  runtimeStatus: "off"
};
