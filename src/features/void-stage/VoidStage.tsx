import { useCallback, useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { BlobScene } from "../blob-scene/BlobScene";
import {
  applyAssistantStreamContent,
  createPendingAssistantConversation,
  finalizeAssistantStreamContent,
  loadCurrentConversationHistory,
  removeAssistantMessageAt,
  saveCurrentConversationHistory,
  sendVoidMessage,
  type VoidConversationAttachment,
  type VoidConversationMessage
} from "../agent/voidConversation";
import { ExpandedResponseOverlay } from "../expanded-response/ExpandedResponseOverlay";
import { loadModelConfig, updateThinkingModeEnabled } from "../settings/modelConfig";
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
  pulseKey: string;
};

const RESPONSE_LAYER_IDLE_HIDE_MS = 32000;
const TEXT_SPEAKING_PREVIEW_MS = 1800;
const ERROR_RESPONSE_HIDE_MS = 14000;
const THINKING_TEXT = "正在思考...";
const REGENERATING_TEXT = "正在重新思考...";
const MODEL_CONNECTION_FALLBACK_ERROR = "模型连接失败，请检查配置。";
type ThinkingModePulseDirection = "on" | "off";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [isExpandedResponseOpen, setIsExpandedResponseOpen] = useState(false);
  const [isExpandedResponseClosing, setIsExpandedResponseClosing] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<VoidConversationMessage[]>(() => loadCurrentConversationHistory());
  const [thinkingModeEnabled, setThinkingModeEnabled] = useState(() => loadModelConfig().thinkingModeEnabled);
  const [thinkingModePulseEventId, setThinkingModePulseEventId] = useState(0);
  const [thinkingModePulseDirection, setThinkingModePulseDirection] = useState<ThinkingModePulseDirection>("on");
  const [expandedResponseProgress, setExpandedResponseProgress] = useState(0);
  const [responseLayer, setResponseLayer] = useState<ResponseLayerState>({
    isVisible: false,
    text: "",
    tone: "quiet",
    source: "text",
    pulseKey: "idle"
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
    attachments: VoidConversationAttachment[] = [],
    onStreamContent?: (content: string) => void
  ) => {
    const modelConfig = {
      ...loadModelConfig(),
      thinkingModeEnabled
    };
    const canStream = modelConfig.streamEnabled && modelConfig.provider === "openai-compatible";
    let streamedContent = "";
    let didStartStreaming = false;

    return sendVoidMessage(message, history, {
      ...modelConfig,
      streamEnabled: canStream
    }, attachments, canStream
      ? (token) => {
        streamedContent += token;
        onStreamContent?.(streamedContent);
        showResponseLayer({
          text: streamedContent,
          tone: "quiet",
          source: "text",
          pulseKey: didStartStreaming ? "streaming-active" : "streaming-start"
        });
        didStartStreaming = true;
      }
      : undefined);
  }, [showResponseLayer, thinkingModeEnabled]);

  const handleThinkingModeChange = useCallback((nextThinkingModeEnabled: boolean) => {
    setThinkingModeEnabled(nextThinkingModeEnabled);
    setThinkingModePulseDirection(nextThinkingModeEnabled ? "on" : "off");
    setThinkingModePulseEventId((currentEventId) => currentEventId + 1);
    updateThinkingModeEnabled(nextThinkingModeEnabled);
  }, []);

  const completeTextResponse = useCallback((responseText: string, pulseKey: string) => {
    showResponseLayer({
      text: responseText,
      tone: "quiet",
      source: "text",
      pulseKey
    });
    scheduleResponseLayerHide();
    setVisualState("speaking");
    speakingTimeoutRef.current = window.setTimeout(() => {
      if (textExchangeActiveRef.current) {
        textExchangeActiveRef.current = false;
        setVisualState("idle");
      }
    }, TEXT_SPEAKING_PREVIEW_MS);
  }, [scheduleResponseLayerHide, showResponseLayer]);

  const failTextResponse = useCallback((
    error: unknown,
    pulseKey: string,
    pendingHistory: VoidConversationMessage[],
    assistantMessageIndex: number
  ) => {
    textExchangeActiveRef.current = false;
    const errorMessage = error instanceof Error ? error.message : MODEL_CONNECTION_FALLBACK_ERROR;
    const hasStreamedAssistantContent = Boolean(pendingHistory[assistantMessageIndex]?.content.trim());
    const nextConversationHistory = hasStreamedAssistantContent
      ? pendingHistory
      : removeAssistantMessageAt(pendingHistory, assistantMessageIndex);

    commitConversationHistory(nextConversationHistory);
    showResponseLayer({
      text: errorMessage,
      tone: "error",
      source: "text",
      pulseKey
    });
    scheduleResponseLayerHide(ERROR_RESPONSE_HIDE_MS);
    setVisualState("idle");
  }, [commitConversationHistory, scheduleResponseLayerHide, showResponseLayer]);

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

  const handleTextMessage = useCallback(async (message: string, attachments: VoidConversationAttachment[]) => {
    textExchangeActiveRef.current = true;
    window.clearTimeout(speakingTimeoutRef.current);
    showResponseLayer({
      text: THINKING_TEXT,
      tone: "thinking",
      source: "text",
      pulseKey: "thinking"
    });
    setVisualState("thinking");

    const previousHistory = conversationHistoryRef.current;
    const streamState = createPendingAssistantConversation(previousHistory, message, attachments);
    let latestConversationHistory = streamState.history;

    try {
      syncConversationHistory(latestConversationHistory);

      const syncStreamingAssistantMessage = (content: string) => {
        latestConversationHistory = applyAssistantStreamContent(streamState, content);
        syncConversationHistory(latestConversationHistory);
      };

      const assistantResponse = await requestVoidResponse(message, previousHistory, attachments, syncStreamingAssistantMessage);
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      completeTextResponse(assistantResponse.content, "complete");
    } catch (error) {
      failTextResponse(error, "error", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [commitConversationHistory, completeTextResponse, failTextResponse, requestVoidResponse, showResponseLayer, syncConversationHistory]);

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
      text: REGENERATING_TEXT,
      tone: "thinking",
      source: "text",
      pulseKey: "thinking-regenerate"
    });

    const historyBeforeEditedMessage = currentHistory.slice(0, messageIndex);
    const streamState = createPendingAssistantConversation(historyBeforeEditedMessage, content);
    let latestConversationHistory = streamState.history;

    try {
      syncConversationHistory(latestConversationHistory);

      const syncStreamingAssistantMessage = (streamedContent: string) => {
        latestConversationHistory = applyAssistantStreamContent(streamState, streamedContent);
        syncConversationHistory(latestConversationHistory);
      };

      const assistantResponse = await requestVoidResponse(
        content,
        historyBeforeEditedMessage,
        targetMessage.attachments ?? [],
        syncStreamingAssistantMessage
      );
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      completeTextResponse(assistantResponse.content, "complete-regenerate");
    } catch (error) {
      failTextResponse(error, "error-regenerate", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [commitConversationHistory, completeTextResponse, failTextResponse, requestVoidResponse, showResponseLayer, syncConversationHistory]);

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
      onUpdate: () => setExpandedProgress(expandedResponseProgressRef.current.value)
    });
  }, [isExpandedResponseOpen, setExpandedProgress]);

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
        thinkingModePulseEventId={thinkingModePulseEventId}
        thinkingModePulseDirection={thinkingModePulseDirection}
      />
      <VoidResponseLayer
        isVisible={responseLayer.isVisible}
        text={responseLayer.text}
        tone={responseLayer.tone}
        pulseKey={responseLayer.pulseKey}
        onExpand={openExpandedResponse}
      />
      <LuminousTextEntry
        thinkingModeEnabled={thinkingModeEnabled}
        onSend={handleTextMessage}
        onThinkingModeChange={handleThinkingModeChange}
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
