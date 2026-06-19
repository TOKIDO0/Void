import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { VoidBlob } from "./VoidBlob";
import { BLOB_VISUAL_PROFILES } from "../void-state/voidVisualState";
import type { VoidVisualState } from "../void-state/voidVisualState";

type BlobSceneProps = {
  visualState: VoidVisualState;
};

export function BlobScene({ visualState }: BlobSceneProps) {
  const bloomIntensity = BLOB_VISUAL_PROFILES[visualState].bloomIntensity;

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
            <VoidBlob visualState={visualState} />
          </group>
          <EffectComposer multisampling={0}>
            <Bloom intensity={bloomIntensity} luminanceThreshold={0.22} luminanceSmoothing={0.12} />
          </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
}
