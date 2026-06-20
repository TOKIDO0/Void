import { useRef } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

type VoidResponseLayerProps = {
  text: string;
  tone: "quiet" | "thinking" | "error";
};

export function VoidResponseLayer({ text, tone }: VoidResponseLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!text) {
      return;
    }

    gsap.fromTo(
      layerRef.current,
      { autoAlpha: 0, y: 10, filter: "blur(6px)" },
      { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.72, ease: "power2.out" }
    );
  }, { dependencies: [text, tone], scope: layerRef, revertOnUpdate: true });

  if (!text) {
    return null;
  }

  return (
    <section
      ref={layerRef}
      className={`void-response-layer void-response-layer--${tone}`}
      aria-live={tone === "thinking" ? "polite" : "assertive"}
    >
      <p>{text}</p>
    </section>
  );
}
