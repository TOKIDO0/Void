import { useCallback, useEffect, useRef, useState } from "react";
import { BlobScene } from "../blob-scene/BlobScene";
import { sendVoidMessage, type VoidConversationMessage } from "../agent/voidConversation";
import { loadModelConfig } from "../settings/modelConfig";
import { LuminousTextEntry } from "../text-entry/LuminousTextEntry";
import { VOID_VISUAL_STATE_BY_KEY, type VoidVisualState } from "../void-state/voidVisualState";
import { useMicrophoneVoiceActivity } from "../voice/useMicrophoneVoiceActivity";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
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
      setVisualState("speaking");
      speakingTimeoutRef.current = window.setTimeout(() => {
        if (textExchangeActiveRef.current) {
          textExchangeActiveRef.current = false;
          setVisualState("idle");
        }
      }, 1800);
    } catch {
      textExchangeActiveRef.current = false;
      setVisualState("idle");
    }
  }, []);

  const handleOpenModelConfig = useCallback(() => {
    window.dispatchEvent(new CustomEvent("void:model-config-requested"));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const nextState = VOID_VISUAL_STATE_BY_KEY[event.key];
      if (!nextState) {
        return;
      }
      textExchangeActiveRef.current = false;
      window.clearTimeout(speakingTimeoutRef.current);
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
      <LuminousTextEntry onSend={handleTextMessage} onOpenModelConfig={handleOpenModelConfig} />
    </main>
  );
}
