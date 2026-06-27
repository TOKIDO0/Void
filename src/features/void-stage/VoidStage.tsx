import { useCallback, useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { BlobScene } from "../blob-scene/BlobScene";
import {
  loadCurrentConversationHistory,
  saveCurrentConversationHistory,
  sendVoidMessage,
  type VoidConversationMessage
} from "../agent/voidConversation";
import { ExpandedResponseOverlay } from "../expanded-response/ExpandedResponseOverlay";
import { loadModelConfig } from "../settings/modelConfig";
import { ModelSettingsModal } from "../settings/ModelSettingsModal";
import { VoidResponseLayer } from "../response-layer/VoidResponseLayer";
import { LuminousTextEntry } from "../text-entry/LuminousTextEntry";
import { VOID_VISUAL_STATE_BY_KEY, type VoidVisualState } from "../void-state/voidVisualState";
import { useMicrophoneVoiceActivity } from "../voice/useMicrophoneVoiceActivity";

type ResponseLayerTone = "quiet" | "thinking" | "error";
type ResponseLayerSource = "text" | "voice-transcript" | "voice-reply";

type ResponseLayerState = {
  isVisible: boolean;
  text: string;
  tone: ResponseLayerTone;
  source: ResponseLayerSource;
};

const RESPONSE_LAYER_IDLE_HIDE_MS = 32000;
const TEXT_SPEAKING_PREVIEW_MS = 1800;
const MODEL_CONNECTION_FALLBACK_ERROR = "模型连接失败，请检查配置。";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [isExpandedResponseOpen, setIsExpandedResponseOpen] = useState(false);
  const [isExpandedResponseClosing, setIsExpandedResponseClosing] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<VoidConversationMessage[]>(() => loadCurrentConversationHistory());
  const [expandedResponseProgress, setExpandedResponseProgress] = useState(0);
  const [responseLayer, setResponseLayer] = useState<ResponseLayerState>({
    isVisible: false,
    text: "",
    tone: "quiet",
    source: "text"
  });
  const conversationHistoryRef = useRef<VoidConversationMessage[]>(conversationHistory);
  const textExchangeActiveRef = useRef(false);
  const speakingTimeoutRef = useRef(0);
  const responseLayerHideTimeoutRef = useRef(0);
  const expandedProgressRafRef = useRef(0);
  const expandedResponseProgressRef = useRef({ value: 0 });

  const setExpandedProgress = useCallback((progress: number) => {
    expandedResponseProgressRef.current.value = progress;
    if (expandedProgressRafRef.current) {
      return;
    }

    expandedProgressRafRef.current = window.requestAnimationFrame(() => {
      expandedProgressRafRef.current = 0;
      setExpandedResponseProgress(expandedResponseProgressRef.current.value);
    });
  }, []);

  const syncConversationHistory = useCallback((nextConversationHistory: VoidConversationMessage[]) => {
    conversationHistoryRef.current = nextConversationHistory;
    setConversationHistory(nextConversationHistory);
  }, []);

  const commitConversationHistory = useCallback((nextConversationHistory: VoidConversationMessage[]) => {
    syncConversationHistory(nextConversationHistory);
    saveCurrentConversationHistory(nextConversationHistory);
  }, [syncConversationHistory]);

  const clearResponseLayerHideTimer = useCallback(() => {
    window.clearTimeout(responseLayerHideTimeoutRef.current);
  }, []);

  const hideResponseLayer = useCallback(() => {
    clearResponseLayerHideTimer();
    setResponseLayer((currentLayer) => ({
      ...currentLayer,
      isVisible: false
    }));
  }, [clearResponseLayerHideTimer]);

  const scheduleResponseLayerHide = useCallback((delayMs = RESPONSE_LAYER_IDLE_HIDE_MS) => {
    clearResponseLayerHideTimer();
    responseLayerHideTimeoutRef.current = window.setTimeout(() => {
      setResponseLayer((currentLayer) => ({
        ...currentLayer,
        isVisible: false
      }));
    }, delayMs);
  }, [clearResponseLayerHideTimer]);

  const showResponseLayer = useCallback((nextLayer: Omit<ResponseLayerState, "isVisible">) => {
    clearResponseLayerHideTimer();
    setResponseLayer({
      ...nextLayer,
      isVisible: true
    });
  }, [clearResponseLayerHideTimer]);

  const requestVoidResponse = useCallback((
    message: string,
    history: VoidConversationMessage[],
    onStreamContent?: (content: string) => void
  ) => {
    const modelConfig = loadModelConfig();
    const canStream = modelConfig.streamEnabled && modelConfig.provider === "openai-compatible";
    let streamedContent = "";

    return sendVoidMessage(message, history, {
      ...modelConfig,
      streamEnabled: canStream
    }, canStream
      ? (token) => {
        streamedContent += token;
        onStreamContent?.(streamedContent);
        showResponseLayer({
          text: streamedContent,
          tone: "quiet",
          source: "text"
        });
      }
      : undefined);
  }, [showResponseLayer]);

  useMicrophoneVoiceActivity({
    onVisualStateChange: (nextVisualState) => {
      if (textExchangeActiveRef.current || isExpandedResponseOpen) {
        return;
      }

      if (nextVisualState === "listening") {
        hideResponseLayer();
      }
      setVisualState(nextVisualState);
    }
  });

  const openExpandedResponse = useCallback(() => {
    if (!conversationHistoryRef.current.length) {
      return;
    }

    clearResponseLayerHideTimer();
    setConversationHistory([...conversationHistoryRef.current]);
    setIsExpandedResponseOpen(true);
  }, [clearResponseLayerHideTimer]);

  const handleTextMessage = useCallback(async (message: string) => {
    textExchangeActiveRef.current = true;
    window.clearTimeout(speakingTimeoutRef.current);
    showResponseLayer({
      text: "正在思考。",
      tone: "thinking",
      source: "text"
    });
    setVisualState("thinking");

    const previousHistory = conversationHistoryRef.current;
    const assistantMessageIndex = previousHistory.length + 1;
    const pendingConversationHistory: VoidConversationMessage[] = [
      ...previousHistory,
      { role: "user", content: message },
      { role: "assistant", content: "" }
    ];

    try {
      syncConversationHistory(pendingConversationHistory);

      const syncStreamingAssistantMessage = (content: string) => {
        const nextConversationHistory = [...pendingConversationHistory];
        nextConversationHistory[assistantMessageIndex] = { role: "assistant", content };
        syncConversationHistory(nextConversationHistory);
      };

      const assistantResponse = await requestVoidResponse(message, previousHistory, syncStreamingAssistantMessage);
      const finalConversationHistory = [...pendingConversationHistory];
      finalConversationHistory[assistantMessageIndex] = { role: "assistant", content: assistantResponse.content };
      commitConversationHistory(finalConversationHistory);

      showResponseLayer({
        text: assistantResponse.content,
        tone: "quiet",
        source: "text"
      });
      scheduleResponseLayerHide();
      setVisualState("speaking");
      speakingTimeoutRef.current = window.setTimeout(() => {
        if (textExchangeActiveRef.current) {
          textExchangeActiveRef.current = false;
          setVisualState("idle");
        }
      }, TEXT_SPEAKING_PREVIEW_MS);
    } catch (error) {
      textExchangeActiveRef.current = false;
      const errorMessage = error instanceof Error ? error.message : MODEL_CONNECTION_FALLBACK_ERROR;
      const failedConversationHistory = [...pendingConversationHistory];
      failedConversationHistory[assistantMessageIndex] = { role: "assistant", content: errorMessage };
      commitConversationHistory(failedConversationHistory);
      showResponseLayer({
        text: errorMessage,
        tone: "error",
        source: "text"
      });
      scheduleResponseLayerHide(14000);
      setVisualState("idle");
    }
  }, [commitConversationHistory, requestVoidResponse, scheduleResponseLayerHide, showResponseLayer, syncConversationHistory]);

  const handleRegenerateLatestUserMessage = useCallback(async (messageIndex: number, content: string) => {
    const currentHistory = conversationHistoryRef.current;
    const targetMessage = currentHistory[messageIndex];

    if (!targetMessage || targetMessage.role !== "user") {
      return;
    }

    textExchangeActiveRef.current = true;
    window.clearTimeout(speakingTimeoutRef.current);
    setVisualState("thinking");
    showResponseLayer({
      text: "正在重新思考。",
      tone: "thinking",
      source: "text"
    });

    const historyBeforeEditedMessage = currentHistory.slice(0, messageIndex);
    const assistantMessageIndex = historyBeforeEditedMessage.length + 1;
    const pendingConversationHistory: VoidConversationMessage[] = [
      ...historyBeforeEditedMessage,
      { role: "user", content },
      { role: "assistant", content: "" }
    ];

    try {
      syncConversationHistory(pendingConversationHistory);

      const syncStreamingAssistantMessage = (streamedContent: string) => {
        const nextConversationHistory = [...pendingConversationHistory];
        nextConversationHistory[assistantMessageIndex] = { role: "assistant", content: streamedContent };
        syncConversationHistory(nextConversationHistory);
      };

      const assistantResponse = await requestVoidResponse(content, historyBeforeEditedMessage, syncStreamingAssistantMessage);
      const finalConversationHistory = [...pendingConversationHistory];
      finalConversationHistory[assistantMessageIndex] = { role: "assistant", content: assistantResponse.content };
      commitConversationHistory(finalConversationHistory);

      showResponseLayer({
        text: assistantResponse.content,
        tone: "quiet",
        source: "text"
      });
      scheduleResponseLayerHide();
      setVisualState("speaking");
      speakingTimeoutRef.current = window.setTimeout(() => {
        if (textExchangeActiveRef.current) {
          textExchangeActiveRef.current = false;
          setVisualState("idle");
        }
      }, TEXT_SPEAKING_PREVIEW_MS);
    } catch (error) {
      textExchangeActiveRef.current = false;
      const errorMessage = error instanceof Error ? error.message : MODEL_CONNECTION_FALLBACK_ERROR;
      const failedConversationHistory = [...pendingConversationHistory];
      failedConversationHistory[assistantMessageIndex] = { role: "assistant", content: errorMessage };
      commitConversationHistory(failedConversationHistory);
      showResponseLayer({
        text: errorMessage,
        tone: "error",
        source: "text"
      });
      scheduleResponseLayerHide(14000);
      setVisualState("idle");
    }
  }, [commitConversationHistory, requestVoidResponse, scheduleResponseLayerHide, showResponseLayer, syncConversationHistory]);
  const handleOpenModelConfig = useCallback(() => {
    setIsModelSettingsOpen(true);
  }, []);

  useEffect(() => {
    conversationHistoryRef.current = conversationHistory;
  }, [conversationHistory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const nextState = VOID_VISUAL_STATE_BY_KEY[event.key];
      if (!nextState || isExpandedResponseOpen) {
        return;
      }
      textExchangeActiveRef.current = false;
      window.clearTimeout(speakingTimeoutRef.current);
      if (nextState === "listening") {
        hideResponseLayer();
      }
      setVisualState(nextState);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideResponseLayer, isExpandedResponseOpen]);

  useEffect(() => {
    if (isExpandedResponseOpen) {
      return;
    }

    gsap.to(expandedResponseProgressRef.current, {
      value: 0,
      duration: 0.68,
      ease: "sine.inOut",
      overwrite: "auto",
      onUpdate: () => setExpandedResponseProgress(expandedResponseProgressRef.current.value)
    });
  }, [isExpandedResponseOpen]);

  useEffect(() => {
    return () => {
      window.clearTimeout(speakingTimeoutRef.current);
      window.clearTimeout(responseLayerHideTimeoutRef.current);
      window.cancelAnimationFrame(expandedProgressRafRef.current);
    };
  }, []);

  return (
    <main className="void-stage">
      <BlobScene
        visualState={visualState}
        expandedResponseProgress={expandedResponseProgress}
        isExpandedResponseClosing={isExpandedResponseClosing}
      />
      <VoidResponseLayer
        isVisible={responseLayer.isVisible}
        text={responseLayer.text}
        tone={responseLayer.tone}
        onExpand={openExpandedResponse}
      />
      <LuminousTextEntry
        onSend={handleTextMessage}
        onOpenModelConfig={handleOpenModelConfig}
        onOpenConversationHistory={openExpandedResponse}
      />
      <ExpandedResponseOverlay
        isOpen={isExpandedResponseOpen}
        messages={conversationHistory}
        onClose={() => setIsExpandedResponseOpen(false)}
        onClosingChange={setIsExpandedResponseClosing}
        onOpenProgressChange={setExpandedProgress}
        onRegenerateLatestUserMessage={handleRegenerateLatestUserMessage}
      />
      <ModelSettingsModal isOpen={isModelSettingsOpen} onClose={() => setIsModelSettingsOpen(false)} />
    </main>
  );
}
