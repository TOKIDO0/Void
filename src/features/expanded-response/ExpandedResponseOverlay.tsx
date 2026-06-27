import { useCallback, useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Icon } from "@iconify/react";
import type { VoidConversationMessage } from "../agent/voidConversation";
import { ExpandedDialogueLine } from "./ExpandedDialogueLine";

gsap.registerPlugin(useGSAP);

type ExpandedResponseOverlayProps = {
  isOpen: boolean;
  messages: VoidConversationMessage[];
  onClose: () => void;
  onClosingChange: (isClosing: boolean) => void;
  onOpenProgressChange: (progress: number) => void;
  onRegenerateLatestUserMessage: (messageIndex: number, content: string) => Promise<void>;
};

export function ExpandedResponseOverlay({
  isOpen,
  messages,
  onClose,
  onClosingChange,
  onOpenProgressChange,
  onRegenerateLatestUserMessage
}: ExpandedResponseOverlayProps) {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [isScrollButtonVisible, setIsScrollButtonVisible] = useState(false);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [isRegenerating, setIsRegenerating] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const scrollButtonRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef({ value: 0 });
  const copyBubbleTimeoutRef = useRef(0);
  const latestUserMessageIndex = findLatestUserMessageIndex(messages);

  const updateScrollButtonVisibility = useCallback(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    const distanceToBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight;
    setIsScrollButtonVisible(distanceToBottom > 80);
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior) => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    messagesElement.scrollTo({
      top: messagesElement.scrollHeight,
      behavior
    });
  }, []);

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

  useEffect(() => {
    if (!shouldRender || !isOpen) {
      return;
    }

    window.requestAnimationFrame(() => {
      scrollMessagesToBottom("auto");
      updateScrollButtonVisibility();
    });
  }, [isOpen, messages, scrollMessagesToBottom, shouldRender, updateScrollButtonVisibility]);

  useEffect(() => {
    const buttonElement = scrollButtonRef.current;
    if (!buttonElement) {
      return;
    }

    gsap.to(buttonElement, {
      autoAlpha: isScrollButtonVisible ? 1 : 0,
      y: isScrollButtonVisible ? 0 : 10,
      scale: isScrollButtonVisible ? 1 : 0.96,
      filter: isScrollButtonVisible ? "blur(0px)" : "blur(8px)",
      duration: 0.26,
      ease: "power3.out",
      pointerEvents: isScrollButtonVisible ? "auto" : "none",
      overwrite: "auto"
    });
  }, [isScrollButtonVisible]);

  useEffect(() => {
    return () => window.clearTimeout(copyBubbleTimeoutRef.current);
  }, []);

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

  const handleCopyMessage = async (message: VoidConversationMessage, index: number) => {
    await navigator.clipboard.writeText(message.content);
    window.clearTimeout(copyBubbleTimeoutRef.current);
    setCopiedMessageIndex(index);
    copyBubbleTimeoutRef.current = window.setTimeout(() => {
      setCopiedMessageIndex(null);
    }, 1200);
  };

  const handleStartEdit = (index: number, content: string) => {
    setEditingMessageIndex(index);
    setEditingDraft(content);
  };

  const handleCancelEdit = () => {
    setEditingMessageIndex(null);
    setEditingDraft("");
  };

  const handleSubmitEdit = async (index: number, content: string) => {
    const trimmedContent = content.trim();
    if (!trimmedContent || isRegenerating) {
      return;
    }

    setIsRegenerating(true);
    try {
      await onRegenerateLatestUserMessage(index, trimmedContent);
      setEditingMessageIndex(null);
      setEditingDraft("");
      window.requestAnimationFrame(() => scrollMessagesToBottom("smooth"));
    } finally {
      setIsRegenerating(false);
    }
  };

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
        <div
          ref={messagesRef}
          className="expanded-response-overlay__messages"
          onScroll={updateScrollButtonVisibility}
        >
          {messages.map((message, index) => (
            <ExpandedDialogueLine
              key={`${message.role}-${index}`}
              message={message}
              index={index}
              canEdit={message.role === "user" && index === latestUserMessageIndex}
              copiedMessageIndex={copiedMessageIndex}
              editingMessageIndex={editingMessageIndex}
              editingDraft={editingDraft}
              isRegenerating={isRegenerating}
              onCopy={handleCopyMessage}
              onStartEdit={handleStartEdit}
              onCancelEdit={handleCancelEdit}
              onEditingDraftChange={setEditingDraft}
              onSubmitEdit={handleSubmitEdit}
            />
          ))}
        </div>
        <button
          ref={scrollButtonRef}
          className="expanded-response-overlay__scroll-bottom"
          type="button"
          aria-label="滚动到最新消息"
          onClick={() => scrollMessagesToBottom("smooth")}
        >
          <Icon icon="solar:alt-arrow-down-linear" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function findLatestUserMessageIndex(messages: VoidConversationMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }

  return -1;
}
