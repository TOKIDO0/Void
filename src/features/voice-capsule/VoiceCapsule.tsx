import { useRef } from "react";
import type { VoidVisualState } from "../void-state/voidVisualState";
import { useCapsuleAnimation } from "./useCapsuleAnimation";

type VoiceCapsuleProps = {
  visualState: VoidVisualState;
};

const WAVE_BAR_COUNT = 17;

export function VoiceCapsule({ visualState }: VoiceCapsuleProps) {
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  useCapsuleAnimation({ capsuleRef, visualState });

  return (
    <div className="voice-capsule" ref={capsuleRef} aria-label="VOID input">
      <div className="voice-capsule__inner">
        <span className="voice-capsule__chevron" aria-hidden="true" />
        <div className="voice-capsule__wave" aria-hidden="true">
          {Array.from({ length: WAVE_BAR_COUNT }, (_, index) => (
            <span className="voice-capsule__wave-bar" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
