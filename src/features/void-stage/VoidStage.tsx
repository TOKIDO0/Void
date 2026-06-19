import { useEffect, useState } from "react";
import { BlobScene } from "../blob-scene/BlobScene";
import { VOID_VISUAL_STATE_BY_KEY, type VoidVisualState } from "../void-state/voidVisualState";
import { useMicrophoneVoiceActivity } from "../voice/useMicrophoneVoiceActivity";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  useMicrophoneVoiceActivity({ onVisualStateChange: setVisualState });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const nextState = VOID_VISUAL_STATE_BY_KEY[event.key];
      if (!nextState) {
        return;
      }
      setVisualState(nextState);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <main className="void-stage">
      <BlobScene visualState={visualState} />
    </main>
  );
}
