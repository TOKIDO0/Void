import { useCallback, useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import type { VoidConversationMessage } from "../agent/voidConversation";
import { ExpandedDialogueLine } from "./ExpandedDialogueLine";

gsap.registerPlugin(useGSAP);

type ExpandedResponseOverlayProps = {
  isOpen: boolean;
  messages: VoidConversationMessage[];
  onClose: () => void;
  onClosingChange: (isClosing: boolean) => void;
  onOpenProgressChange: (progress: number) => void;
};

export function ExpandedResponseOverlay({
  isOpen,
  messages,
  onClose,
  onClosingChange,
  onOpenProgressChange
}: ExpandedResponseOverlayProps) {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef({ value: 0 });

  const playClose = useCallback(() => {
    if (isClosing) {
      return;
    }

    setIsClosing(true);
    onClosingChange(true);
    const timeline = gsap.timeline({
      defaults: { ease: "power3.inOut" },
      onComplete: () => {
        progressRef.current.value = 0;
        onOpenProgressChange(0);
        setShouldRender(false);
        setIsClosing(false);
        onClosingChange(false);
        onClose();
      }
    });

    timeline
      .to(panelRef.current, { autoAlpha: 0, y: 16, scale: 0.965, filter: "blur(8px)", duration: 0.34 }, 0)
      .to(progressRef.current, {
        value: 0,
        duration: 0.78,
        onUpdate: () => onOpenProgressChange(progressRef.current.value)
      }, 0.06)
      .to(rootRef.current, { autoAlpha: 0, duration: 0.44 }, 0.26);
  }, [isClosing, onClose, onClosingChange, onOpenProgressChange]);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      onClosingChange(false);
    } else if (shouldRender) {
      playClose();
    }
  }, [isOpen, onClosingChange, playClose, shouldRender]);

  useEffect(() => {
    if (!shouldRender) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        playClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playClose, shouldRender]);

  useGSAP(() => {
    if (!shouldRender || !isOpen) {
      return;
    }

    gsap.set(rootRef.current, { autoAlpha: 0 });
    gsap.set(panelRef.current, { autoAlpha: 0, y: 28, scale: 0.94, filter: "blur(12px)" });
    gsap.set(".expanded-dialogue-line", { autoAlpha: 0, y: 18, filter: "blur(8px)" });
    progressRef.current.value = 0;
    onOpenProgressChange(0);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });

    timeline
      .to(rootRef.current, { autoAlpha: 1, duration: reduceMotion ? 0.01 : 0.28 }, 0)
      .to(progressRef.current, {
        value: 1,
        duration: reduceMotion ? 0.01 : 0.95,
        ease: "sine.inOut",
        onUpdate: () => onOpenProgressChange(progressRef.current.value)
      }, 0)
      .to(panelRef.current, {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        filter: "blur(0px)",
        duration: reduceMotion ? 0.01 : 0.62
      }, reduceMotion ? 0 : 0.44)
      .to(".expanded-dialogue-line", {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: reduceMotion ? 0.01 : 0.42,
        stagger: reduceMotion ? 0 : 0.045
      }, reduceMotion ? 0 : 0.64);

    return () => timeline.kill();
  }, { scope: rootRef, dependencies: [isOpen, shouldRender], revertOnUpdate: true });

  if (!shouldRender) {
    return null;
  }

  return (
    <section
      ref={rootRef}
      className="expanded-response-overlay"
      role="presentation"
      onMouseDown={playClose}
    >
      <div
        ref={panelRef}
        className="expanded-response-overlay__panel"
        aria-label="Session"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="expanded-response-overlay__mark">Session</div>
        <div className="expanded-response-overlay__messages">
          {messages.map((message, index) => (
            <ExpandedDialogueLine
              key={`${message.role}-${index}-${message.content.slice(0, 16)}`}
              message={message}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
