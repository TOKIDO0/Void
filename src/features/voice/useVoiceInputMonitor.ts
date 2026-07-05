import { useEffect, useRef } from "react";
import type { VoidVisualState } from "../void-state/voidVisualState";
import type { VoiceActivityLevel, VoiceInputState } from "./voiceState";

type UseVoiceInputMonitorArgs = {
  isEnabled: boolean;
  onInputStateChange: (inputState: VoiceInputState) => void;
  onActivityLevelChange: (activityLevel: VoiceActivityLevel) => void;
  onVisualStateChange: (visualState: VoidVisualState) => void;
};

const SPEECH_START_LEVEL = 0.045;
const SPEECH_END_LEVEL = 0.022;
const SILENCE_TO_TRANSCRIBING_MS = 820;

export function useVoiceInputMonitor({
  isEnabled,
  onInputStateChange,
  onActivityLevelChange,
  onVisualStateChange
}: UseVoiceInputMonitorArgs) {
  const onInputStateChangeRef = useRef(onInputStateChange);
  const onActivityLevelChangeRef = useRef(onActivityLevelChange);
  const onVisualStateChangeRef = useRef(onVisualStateChange);

  useEffect(() => {
    onInputStateChangeRef.current = onInputStateChange;
  }, [onInputStateChange]);

  useEffect(() => {
    onActivityLevelChangeRef.current = onActivityLevelChange;
  }, [onActivityLevelChange]);

  useEffect(() => {
    onVisualStateChangeRef.current = onVisualStateChange;
  }, [onVisualStateChange]);

  useEffect(() => {
    if (!isEnabled) {
      onInputStateChangeRef.current("mic_off");
      onActivityLevelChangeRef.current("silent");
      return;
    }

    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphoneStream: MediaStream | null = null;
    let animationFrameId = 0;
    let isSpeaking = false;
    let lastSpeechTime = 0;
    let isDisposed = false;

    const calculateVolumeLevel = (samples: Uint8Array) => {
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const centeredSample = (samples[index] - 128) / 128;
        sum += centeredSample * centeredSample;
      }
      return Math.sqrt(sum / samples.length);
    };

    const renderVoiceActivity = () => {
      if (!analyser || isDisposed) {
        return;
      }

      const samples = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(samples);
      const volumeLevel = calculateVolumeLevel(samples);
      const now = performance.now();

      if (volumeLevel >= SPEECH_START_LEVEL) {
        lastSpeechTime = now;
        if (!isSpeaking) {
          isSpeaking = true;
          onActivityLevelChangeRef.current("active");
          onInputStateChangeRef.current("listening");
          onVisualStateChangeRef.current("listening");
        }
      }

      if (isSpeaking && volumeLevel <= SPEECH_END_LEVEL && now - lastSpeechTime > SILENCE_TO_TRANSCRIBING_MS) {
        isSpeaking = false;
        onActivityLevelChangeRef.current("silent");
        onInputStateChangeRef.current("transcribing");
        onVisualStateChangeRef.current("thinking");
      }

      animationFrameId = window.requestAnimationFrame(renderVoiceActivity);
    };

    const startMonitoring = async () => {
      onInputStateChangeRef.current("standby");
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        if (isDisposed) {
          microphoneStream.getTracks().forEach((track) => track.stop());
          return;
        }

        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.82;

        const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
        microphoneSource.connect(analyser);
        renderVoiceActivity();
      } catch {
        onInputStateChangeRef.current("mic_off");
        onActivityLevelChangeRef.current("silent");
        onVisualStateChangeRef.current("idle");
      }
    };

    void startMonitoring();

    return () => {
      isDisposed = true;
      window.cancelAnimationFrame(animationFrameId);
      microphoneStream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close();
      onActivityLevelChangeRef.current("silent");
    };
  }, [isEnabled]);
}
