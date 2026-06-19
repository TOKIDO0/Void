import type { MutableRefObject, RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { FaceState } from "../binary-face/binaryFaceField";

gsap.registerPlugin(useGSAP);

type Args = {
  /** 被逐帧渲染消费的面部状态对象。 */
  stateRef: MutableRefObject<FaceState>;
  /** useGSAP 的作用域容器。 */
  scopeRef: RefObject<HTMLDivElement | null>;
  /** 承载 0/1 面部的 canvas 元素。 */
  canvasRef: RefObject<HTMLCanvasElement | null>;
};

/**
 * VOID 空闲态动效。
 * 头部动作只修改 FaceState，由渲染层转成面部数字明暗和采样变化。
 */
export function useVoidFaceAnimation({ stateRef, scopeRef, canvasRef }: Args) {
  useGSAP(
    () => {
      const state = stateRef.current;
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      gsap.set(canvas, { transformOrigin: "50% 45%", autoAlpha: 0 });
      gsap.to(canvas, { autoAlpha: 1, duration: 2.8, ease: "power2.out" });

      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      if (prefersReducedMotion) {
        Object.assign(state, {
          blink: 0,
          gazeX: 0,
          gazeY: 0,
          mouthOpen: 0,
          headTurn: 0,
          headNod: 0
        });
        return;
      }

      // 呼吸只保留轻微上下起伏，不参与“扭头”。
      gsap.to(canvas, {
        y: -5,
        scale: 1.007,
        duration: 4.6,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true
      });

      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "sine.inOut" } })
        .to(state, {
          headTurn: "random(-0.72, 0.72)",
          headNod: "random(-0.24, 0.22)",
          duration: "random(3.2, 5.2)"
        })
        .to(state, { duration: "random(1.0, 2.2)" })
        .to(state, { headTurn: 0, headNod: 0, duration: "random(2.4, 4.2)" })
        .to(state, { duration: "random(1.0, 2.0)" });

      const blinkTl = gsap.timeline({ repeat: -1, repeatRefresh: true });
      blinkTl
        .to(state, { blink: 1, duration: 0.08, ease: "power2.in" })
        .to(state, { blink: 0, duration: 0.15, ease: "power2.out" });
      blinkTl.add(() => {
        if (Math.random() < 0.22) {
          gsap
            .timeline()
            .to(state, { blink: 1, duration: 0.07, ease: "power2.in" })
            .to(state, { blink: 0, duration: 0.13, ease: "power2.out" });
        }
      });
      blinkTl.to(state, { blink: 0, duration: "random(2.8, 6.8)" });

      gsap
        .timeline({ repeat: -1, repeatRefresh: true })
        .to(state, {
          gazeX: "random(-0.5, 0.5)",
          gazeY: "random(-0.28, 0.26)",
          duration: 0.16,
          ease: "power3.out"
        })
        .to(state, { duration: "random(1.8, 3.6)" })
        .to(state, {
          gazeX: "random(-0.68, 0.68)",
          gazeY: "random(-0.24, 0.3)",
          duration: 0.14,
          ease: "power3.out"
        })
        .to(state, { duration: "random(1.1, 2.4)" })
        .to(state, { gazeX: 0, gazeY: 0, duration: 0.5, ease: "power2.inOut" })
        .to(state, { duration: "random(2.0, 3.4)" });

      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "power1.inOut" } })
        .to(state, {
          gazeX: "+=random(-0.07, 0.07)",
          gazeY: "+=random(-0.05, 0.05)",
          duration: 0.12
        })
        .to(state, { duration: "random(0.5, 1.4)" });

      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "sine.inOut" } })
        .to(state, { mouthOpen: 0.52, duration: 0.12 })
        .to(state, { mouthOpen: 0.16, duration: 0.09 })
        .to(state, { duration: "random(0.08, 0.22)" })
        .to(state, { mouthOpen: 0.68, duration: 0.1 })
        .to(state, { mouthOpen: 0.1, duration: 0.12 })
        .to(state, { mouthOpen: 0.42, duration: 0.08 })
        .to(state, { mouthOpen: 0, duration: 0.18 })
        .to(state, { duration: "random(1.8, 4.4)" });
    },
    { scope: scopeRef }
  );
}
