import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent,
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { NormalBlending, ShaderMaterial } from "three";
import { luminousCapsuleFragmentShader, luminousCapsuleVertexShader } from "./luminousCapsuleShader";
import type { VoidConversationAttachment } from "../agent/voidConversation";

gsap.registerPlugin(useGSAP);

type LuminousTextEntryProps = {
  disabled?: boolean;
  thinkingModeEnabled: boolean;
  onSend: (message: string, attachments: VoidConversationAttachment[]) => void | Promise<void>;
  onThinkingModeChange: (thinkingModeEnabled: boolean) => void;
  onOpenModelConfig: () => void;
  onOpenConversationHistory: () => void;
};

type LuminousCapsuleProps = {
  revealRef: MutableRefObject<number>;
  focusRef: MutableRefObject<number>;
  hasMessageRef: MutableRefObject<number>;
  bodyRatioRef: MutableRefObject<number>;
  heightRatioRef: MutableRefObject<number>;
  sendSweepRef: MutableRefObject<number>;
};

const MIN_VISIBLE_REVEAL = 0.08;
const BOTTOM_REVEAL_DISTANCE = 260;
const IDLE_ALPHA = 0.18;
const MIN_ENTRY_HEIGHT = 64;
const MAX_ENTRY_HEIGHT = 132;
const TEXT_LINE_HEIGHT = 20;
const MAX_VISIBLE_TEXT_LINES = 5;
const MAX_ATTACHMENT_COUNT = 4;
const MAX_ATTACHMENT_SIZE_BYTES = 64 * 1024;
const MAX_ATTACHMENT_TOTAL_CHARACTERS = 32000;
const SUPPORTED_TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".sh",
  ".yaml",
  ".yml"
]);

