import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { EchoLightLine } from "./EchoLightLine";

gsap.registerPlugin(useGSAP);

type VoidResponseLayerProps = {
  isVisible: boolean;
  text: string;
  tone: "quiet" | "thinking" | "error";
  onExpand?: () => void;
};

export function VoidResponseLayer({ isVisible, text, tone, onExpand }: VoidResponseLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const canExpand = Boolean(onExpand && isVisible && text && tone === "quiet");

  useGSAP(() => {
    const layerElement = layerRef.current;
    if (!layerElement) {
      return;
    }

    if (!isVisible || !text) {
      gsap.to(layerElement, {
        autoAlpha: 0,
        y: 8,
        filter: "blur(5px)",
        duration: 0.48,
        ease: "power2.out",
        overwrite: "auto"
      });
      return;
    }

    gsap.fromTo(
      layerElement,
      { autoAlpha: 0, y: 10, filter: "blur(6px)" },
      { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.72, ease: "power2.out", overwrite: "auto" }
    );
  }, { dependencies: [isVisible, text, tone], scope: layerRef, revertOnUpdate: true });

  if (!text) {
    return null;
  }

  return (
    <section
      ref={layerRef}
      className={`void-response-layer void-response-layer--${tone}${canExpand ? " void-response-layer--expandable" : ""}`}
      aria-live={tone === "thinking" ? "polite" : "assertive"}
      aria-hidden={!isVisible}
      onClick={canExpand ? onExpand : undefined}
    >
      <p>{text}</p>
      <EchoLightLine pulseKey={`${tone}:${text}`} tone={tone} />
    </section>
  );
}
