import { Suspense } from "react";
import type { RefObject } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { VoidBlob } from "./VoidBlob";
import { BLOB_VISUAL_PROFILES } from "../void-state/voidVisualState";
import type { VoidVisualState } from "../void-state/voidVisualState";
import type { VisualProfileHint } from "../emotion/emotionToResponsePolicy";

export type PlaybackLevelSignal = {
  value: number;
  updatedAt: number;
};

type BlobSceneProps = {
  visualState: VoidVisualState;
  expandedResponseProgress: number;
  isExpandedResponseClosing: boolean;
  thinkingModePulseEventId: number;
  thinkingModePulseDirection: "on" | "off";
  emotionVisualHint: VisualProfileHint;
  /** 真实 TTS 播放电平（PCM 主路径约 10Hz 更新）；Blob fallback 不更新，视觉侧按超时回退模拟脉冲。 */
  playbackLevelSignal?: RefObject<PlaybackLevelSignal>;
};

export function BlobScene({
  visualState,
  expandedResponseProgress,
  isExpandedResponseClosing,
  thinkingModePulseEventId,
  thinkingModePulseDirection,
  emotionVisualHint,
  playbackLevelSignal
}: BlobSceneProps) {
  const bloomIntensity = BLOB_VISUAL_PROFILES[visualState].bloomIntensity;
  const expandedBloomLift = expandedResponseProgress * 1.15;

  return (
    <div className="blob-scene" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 36, near: 0.1, far: 20 }}
        dpr={[1, 2]}
        gl={{ antialias: false, alpha: false, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#000000"]} />
        <Suspense fallback={null}>
          <group position={[0, 0.08, 0]}>
            <VoidBlob
              visualState={visualState}
              expandedResponseProgress={expandedResponseProgress}
              isExpandedResponseClosing={isExpandedResponseClosing}
              thinkingModePulseEventId={thinkingModePulseEventId}
              thinkingModePulseDirection={thinkingModePulseDirection}
              emotionVisualHint={emotionVisualHint}
              playbackLevelSignal={playbackLevelSignal}
            />
          </group>
          <EffectComposer multisampling={0}>
            <Bloom intensity={bloomIntensity + expandedBloomLift} luminanceThreshold={0.2} luminanceSmoothing={0.12} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
