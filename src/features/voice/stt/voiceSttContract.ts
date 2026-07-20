export type VoiceSttPartialResult = {
  text: string;
  isInterim: boolean;
};

export type VoiceSttStartOptions = {
  onPartialResult: (result: VoiceSttPartialResult) => void;
  onFinalResult: (text: string, options?: { commitImmediately?: boolean }) => void;
  onError: (error: Error) => void;
  onInputStateChange?: (inputState: VoiceInputState) => void;
  onActivityLevelChange?: (activityLevel: VoiceActivityLevel) => void;
  onRuntimeStatusChange?: (status: VoiceInputRuntimeStatus) => void;
};

export interface VoiceSttProvider {
  start(options: VoiceSttStartOptions): Promise<void>;
  stop(): Promise<void>;
}
import type { VoiceActivityLevel, VoiceInputRuntimeStatus, VoiceInputState } from "../voiceState";
