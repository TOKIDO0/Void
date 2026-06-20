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

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [responseLayerText, setResponseLayerText] = useState("");
  const [responseLayerTone, setResponseLayerTone] = useState<ResponseLayerTone>("quiet");
  const conversationHistoryRef = useRef<VoidConversationMessage[]>([]);
  const textExchangeActiveRef = useRef(false);
  const speakingTimeoutRef = useRef(0);
  useMicrophoneVoiceActivity({
    onVisualStateChange: (nextVisualState) => {
      if (textExchangeActiveRef.current) {
        return;
      }

      setVisualState(nextVisualState);
    }
  });

  const handleTextMessage = useCallback(async (message: string) => {
    textExchangeActiveRef.current = true;
    window.clearTimeout(speakingTimeoutRef.current);
    setResponseLayerTone("thinking");
    setResponseLayerText("正在思考。");
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
      setResponseLayerTone("quiet");
      setResponseLayerText(assistantResponse.content);
      setVisualState("speaking");
      speakingTimeoutRef.current = window.setTimeout(() => {
        if (textExchangeActiveRef.current) {
          textExchangeActiveRef.current = false;
          setVisualState("idle");
        }
      }, 1800);
    } catch (error) {
      textExchangeActiveRef.current = false;
      setResponseLayerTone("error");
      setResponseLayerText(error instanceof Error ? error.message : "模型连接失败，请检查配置。");
      setVisualState("idle");
    }
  }, []);

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
      if (nextState !== "speaking") {
        setResponseLayerTone("quiet");
      }
      setVisualState(nextState);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      window.clearTimeout(speakingTimeoutRef.current);
    };
  }, []);

  return (
    <main className="void-stage">
      <BlobScene visualState={visualState} />
      <VoidResponseLayer text={responseLayerText} tone={responseLayerTone} />
      <LuminousTextEntry onSend={handleTextMessage} onOpenModelConfig={handleOpenModelConfig} />
      <ModelSettingsModal isOpen={isModelSettingsOpen} onClose={() => setIsModelSettingsOpen(false)} />
    </main>
  );
}
