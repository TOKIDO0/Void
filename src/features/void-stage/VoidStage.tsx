import { useCallback, useEffect, useRef, useState } from "react";
import { BlobScene } from "../blob-scene/BlobScene";
import { sendVoidMessage, type VoidConversationMessage } from "../agent/voidConversation";
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

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [responseLayer, setResponseLayer] = useState<ResponseLayerState>({
    isVisible: false,
    text: "",
    tone: "quiet",
    source: "text"
  });
  const conversationHistoryRef = useRef<VoidConversationMessage[]>([]);
  const textExchangeActiveRef = useRef(false);
  const speakingTimeoutRef = useRef(0);
  const responseLayerHideTimeoutRef = useRef(0);

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

  useMicrophoneVoiceActivity({
    onVisualStateChange: (nextVisualState) => {
      if (textExchangeActiveRef.current) {
        return;
      }

      if (nextVisualState === "listening") {
        hideResponseLayer();
      }
      setVisualState(nextVisualState);
    }
  });

  const handleTextMessage = useCallback(async (message: string) => {
    textExchangeActiveRef.current = true;
    window.clearTimeout(speakingTimeoutRef.current);
    showResponseLayer({
      text: "正在思考。",
      tone: "thinking",
      source: "text"
    });
    setVisualState("thinking");

    try {
      const assistantResponse = await sendVoidMessage(
        message,
        conversationHistoryRef.current,
        loadModelConfig()
      );

      conversationHistoryRef.current = [
        ...conversationHistoryRef.current,
        { role: "user", content: message },
        { role: "assistant", content: assistantResponse.content }
      ];
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
      showResponseLayer({
        text: error instanceof Error ? error.message : "模型连接失败，请检查配置。",
        tone: "error",
        source: "text"
      });
      scheduleResponseLayerHide(14000);
      setVisualState("idle");
    }
  }, [scheduleResponseLayerHide, showResponseLayer]);

  const handleOpenModelConfig = useCallback(() => {
    setIsModelSettingsOpen(true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const nextState = VOID_VISUAL_STATE_BY_KEY[event.key];
      if (!nextState) {
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
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(speakingTimeoutRef.current);
      window.clearTimeout(responseLayerHideTimeoutRef.current);
    };
  }, []);

  return (
    <main className="void-stage">
      <BlobScene visualState={visualState} />
      <VoidResponseLayer
        isVisible={responseLayer.isVisible}
        text={responseLayer.text}
        tone={responseLayer.tone}
      />
      <LuminousTextEntry onSend={handleTextMessage} onOpenModelConfig={handleOpenModelConfig} />
      <ModelSettingsModal isOpen={isModelSettingsOpen} onClose={() => setIsModelSettingsOpen(false)} />
    </main>
  );
}
