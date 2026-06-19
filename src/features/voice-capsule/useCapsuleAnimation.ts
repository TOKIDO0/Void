import type { RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { BLOB_VISUAL_PROFILES, type VoidVisualState } from "../void-state/voidVisualState";

gsap.registerPlugin(useGSAP);

type UseCapsuleAnimationArgs = {
  capsuleRef: RefObject<HTMLDivElement | null>;
  visualState: VoidVisualState;
};

export function useCapsuleAnimation({ capsuleRef, visualState }: UseCapsuleAnimationArgs) {
  useGSAP(
    () => {
      const capsule = capsuleRef.current;
      if (!capsule) {
        return;
      }

      const mode = BLOB_VISUAL_PROFILES[visualState].capsuleMode;
      const waveBars = capsule.querySelectorAll(".voice-capsule__wave-bar");

      const timeline = gsap.timeline({ defaults: { duration: 0.72, ease: "sine.inOut" } });
      if (mode === "closed") {
        timeline.to(capsule, { width: "min(46vw, 376px)", height: 56, opacity: 0.62 }, 0);
        timeline.to(waveBars, { scaleY: 0.18, opacity: 0.28, stagger: 0.015 }, 0);
      }

      if (mode === "open") {
        timeline.to(capsule, { width: "min(58vw, 470px)", height: 62, opacity: 0.86 }, 0);
        timeline.to(waveBars, { scaleY: 0.72, opacity: 0.74, stagger: 0.018 }, 0);
      }

      if (mode === "focused") {
        timeline.to(capsule, { width: 64, height: 64, opacity: 0.78 }, 0);
        timeline.to(waveBars, { scaleY: 0.08, opacity: 0, stagger: 0.01 }, 0);
      }

      let loop: gsap.core.Tween | null = null;
      if (visualState === "listening" || visualState === "speaking") {
        loop = gsap.to(waveBars, {
          scaleY: visualState === "speaking" ? "random(0.38, 1.0)" : "random(0.24, 0.72)",
          duration: visualState === "speaking" ? 0.36 : 0.54,
          ease: "sine.inOut",
          repeat: -1,
          repeatRefresh: true,
          stagger: { each: 0.026, from: "center" },
          yoyo: true
        });
      }

      return () => {
        timeline.kill();
        loop?.kill();
      };
    },
    { dependencies: [visualState], scope: capsuleRef, revertOnUpdate: true }
  );
}
