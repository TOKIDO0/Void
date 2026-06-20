import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Mesh, ShaderMaterial } from "three";
import { blobFragmentShader, blobVertexShader, createBlobUniforms } from "./blobShader";
import { useBlobStateAnimation } from "./useBlobStateAnimation";
import type { VoidVisualState } from "../void-state/voidVisualState";

type VoidBlobProps = {
  visualState: VoidVisualState;
  expandedResponseProgress: number;
  isExpandedResponseClosing: boolean;
};

export function VoidBlob({ visualState, expandedResponseProgress, isExpandedResponseClosing }: VoidBlobProps) {
  const meshRef = useRef<Mesh | null>(null);
  const materialRef = useRef<ShaderMaterial | null>(null);
  const baseScaleRef = useRef(0.9);
  const closingSuppressionRef = useRef(0);
  const uniforms = useMemo(() => createBlobUniforms(), []);
  const { camera } = useThree();
  const { animatedValuesRef, baseColor, edgeColor } = useBlobStateAnimation(visualState);

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

    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uAmplitude.value =
      animatedValues.amplitude + animatedValues.audioLevel * 0.025 + animatedValues.transitionEnergy * 0.035;
    material.uniforms.uNoiseSpeed.value = animatedValues.noiseSpeed + animatedValues.transitionEnergy * 0.035;
    material.uniforms.uEdgeBoost.value = animatedValues.edgeBoost + speakingLift;
    material.uniforms.uInternalFlow.value = animatedValues.innerFlow;
    material.uniforms.uIrregularity.value = animatedValues.irregularity;
    material.uniforms.uTransitionEnergy.value = animatedValues.transitionEnergy;
    material.uniforms.uExpandedResponse.value = expandedResponseProgress;
    material.uniforms.uExpandedResponseClosing.value = closingSuppressionRef.current;
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
