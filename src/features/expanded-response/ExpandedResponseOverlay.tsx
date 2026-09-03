import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Icon } from "@iconify/react";
import type { VoidConversationMessage } from "../agent/voidConversation";
import { stripStageDirections } from "../agent/responseTextDisplay";
import { ExpandedDialogueLine } from "./ExpandedDialogueLine";
import { ContextBudgetBar } from "../agent/context/ContextBudgetBar";

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
  // 关闭进行中的守卫用 ref 而非 state：它不参与渲染，且必须让 playClose 保持稳定引用，
  // 否则会被关闭动画每帧的父组件重渲染卷入重入，导致模态框关闭后"还魂"。
  const isClosingRef = useRef(false);
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
  const shouldStickToBottomRef = useRef(true);
  const latestUserMessageIndex = findLatestUserMessageIndex(messages);

  const updateScrollButtonVisibility = useCallback(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    const distanceToBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight;
    shouldStickToBottomRef.current = distanceToBottom <= 80;
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
    if (isClosingRef.current) {
      return;
    }

    isClosingRef.current = true;
    onClosingChange(true);
    const timeline = gsap.timeline({
      defaults: { ease: "power3.inOut" },
      onComplete: () => {
        progressRef.current.value = 0;
        onOpenProgressChange(0);
        setShouldRender(false);
        isClosingRef.current = false;
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
  }, [onClose, onClosingChange, onOpenProgressChange]);

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      isClosingRef.current = false;
      shouldStickToBottomRef.current = true;
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

  // P0 首帧直达：打开瞬间同步定位到底部（layout 前），零动画；本地数据无需等 RAF。
  // 勿改回 requestAnimationFrame + smooth，否则大消息量会先白后从顶滚到底。
  useLayoutEffect(() => {
    if (!shouldRender || !isOpen) {
      return;
    }

    const messagesElement = messagesRef.current;
    if (messagesElement && shouldStickToBottomRef.current) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
    updateScrollButtonVisibility();
  }, [isOpen, messages, shouldRender, updateScrollButtonVisibility]);

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
      // P0 首帧直达：消息行取消 stagger 逐行播（大消息量会从顶滚到底），首帧即全量可见。
      .to(".expanded-dialogue-line", {
        autoAlpha: 1,
        y: 0,
        filter: "blur(0px)",
        duration: 0.01,
        stagger: 0
      }, 0);

    return () => timeline.kill();
  }, { scope: rootRef, dependencies: [isOpen, shouldRender], revertOnUpdate: true });

  if (!shouldRender) {
    return null;
  }

  const handleCopyMessage = async (message: VoidConversationMessage, index: number) => {
    // assistant 消息复制时同样剥离括号旁白，与显示层保持一致；用户消息原样复制
    const copyText = message.role === "assistant"
      ? stripStageDirections(message.content)
      : message.content;
    await navigator.clipboard.writeText(copyText);
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
        <ContextBudgetBar messages={messages} />
        <div
          ref={messagesRef}
          className="expanded-response-overlay__messages"
          onScroll={updateScrollButtonVisibility}
        >
          {messages.map((message, index) => (
            <ExpandedDialogueLine
              key={`${index}-${message.role}`}
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
