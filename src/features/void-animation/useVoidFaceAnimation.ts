import type { MutableRefObject, RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { FaceState } from "../binary-face/binaryFaceField";

gsap.registerPlugin(useGSAP);

type Args = {
  /** 被逐帧渲染消费的面部状态对象 */
  stateRef: MutableRefObject<FaceState>;
  /** useGSAP 作用域容器 */
  scopeRef: RefObject<HTMLDivElement | null>;
  /** 承载呼吸、头部微转与浮现的 canvas 元素 */
  canvasRef: RefObject<HTMLCanvasElement | null>;
};

/**
 * VOID 空闲态动效。参考真实人类的静息行为：
 * - 呼吸：缓慢、连续、近正弦的极轻微起伏，只动 transform（不碰透明度/亮度）。
 * - 头部：低频、长停顿的小幅偏转与俯仰，像安静地微微转头，而非机械位移。
 * - 眨眼：快合(80ms)→短停→稍慢张开(130ms)的非对称曲线，偶发双眨，间隔随机。
 * - 视线：扫视(saccade)——快速跳到新落点后长时间凝视，间或规避后回到对视。
 * - 嘴部：基本闭合，偶尔极轻微开合，呼应呼吸节律。
 * 全部经 useGSAP 的 context 管理，卸载时自动清理。
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

      // 浮现：从黑暗中淡入一次，之后不再触碰透明度
      gsap.to(canvas, { autoAlpha: 1, duration: 2.8, ease: "power2.out" });

      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      if (prefersReducedMotion) {
        Object.assign(state, { blink: 0, gazeX: 0, gazeY: 0, mouthOpen: 0 });
        return;
      }

      // 呼吸：极轻微的纵向起伏 + 缩放，连续往返、缓入缓出（绝不碰透明度/亮度）
      gsap.to(canvas, {
        y: -5,
        scale: 1.007,
        duration: 4.6,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true
      });

      // 存在感漂移：极小幅度的横向位移，像“活着的存在体”轻微挪动，
      // 而不是整张图片在倾斜旋转。低频、长停顿。
      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "sine.inOut" } })
        .to(canvas, { x: "random(-7, 7)", duration: "random(4.0, 6.0)" })
        .to(canvas, { duration: "random(2.0, 3.5)" })
        .to(canvas, { x: 0, duration: "random(3.5, 5.0)" })
        .to(canvas, { duration: "random(2.0, 3.5)" });

      // 眨眼：快合(80ms)→稍慢张开(150ms)的非对称曲线，更接近真实眼睑回弹；
      // 偶发双眨；间隔随机。全程只改 state.blink → 眼区像素明暗变化。
      const blinkTl = gsap.timeline({ repeat: -1, repeatRefresh: true });
      blinkTl
        .to(state, { blink: 1, duration: 0.08, ease: "power2.in" })
        .to(state, { blink: 0, duration: 0.15, ease: "power2.out" });
      blinkTl.add(() => {
        // 约两成概率紧接一次双眨（自然的连续眨）
        if (Math.random() < 0.22) {
          gsap
            .timeline()
            .to(state, { blink: 1, duration: 0.07, ease: "power2.in" })
            .to(state, { blink: 0, duration: 0.13, ease: "power2.out" });
        }
      });
      blinkTl.to(state, { blink: 0, duration: "random(2.8, 6.8)" });

      // 视线：扫视(saccade)——快速跳到新落点后长凝视，间或规避后回到对视。
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

      // 微扫视(micro-saccade)：在大扫视之间叠加极小幅高频抖动，让眼神“活着”，
      // 不呆滞。幅度很小，仅让虹膜像素轻颤。
      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "power1.inOut" } })
        .to(state, {
          gazeX: "+=random(-0.07, 0.07)",
          gazeY: "+=random(-0.05, 0.05)",
          duration: 0.12
        })
        .to(state, { duration: "random(0.5, 1.4)" });

      // 嘴部：空闲以闭合为主，但穿插清晰可见的轻微开合（像轻吸气/抿唇/微启），
      // 让“活着”可被肉眼察觉。全部只改 state.mouthOpen → 唇区像素明暗变化。
      gsap
        .timeline({ repeat: -1, repeatRefresh: true, defaults: { ease: "sine.inOut" } })
        .to(state, { mouthOpen: 0.08, duration: 1.3 })
        .to(state, { mouthOpen: 0, duration: 1.6 })
        .to(state, { duration: "random(1.4, 2.8)" })
        .to(state, { mouthOpen: 0.2, duration: 0.5 }) // 偶尔明显微启
        .to(state, { mouthOpen: 0.04, duration: 0.9 })
        .to(state, { mouthOpen: 0, duration: 1.2 })
        .to(state, { duration: "random(2.6, 4.6)" });
    },
    { scope: scopeRef }
  );
}
