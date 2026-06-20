import { useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { NormalBlending, ShaderMaterial } from "three";
import { echoLightLineFragmentShader, echoLightLineVertexShader } from "./echoLightLineShader";

type EchoLightLineProps = {
  pulseKey: string;
  tone: "quiet" | "thinking" | "error";
};

type EchoLightLineMeshProps = EchoLightLineProps;

function createEchoLightLineUniforms() {
  return {
    uTime: { value: 0 },
    uPulse: { value: 1 },
    uTone: { value: 0 },
    uAspect: { value: 1 }
  };
}

function EchoLightLineMesh({ pulseKey, tone }: EchoLightLineMeshProps) {
  const materialRef = useRef<ShaderMaterial | null>(null);
  const pulseStartRef = useRef(0);
  const lastPulseKeyRef = useRef(pulseKey);
  const uniforms = useMemo(() => createEchoLightLineUniforms(), []);
  const { size, viewport } = useThree();

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material) {
      return;
    }

    if (lastPulseKeyRef.current !== pulseKey) {
      lastPulseKeyRef.current = pulseKey;
      pulseStartRef.current = clock.elapsedTime;
    }

    const pulseAge = Math.min(Math.max((clock.elapsedTime - pulseStartRef.current) / 1.16, 0), 1);
    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uPulse.value = pulseAge;
    material.uniforms.uTone.value = tone === "error" ? 1 : 0;
    material.uniforms.uAspect.value = size.width / Math.max(size.height, 1);
  });

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={echoLightLineVertexShader}
        fragmentShader={echoLightLineFragmentShader}
        transparent
        blending={NormalBlending}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </mesh>
  );
}

export function EchoLightLine({ pulseKey, tone }: EchoLightLineProps) {
  return (
    <div className="echo-light-line" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 2.2], fov: 34, near: 0.1, far: 10 }}
        dpr={[1, 2]}
        gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        <EchoLightLineMesh pulseKey={pulseKey} tone={tone} />
      </Canvas>
    </div>
  );
}