function clamp01(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function countWrappedLines(text: string, mirror: HTMLDivElement | null) {
  if (!text.trim() || !mirror) {
    return 1;
  }

  mirror.textContent = text.endsWith("\n") ? `${text} ` : text;
  return Math.max(Math.ceil(mirror.scrollHeight / TEXT_LINE_HEIGHT), 1);
}

function createCapsuleUniforms() {
  return {
    uTime: { value: 0 },
    uReveal: { value: MIN_VISIBLE_REVEAL },
    uFocus: { value: 0 },
    uAspect: { value: 1 },
    uBodyRatio: { value: 0.86 },
    uHeightRatio: { value: 1 },
    uHasMessage: { value: 0 },
    uSendSweep: { value: 0 }
  };
}

function LuminousCapsule({
  revealRef,
  focusRef,
  hasMessageRef,
  bodyRatioRef,
  heightRatioRef,
  sendSweepRef
}: LuminousCapsuleProps) {
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
    material.uniforms.uBodyRatio.value = bodyRatioRef.current;
    material.uniforms.uHeightRatio.value = heightRatioRef.current;
    material.uniforms.uSendSweep.value = sendSweepRef.current;
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
  thinkingModeEnabled,
  onSend,
  onThinkingModeChange,
  onOpenModelConfig,
  onOpenConversationHistory
}: LuminousTextEntryProps) {
  const [inputValue, setInputValue] = useState("");
  const rootRef = useRef<HTMLFormElement | null>(null);
  const opticsRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const textMeasureRef = useRef<HTMLDivElement | null>(null);
  const inputValueRef = useRef("");
  const revealRef = useRef(MIN_VISIBLE_REVEAL);
  const focusRef = useRef(0);
  const hasMessageRef = useRef(0);
  const bodyRatioRef = useRef(0.86);
  const heightRatioRef = useRef(1);
  const sendSweepRef = useRef(0);
  const entryHeightRef = useRef(MIN_ENTRY_HEIGHT);
  const isPinnedRef = useRef(false);
  const isFocusedRef = useRef(false);
  const isHoveredRef = useRef(false);
  const lastPointerYRef = useRef<number | null>(null);
  const isSendingRef = useRef(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<VoidConversationAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const syncOpticalBodyRatio = useCallback(() => {
    const rootWidth = rootRef.current?.getBoundingClientRect().width ?? 0;
    const opticsWidth = opticsRef.current?.getBoundingClientRect().width ?? 0;
    if (!rootWidth || !opticsWidth) {
      return;
    }

    bodyRatioRef.current = Math.min(Math.max(rootWidth / opticsWidth, 0.68), 0.96);
  }, []);

  const applyTextAreaMetrics = useCallback((currentHeight: number, visibleLines: number) => {
    const root = rootRef.current;
    const textArea = textAreaRef.current;
    if (!root || !textArea) {
      return;
    }

    const textHeight = Math.min(visibleLines, MAX_VISIBLE_TEXT_LINES) * TEXT_LINE_HEIGHT;
    const textOffset = Math.max((currentHeight - textHeight) / 2, 0);

    heightRatioRef.current = currentHeight / MIN_ENTRY_HEIGHT;
    root.style.setProperty("--entry-height", `${currentHeight}px`);
    textArea.style.height = `${textHeight}px`;
    textArea.style.marginTop = `${textOffset}px`;
  }, []);

  const animateEntryHeight = useCallback((nextHeight: number, visibleLines: number, duration = 0.36) => {
    gsap.to(entryHeightRef, {
      current: nextHeight,
      duration,
      ease: "power2.out",
      overwrite: "auto",
      onUpdate: () => {
        applyTextAreaMetrics(entryHeightRef.current, visibleLines);
      }
    });
  }, [applyTextAreaMetrics]);

  const syncEntryHeightForText = useCallback((text: string, duration = 0.36) => {
    const lineCount = countWrappedLines(text, textMeasureRef.current);
    const visibleLines = Math.min(Math.max(lineCount, 1), MAX_VISIBLE_TEXT_LINES);
    const nextHeight =
      visibleLines <= 1
        ? MIN_ENTRY_HEIGHT
        : Math.min(MIN_ENTRY_HEIGHT + (visibleLines - 1) * TEXT_LINE_HEIGHT, MAX_ENTRY_HEIGHT);

    animateEntryHeight(nextHeight, visibleLines, duration);
  }, [animateEntryHeight]);

  useEffect(() => {
    syncEntryHeightForText(inputValue, 0.24);
  }, [inputValue, syncEntryHeightForText]);

  useGSAP(
    () => {
      gsap.set(rootRef.current, {
        autoAlpha: IDLE_ALPHA,
        y: 18,
        scale: 0.982,
        transformOrigin: "50% 50%"
      });
      applyTextAreaMetrics(MIN_ENTRY_HEIGHT, 1);

      const handlePointerMove = (event: PointerEvent) => {
        updateRevealFromPointer(event.clientY);
      };

      const handlePointerLeave = () => {
        if (!isPinnedRef.current) {
          animatePresence(MIN_VISIBLE_REVEAL, 0);
        }
      };

      const handleResize = () => {
        syncOpticalBodyRatio();
        syncEntryHeightForText(inputValueRef.current, 0.2);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerleave", handlePointerLeave);
      window.addEventListener("resize", handleResize);
      syncOpticalBodyRatio();

      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerleave", handlePointerLeave);
        window.removeEventListener("resize", handleResize);
      };
    },
    { scope: rootRef, dependencies: [animatePresence, applyTextAreaMetrics, syncEntryHeightForText, syncOpticalBodyRatio, updateRevealFromPointer] }
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

  const resetEntryContent = useCallback(() => {
    inputValueRef.current = "";
    setInputValue("");
    hasMessageRef.current = 0;
    setAttachments([]);
    setAttachmentError("");
  }, []);

  const submitMessage = useCallback(async () => {
    const trimmedMessage = inputValue.trim();
    if ((!trimmedMessage && !attachments.length) || disabled || isSendingRef.current) {
      return;
    }

    isSendingRef.current = true;
    resetEntryContent();
    gsap.fromTo(
      sendSweepRef,
      { current: 0 },
      {
        current: 1,
        duration: 0.92,
        ease: "power2.inOut",
        overwrite: true,
        onComplete: () => {
          sendSweepRef.current = 0;
        }
      }
    );
    try {
      await onSend(trimmedMessage, attachments);
    } finally {
      isSendingRef.current = false;
    }
  }, [attachments, disabled, inputValue, onSend, resetEntryContent]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    if (event.shiftKey) {
      return;
    }

    event.preventDefault();
    void submitMessage();
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    inputValueRef.current = nextValue;
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

  const handleAgentMenuToggle = () => {
    setIsAgentMenuOpen((currentIsOpen) => !currentIsOpen);
    pinOpen();
  };

  const handleAgentActionClick = (action: "thinking" | "upload" | "history" | "settings") => {
    pinOpen();
    if (action === "thinking") {
      onThinkingModeChange(!thinkingModeEnabled);
      return;
    }

    if (action === "history") {
      setIsAgentMenuOpen(false);
      onOpenConversationHistory();
    }

    if (action === "settings") {
      setIsAgentMenuOpen(false);
      onOpenModelConfig();
    }

    if (action === "upload") {
      setIsAgentMenuOpen(false);
      fileInputRef.current?.click();
    }
  };

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((currentAttachments) => currentAttachments.filter((attachment) => attachment.id !== attachmentId));
  }, []);

  const appendFiles = useCallback(async (incomingFiles: FileList | File[]) => {
    const selectedFiles = Array.from(incomingFiles);
    if (!selectedFiles.length) {
      return;
    }

    const nextAttachments: VoidConversationAttachment[] = [];
    let totalCharacters = attachments.reduce((sum, attachment) => sum + attachment.content.length, 0);

    for (const file of selectedFiles) {
      if (attachments.length + nextAttachments.length >= MAX_ATTACHMENT_COUNT) {
        setAttachmentError(`最多只能附加 ${MAX_ATTACHMENT_COUNT} 个文件。`);
        break;
      }

      const extension = resolveFileExtension(file.name);
      if (!SUPPORTED_TEXT_FILE_EXTENSIONS.has(extension)) {
        setAttachmentError("当前阶段只支持文本类文件。");
        continue;
      }

      if (file.size <= 0) {
        setAttachmentError("不能附加空文件。");
        continue;
      }

      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setAttachmentError("单个文件过大，当前阶段请控制在 64KB 以内。");
        continue;
      }

      try {
        const content = (await file.text()).trim();
        if (!content) {
          setAttachmentError("不能附加空文件。");
          continue;
        }

        totalCharacters += content.length;
        if (totalCharacters > MAX_ATTACHMENT_TOTAL_CHARACTERS) {
          setAttachmentError("本轮附加文件总内容过长，请减少文件数量或内容长度。");
          break;
        }

        nextAttachments.push({
          id: buildAttachmentId(file),
          name: file.name,
          mimeType: file.type || "text/plain",
          content
        });
      } catch {
        setAttachmentError("文件读取失败，请重新选择文件。");
      }
    }

    if (nextAttachments.length) {
      setAttachmentError("");
      setAttachments((currentAttachments) => [...currentAttachments, ...nextAttachments]);
    }
  }, [attachments]);

  const handleFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles?.length) {
      return;
    }

    await appendFiles(selectedFiles);
    event.target.value = "";
  };

  useEffect(() => {
    if (!isAgentMenuOpen) {
      return;
    }

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const rootElement = rootRef.current;
      if (!rootElement || rootElement.contains(event.target as Node)) {
        return;
      }

      setIsAgentMenuOpen(false);
      releaseIfPossible();
    };

    window.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => window.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [isAgentMenuOpen, releaseIfPossible]);

  return (
    <form
      ref={rootRef}
      className="luminous-text-entry"
      aria-label="VOID text input"
      onSubmit={handleSubmit}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void appendFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept={Array.from(SUPPORTED_TEXT_FILE_EXTENSIONS).join(",")}
        onChange={handleFileInputChange}
      />
      <div ref={opticsRef} className="luminous-text-entry__optics" aria-hidden="true">
        <Canvas
          camera={{ position: [0, 0, 2.2], fov: 34, near: 0.1, far: 10 }}
          dpr={[1, 2]}
          gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0);
            window.requestAnimationFrame(syncOpticalBodyRatio);
          }}
        >
          <LuminousCapsule
            revealRef={revealRef}
            focusRef={focusRef}
            hasMessageRef={hasMessageRef}
            bodyRatioRef={bodyRatioRef}
            heightRatioRef={heightRatioRef}
            sendSweepRef={sendSweepRef}
          />
        </Canvas>
      </div>

      <div className="luminous-text-entry__surface">
        <button
          className="luminous-text-entry__config"
          type="button"
          aria-label="Open agent actions"
          aria-expanded={isAgentMenuOpen}
          onClick={handleAgentMenuToggle}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {isAgentMenuOpen ? (
          <div className="luminous-text-entry__agent-menu" onMouseDown={(event) => event.preventDefault()}>
            <button
              type="button"
              className={thinkingModeEnabled ? "is-active" : undefined}
              aria-pressed={thinkingModeEnabled}
              onClick={() => handleAgentActionClick("thinking")}
            >
              {thinkingModeEnabled ? "Thinking on" : "Thinking off"}
            </button>
            <button type="button" onClick={() => handleAgentActionClick("upload")}>
              Upload file
            </button>
            <button type="button" onClick={() => handleAgentActionClick("history")}>
              History
            </button>
            <button type="button" onClick={() => handleAgentActionClick("settings")}>
              Settings
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="luminous-text-entry__attachments">
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                className="luminous-text-entry__attachment-pill"
                onClick={() => removeAttachment(attachment.id)}
              >
                {attachment.name}
              </button>
            ))}
          </div>
        ) : null}
        {attachmentError ? <div className="luminous-text-entry__attachment-error">{attachmentError}</div> : null}
        <textarea
          ref={textAreaRef}
          className="luminous-text-entry__input"
          value={inputValue}
          disabled={disabled}
          aria-label="Message"
          autoComplete="off"
          spellCheck={false}
          rows={1}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
        />
        <div ref={textMeasureRef} className="luminous-text-entry__measure" aria-hidden="true" />
        <button
          className="luminous-text-entry__send"
          type="submit"
          aria-label="Send message"
          disabled={disabled || (!inputValue.trim() && !attachments.length)}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
      </div>
    </form>
  );
}

function resolveFileExtension(fileName: string) {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex < 0) {
    return "";
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}

function buildAttachmentId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}
