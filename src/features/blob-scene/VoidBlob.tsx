import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Mesh, ShaderMaterial } from "three";
import { blobFragmentShader, blobVertexShader, createBlobUniforms } from "./blobShader";
import { useBlobStateAnimation } from "./useBlobStateAnimation";
import type { VoidVisualState } from "../void-state/voidVisualState";
import type { VisualProfileHint } from "../emotion/emotionToResponsePolicy";

type VoidBlobProps = {
  visualState: VoidVisualState;
  expandedResponseProgress: number;
  isExpandedResponseClosing: boolean;
  thinkingModePulseEventId: number;
  thinkingModePulseDirection: "on" | "off";
  emotionVisualHint: VisualProfileHint;
};

const THINKING_MODE_PULSE_DURATION_MS = 860;
// 情绪视觉偏移的安全区间：乘性系数 clamp 到 [0.6, 1.4]，防止极端情绪把形变推出可视稳定范围。
const EMOTION_VISUAL_SCALE_MIN = 0.6;
const EMOTION_VISUAL_SCALE_MAX = 1.4;

function clampVisualScale(scale: number) {
  return Math.min(EMOTION_VISUAL_SCALE_MAX, Math.max(EMOTION_VISUAL_SCALE_MIN, scale));
}

export function VoidBlob({
  visualState,
  expandedResponseProgress,
  isExpandedResponseClosing,
  thinkingModePulseEventId,
  thinkingModePulseDirection,
  emotionVisualHint
}: VoidBlobProps) {
  const meshRef = useRef<Mesh | null>(null);
  const materialRef = useRef<ShaderMaterial | null>(null);
  const baseScaleRef = useRef(0.9);
  const closingSuppressionRef = useRef(0);
  const pulseStartTimeRef = useRef(0);
  const pulseProgressRef = useRef(1);
  const pulseDirectionRef = useRef<0 | 1>(0);
  const uniforms = useMemo(() => createBlobUniforms(), []);
  const { camera } = useThree();
  const { animatedValuesRef, baseColor, edgeColor } = useBlobStateAnimation(visualState);

  useEffect(() => {
    if (!thinkingModePulseEventId) {
      return;
    }

    pulseStartTimeRef.current = performance.now();
    pulseProgressRef.current = 0;
    pulseDirectionRef.current = thinkingModePulseDirection === "on" ? 1 : 0;
  }, [thinkingModePulseDirection, thinkingModePulseEventId]);

  useFrame(({ clock }, delta) => {
    const material = materialRef.current;
    const mesh = meshRef.current;
    if (!material || !mesh) {
      return;
    }

    const animatedValues = animatedValuesRef.current;
    const closingTarget = isExpandedResponseClosing ? 1 : 0;
    const closingEaseSpeed = isExpandedResponseClosing ? 18 : 10;
    closingSuppressionRef.current +=
      (closingTarget - closingSuppressionRef.current) * Math.min(delta * closingEaseSpeed, 1);
    const speakingLift = animatedValues.audioLevel * 0.42;
    const breath = Math.sin(clock.elapsedTime * ((Math.PI * 2) / 3)) * 0.018;
    const transitionLift = animatedValues.transitionEnergy * 0.006;
    const pulseElapsed = performance.now() - pulseStartTimeRef.current;
    const rawPulseProgress = Math.min(Math.max(pulseElapsed / THINKING_MODE_PULSE_DURATION_MS, 0), 1);
    const pulseVisibility = Math.sin(rawPulseProgress * Math.PI);
    const expandedPulseSuppression = expandedResponseProgress > 0.08
      ? Math.max(0.22, 1 - expandedResponseProgress * 1.35)
      : 1;
    const pulseStrength = pulseVisibility * expandedPulseSuppression;
    pulseProgressRef.current = rawPulseProgress;
    const targetScale = animatedValues.scale + breath + animatedValues.audioLevel * 0.025 + transitionLift;
    const nextScale = baseScaleRef.current + (targetScale - baseScaleRef.current) * Math.min(delta * 4, 1);

    baseScaleRef.current = nextScale;
    mesh.scale.set(
      nextScale * animatedValues.shapeX,
      nextScale * animatedValues.shapeY,
      nextScale * animatedValues.shapeZ
    );
    mesh.rotation.y += delta * 0.08;
    mesh.rotation.x = Math.sin(clock.elapsedTime * 0.22) * 0.04;

    // 情绪视觉偏移：对基础 profile 的三项形变做 clamp 后的乘性叠加（情绪是正交维度，不新增 visual state）
    const emotionAmplitudeScale = clampVisualScale(emotionVisualHint.amplitudeScale);
    const emotionNoiseSpeedScale = clampVisualScale(emotionVisualHint.noiseSpeedScale);
    const emotionEdgeBoostScale = clampVisualScale(emotionVisualHint.edgeBoostScale);

    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uAmplitude.value =
      (animatedValues.amplitude + animatedValues.audioLevel * 0.025 + animatedValues.transitionEnergy * 0.035)
      * emotionAmplitudeScale;
    material.uniforms.uNoiseSpeed.value =
      (animatedValues.noiseSpeed + animatedValues.transitionEnergy * 0.035) * emotionNoiseSpeedScale;
    material.uniforms.uEdgeBoost.value = (animatedValues.edgeBoost + speakingLift) * emotionEdgeBoostScale;
    material.uniforms.uInternalFlow.value = animatedValues.innerFlow;
    material.uniforms.uIrregularity.value = animatedValues.irregularity;
    material.uniforms.uTransitionEnergy.value = animatedValues.transitionEnergy;
    material.uniforms.uExpandedResponse.value = expandedResponseProgress;
    material.uniforms.uExpandedResponseClosing.value = closingSuppressionRef.current;
    material.uniforms.uThinkingModePulseProgress.value = pulseProgressRef.current;
    material.uniforms.uThinkingModePulseStrength.value = pulseStrength;
    material.uniforms.uThinkingModePulseDirection.value = pulseDirectionRef.current;
    material.uniforms.uBaseColor.value.copy(baseColor);
    material.uniforms.uEdgeColor.value.copy(edgeColor);
    material.uniforms.uViewPosition.value.copy(camera.position);
  });

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[1.16, 100]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={blobVertexShader}
        fragmentShader={blobFragmentShader}
        transparent
        depthWrite={false}
      />
    </mesh>
  );
}
