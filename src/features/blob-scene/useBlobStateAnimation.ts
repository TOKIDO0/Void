import { useEffect, useMemo, useRef } from "react";
import gsap from "gsap";
import { Color } from "three";
import {
  BLOB_COLOR_SCHEMES,
  BLOB_VISUAL_PROFILES,
  type VoidVisualState
} from "../void-state/voidVisualState";

export type BlobAnimatedValues = {
  scale: number;
  shapeX: number;
  shapeY: number;
  shapeZ: number;
  bloomIntensity: number;
  noiseSpeed: number;
  edgeBoost: number;
  amplitude: number;
  irregularity: number;
  innerFlow: number;
  transitionEnergy: number;
  audioLevel: number;
};

export function useBlobStateAnimation(visualState: VoidVisualState) {
  const animatedValuesRef = useRef<BlobAnimatedValues>({
    scale: 1,
    shapeX: 1,
    shapeY: 1,
    shapeZ: 1,
    bloomIntensity: 2.5,
    noiseSpeed: 0.16,
    edgeBoost: 1,
    amplitude: 0.28,
    irregularity: 1,
    innerFlow: 1,
    transitionEnergy: 0,
    audioLevel: 0
  });
  const baseColor = useMemo(() => new Color("#0A0AFF"), []);
  const edgeColor = useMemo(() => new Color("#00CFFF"), []);

  useEffect(() => {
    const profile = BLOB_VISUAL_PROFILES[visualState];
    const colorScheme = BLOB_COLOR_SCHEMES[profile.colorScheme];
    const nextBaseColor = new Color(colorScheme.baseColor);
    const nextEdgeColor = new Color(colorScheme.edgeColor);

    const transition = gsap.timeline({ defaults: { duration: 1.65, ease: "sine.inOut" } });
    transition.to(animatedValuesRef.current, {
      scale: profile.scale,
      shapeX: profile.shapeScale[0],
      shapeY: profile.shapeScale[1],
      shapeZ: profile.shapeScale[2],
      bloomIntensity: profile.bloomIntensity,
      noiseSpeed: profile.noiseSpeed,
      edgeBoost: profile.edgeBoost,
      amplitude: profile.amplitude,
      irregularity: profile.irregularity,
      innerFlow: profile.innerFlow
    });
    transition.to(baseColor, { r: nextBaseColor.r, g: nextBaseColor.g, b: nextBaseColor.b }, 0);
    transition.to(edgeColor, { r: nextEdgeColor.r, g: nextEdgeColor.g, b: nextEdgeColor.b }, 0);
    transition
      .to(animatedValuesRef.current, { transitionEnergy: 0.55, duration: 1.05, ease: "sine.inOut" }, 0)
      .to(animatedValuesRef.current, { transitionEnergy: 0, duration: 1.35, ease: "sine.inOut" }, 1.05);

    let speakingPulse: gsap.core.Tween | null = null;
    if (visualState === "speaking") {
      speakingPulse = gsap.to(animatedValuesRef.current, {
        audioLevel: 1,
        duration: 0.72,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true
      });
    } else {
      gsap.to(animatedValuesRef.current, { audioLevel: 0, duration: 0.5, ease: "sine.out" });
    }

    return () => {
      transition.kill();
      speakingPulse?.kill();
    };
  }, [baseColor, edgeColor, visualState]);

  return { animatedValuesRef, baseColor, edgeColor };
}
