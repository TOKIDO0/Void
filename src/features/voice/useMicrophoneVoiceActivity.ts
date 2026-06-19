import { useEffect, useRef } from "react";
import type { VoidVisualState } from "../void-state/voidVisualState";

type UseMicrophoneVoiceActivityArgs = {
  onVisualStateChange: (visualState: VoidVisualState) => void;
};

const SPEECH_START_LEVEL = 0.045;
const SPEECH_END_LEVEL = 0.022;
const SILENCE_TO_THINKING_MS = 820;
const THINKING_PREVIEW_MS = 2200;

export function useMicrophoneVoiceActivity({
  onVisualStateChange
}: UseMicrophoneVoiceActivityArgs) {
  const onVisualStateChangeRef = useRef(onVisualStateChange);

  useEffect(() => {
    onVisualStateChangeRef.current = onVisualStateChange;
  }, [onVisualStateChange]);

  useEffect(() => {
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphoneStream: MediaStream | null = null;
    let animationFrameId = 0;
    let hasStarted = false;
    let isSpeaking = false;
    let lastSpeechTime = 0;
    let thinkingTimeoutId = 0;

    const stopThinkingPreview = () => {
      window.clearTimeout(thinkingTimeoutId);
      thinkingTimeoutId = 0;
    };

    const calculateVolumeLevel = (samples: Uint8Array) => {
      let sum = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const centeredSample = (samples[index] - 128) / 128;
        sum += centeredSample * centeredSample;
      }
      return Math.sqrt(sum / samples.length);
    };

    const renderVoiceActivity = () => {
      if (!analyser) {
        return;
      }

      const samples = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(samples);
      const volumeLevel = calculateVolumeLevel(samples);
      const now = performance.now();

      if (volumeLevel >= SPEECH_START_LEVEL) {
        stopThinkingPreview();
        lastSpeechTime = now;
        if (!isSpeaking) {
          isSpeaking = true;
          onVisualStateChangeRef.current("listening");
        }
      }

      if (isSpeaking && volumeLevel <= SPEECH_END_LEVEL && now - lastSpeechTime > SILENCE_TO_THINKING_MS) {
        isSpeaking = false;
        onVisualStateChangeRef.current("thinking");
        thinkingTimeoutId = window.setTimeout(() => {
          onVisualStateChangeRef.current("idle");
        }, THINKING_PREVIEW_MS);
      }

      animationFrameId = window.requestAnimationFrame(renderVoiceActivity);
    };

    const startMicrophone = async () => {
      if (hasStarted || !navigator.mediaDevices?.getUserMedia) {
        return;
      }

      hasStarted = true;
      try {
        microphoneStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.82;

        const microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
        microphoneSource.connect(analyser);
        renderVoiceActivity();
      } catch {
        hasStarted = false;
        onVisualStateChangeRef.current("idle");
      }
    };

    const startAfterUserIntent = () => {
      void startMicrophone();
    };

    const startIfPermissionAlreadyGranted = async () => {
      if (!navigator.permissions?.query) {
        return;
      }

      try {
        const microphonePermission = await navigator.permissions.query({
          name: "microphone" as PermissionName
        });
        if (microphonePermission.state === "granted") {
          void startMicrophone();
        }
      } catch {
        return;
      }
    };

    void startIfPermissionAlreadyGranted();
    window.addEventListener("pointerdown", startAfterUserIntent, { once: true });
    window.addEventListener("keydown", startAfterUserIntent, { once: true });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(thinkingTimeoutId);
      window.removeEventListener("pointerdown", startAfterUserIntent);
      window.removeEventListener("keydown", startAfterUserIntent);
      microphoneStream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close();
    };
  }, []);
}
