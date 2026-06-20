import { FormEvent, KeyboardEvent, MutableRefObject, useCallback, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { NormalBlending, ShaderMaterial } from "three";
import { luminousCapsuleFragmentShader, luminousCapsuleVertexShader } from "./luminousCapsuleShader";

gsap.registerPlugin(useGSAP);

type LuminousTextEntryProps = {
  disabled?: boolean;
  onSend: (message: string) => void | Promise<void>;
  onOpenModelConfig: () => void;
};

type LuminousCapsuleProps = {
  revealRef: MutableRefObject<number>;
  focusRef: MutableRefObject<number>;
  hasMessageRef: MutableRefObject<number>;
};

const MIN_VISIBLE_REVEAL = 0.08;
const BOTTOM_REVEAL_DISTANCE = 260;
const IDLE_ALPHA = 0.18;

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function createCapsuleUniforms() {
  return {
    uTime: { value: 0 },
    uReveal: { value: MIN_VISIBLE_REVEAL },
    uFocus: { value: 0 },
    uAspect: { value: 1 },
    uHasMessage: { value: 0 }
  };
}

function LuminousCapsule({ revealRef, focusRef, hasMessageRef }: LuminousCapsuleProps) {
  const materialRef = useRef<ShaderMaterial | null>(null);
  const uniforms = useMemo(() => createCapsuleUniforms(), []);
  const { size, viewport } = useThree();

  useFrame(({ clock }) => {
    const material = materialRef.current;
    if (!material) {
      return;
    }

    material.uniforms.uTime.value = clock.elapsedTime;
    material.uniforms.uReveal.value = revealRef.current;
    material.uniforms.uFocus.value = focusRef.current;
    material.uniforms.uHasMessage.value = hasMessageRef.current;
    material.uniforms.uAspect.value = size.width / Math.max(size.height, 1);
  });

  return (
    <mesh>
      <planeGeometry args={[viewport.width, viewport.height, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={luminousCapsuleVertexShader}
        fragmentShader={luminousCapsuleFragmentShader}
        transparent
        blending={NormalBlending}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
    </mesh>
  );
}

export function LuminousTextEntry({
  disabled = false,
  onSend,
  onOpenModelConfig
}: LuminousTextEntryProps) {
  const [inputValue, setInputValue] = useState("");
  const rootRef = useRef<HTMLFormElement | null>(null);
  const revealRef = useRef(MIN_VISIBLE_REVEAL);
  const focusRef = useRef(0);
  const hasMessageRef = useRef(0);
  const isPinnedRef = useRef(false);
  const isFocusedRef = useRef(false);
  const isHoveredRef = useRef(false);
  const lastPointerYRef = useRef<number | null>(null);
  const isSendingRef = useRef(false);

  const animatePresence = useCallback((targetReveal: number, targetFocus: number) => {
    gsap.to(revealRef, {
      current: targetReveal,
      duration: 0.72,
      ease: "power3.out",
      overwrite: "auto"
    });
    gsap.to(focusRef, {
      current: targetFocus,
      duration: 0.58,
      ease: "sine.out",
      overwrite: "auto"
    });
    if (!rootRef.current) {
      return;
    }

    gsap.to(rootRef.current, {
      autoAlpha: IDLE_ALPHA + targetReveal * (1 - IDLE_ALPHA),
      y: 18 - targetReveal * 18,
      scale: 0.982 + targetReveal * 0.018,
      duration: 0.72,
      ease: "power3.out",
      overwrite: "auto"
    });
  }, []);

  const updateRevealFromPointer = useCallback(
    (clientY: number) => {
      lastPointerYRef.current = clientY;
      if (isPinnedRef.current) {
        animatePresence(1, 1);
        return;
      }

      const distanceFromBottom = window.innerHeight - clientY;
      const proximity = clamp01(1 - distanceFromBottom / BOTTOM_REVEAL_DISTANCE);
      const easedReveal = MIN_VISIBLE_REVEAL + Math.pow(proximity, 1.65) * (1 - MIN_VISIBLE_REVEAL);
      animatePresence(easedReveal, 0);
    },
    [animatePresence]
  );

  useGSAP(
    () => {
      gsap.set(rootRef.current, {
        autoAlpha: IDLE_ALPHA,
        y: 18,
        scale: 0.982,
        transformOrigin: "50% 50%"
      });

      const handlePointerMove = (event: PointerEvent) => {
        updateRevealFromPointer(event.clientY);
      };

      const handlePointerLeave = () => {
        if (!isPinnedRef.current) {
          animatePresence(MIN_VISIBLE_REVEAL, 0);
        }
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerleave", handlePointerLeave);

      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerleave", handlePointerLeave);
      };
    },
    { scope: rootRef, dependencies: [animatePresence, updateRevealFromPointer] }
  );

  const pinOpen = useCallback(() => {
    isPinnedRef.current = true;
    animatePresence(1, 1);
  }, [animatePresence]);

  const releaseIfPossible = useCallback(() => {
    if (isFocusedRef.current || isHoveredRef.current) {
      return;
    }

    isPinnedRef.current = false;
    if (lastPointerYRef.current === null) {
      animatePresence(MIN_VISIBLE_REVEAL, 0);
      return;
    }

    updateRevealFromPointer(lastPointerYRef.current);
  }, [animatePresence, updateRevealFromPointer]);

  const submitMessage = useCallback(async () => {
    const trimmedMessage = inputValue.trim();
    if (!trimmedMessage || disabled || isSendingRef.current) {
      return;
    }

    isSendingRef.current = true;
    setInputValue("");
    hasMessageRef.current = 0;
    try {
      await onSend(trimmedMessage);
    } finally {
      isSendingRef.current = false;
    }
  }, [disabled, inputValue, onSend]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void submitMessage();
  };

  const handleInputChange = (nextValue: string) => {
    setInputValue(nextValue);
    hasMessageRef.current = nextValue.trim() ? 1 : 0;
  };

  const handleMouseEnter = () => {
    isHoveredRef.current = true;
    pinOpen();
  };

  const handleMouseLeave = () => {
    isHoveredRef.current = false;
    window.setTimeout(releaseIfPossible, 0);
  };

  const handleFocus = () => {
    isFocusedRef.current = true;
    pinOpen();
  };

  const handleBlur = () => {
    isFocusedRef.current = false;
    window.setTimeout(releaseIfPossible, 0);
  };

  return (
    <form
      ref={rootRef}
      className="luminous-text-entry"
      aria-label="VOID text input"
      onSubmit={handleSubmit}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="luminous-text-entry__optics" aria-hidden="true">
        <Canvas
          camera={{ position: [0, 0, 2.2], fov: 34, near: 0.1, far: 10 }}
          dpr={[1, 2]}
          gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0);
          }}
        >
          <LuminousCapsule revealRef={revealRef} focusRef={focusRef} hasMessageRef={hasMessageRef} />
        </Canvas>
      </div>

      <div className="luminous-text-entry__surface">
        <button
          className="luminous-text-entry__config"
          type="button"
          aria-label="Open model config"
          onClick={onOpenModelConfig}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        <input
          className="luminous-text-entry__input"
          value={inputValue}
          disabled={disabled}
          aria-label="Message"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => handleInputChange(event.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />
        <button
          className="luminous-text-entry__send"
          type="submit"
          aria-label="Send message"
          disabled={disabled || !inputValue.trim()}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
      </div>
    </form>
  );
}
