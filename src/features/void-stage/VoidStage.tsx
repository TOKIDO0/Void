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
import { VoidResponseLayer } from "../response-layer/VoidResponseLayer";
import { loadModelConfig, updateThinkingModeEnabled } from "../settings/modelConfig";
import { ModelSettingsModal } from "../settings/ModelSettingsModal";
import { LuminousTextEntry } from "../text-entry/LuminousTextEntry";
import { VOID_VISUAL_STATE_BY_KEY, type VoidVisualState } from "../void-state/voidVisualState";
import { loadVoicePreferences, saveVoicePreferences, type VoicePreferences } from "../voice/voicePreferences";
import { loadVoiceRuntimeConfig } from "../voice/voiceRuntimeConfig";
import { VoiceSessionController } from "../voice/voiceSessionController";
import { useVoiceInputMonitor } from "../voice/useVoiceInputMonitor";
import { DEFAULT_VOICE_STATE, type VoiceStateSnapshot } from "../voice/voiceState";
import { DoubaoStreamingSttProvider } from "../voice/stt/doubaoStreamingSttProvider";
import { FishAudioTtsProvider } from "../voice/tts/fishAudioTtsProvider";
import { MiniMaxTtsProvider } from "../voice/tts/minimaxTtsProvider";
import { DoubaoTtsProvider } from "../voice/tts/doubaoTtsProvider";
import { VoicePlaybackController } from "../voice/tts/voicePlaybackController";
import { ProviderRequestError } from "../../lib/model-providers/providerErrors";

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
  const [voicePreferences, setVoicePreferences] = useState<VoicePreferences>(() => loadVoicePreferences());
  const [voiceState, setVoiceState] = useState<VoiceStateSnapshot>(DEFAULT_VOICE_STATE);
  const [thinkingModePulseEventId, setThinkingModePulseEventId] = useState(0);
  const [thinkingModePulseDirection, setThinkingModePulseDirection] = useState<ThinkingModePulseDirection>("on");
  const [expandedResponseProgress, setExpandedResponseProgress] = useState(0);
  const [voiceTranscriptPreview, setVoiceTranscriptPreview] = useState("");
  const [responseLayer, setResponseLayer] = useState<ResponseLayerState>({
    isVisible: false,
    text: "",
    tone: "quiet",
    source: "text",
    pulseKey: "idle"
  });

  const conversationHistoryRef = useRef<VoidConversationMessage[]>(conversationHistory);
  const textExchangeActiveRef = useRef(false);
  const responseLayerHideTimeoutRef = useRef(0);
  const expandedProgressRafRef = useRef(0);
  const expandedResponseProgressRef = useRef({ value: 0 });
  const voicePlaybackControllerRef = useRef(new VoicePlaybackController());
  const voiceSessionControllerRef = useRef<VoiceSessionController | null>(null);

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

  const updateVoicePreferences = useCallback((nextPreferences: VoicePreferences) => {
    setVoicePreferences(nextPreferences);
    saveVoicePreferences(nextPreferences);
  }, []);

  const handleVoiceSessionError = useCallback((error: Error) => {
    setVoiceTranscriptPreview("");
    showResponseLayer({
      text: error.message,
      tone: "error",
      source: "voice-transcript",
      pulseKey: "voice-error"
    });
    scheduleResponseLayerHide(ERROR_RESPONSE_HIDE_MS);
  }, [scheduleResponseLayerHide, showResponseLayer]);

  const handleVoiceFinalTranscript = useCallback((text: string) => {
    setVoiceTranscriptPreview("");
    showResponseLayer({
      text,
      tone: "quiet",
      source: "voice-transcript",
      pulseKey: "voice-final"
    });
  }, [showResponseLayer]);

  const synthesizeSpeech = useCallback(async (text: string) => {
    const runtimeConfig = loadVoiceRuntimeConfig();
    const synthesisRequest = {
      text,
      requestMode: runtimeConfig.requestMode,
      voiceMode: "default" as const,
      preferredGender: "female" as const,
      scene: "default" as const
    };
    const synthesisErrors: string[] = [];

    if (runtimeConfig.doubaoApiKey) {
      try {
        const doubaoProvider = new DoubaoTtsProvider({
          apiKey: runtimeConfig.doubaoApiKey,
          speakerId: runtimeConfig.doubaoSpeakerId,
          resourceId: runtimeConfig.doubaoResourceId
        });

        return await doubaoProvider.synthesize(synthesisRequest);
      } catch (error) {
        synthesisErrors.push(resolveTtsErrorMessage(error));
      }
    }

    if (runtimeConfig.fishAudioApiKey) {
      try {
        const fishAudioProvider = new FishAudioTtsProvider({
          apiKey: runtimeConfig.fishAudioApiKey,
          voiceId: runtimeConfig.fishAudioVoiceId,
          model: runtimeConfig.fishAudioModel
        });

        return await fishAudioProvider.synthesize(synthesisRequest);
      } catch (error) {
        synthesisErrors.push(resolveTtsErrorMessage(error));
      }
    }

    if (runtimeConfig.minimaxApiKey) {
      try {
        const minimaxProvider = new MiniMaxTtsProvider({
          apiKey: runtimeConfig.minimaxApiKey,
          groupId: runtimeConfig.minimaxGroupId
        });

        return await minimaxProvider.synthesize(synthesisRequest);
      } catch (error) {
        synthesisErrors.push(resolveTtsErrorMessage(error));
      }
    }

    if (!runtimeConfig.doubaoApiKey && !runtimeConfig.fishAudioApiKey && !runtimeConfig.minimaxApiKey) {
      return null;
    }

    throw new Error(synthesisErrors.join("；") || "语音合成失败，请检查语音供应商配置。");
  }, []);

  const resetVoiceOutputState = useCallback((nextVisualState: VoidVisualState = "idle") => {
    setVoiceState((currentState) => ({
      ...currentState,
      outputState: "idle"
    }));

    if (!textExchangeActiveRef.current) {
      setVisualState(nextVisualState);
    }
  }, []);

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

  const completeTextResponse = useCallback(async (responseText: string, pulseKey: string) => {
    showResponseLayer({
      text: responseText,
      tone: "quiet",
      source: "text",
      pulseKey
    });
    scheduleResponseLayerHide();
    textExchangeActiveRef.current = false;

    if (!voicePreferences.voiceOutputEnabled) {
      setVisualState("idle");
      return;
    }

    const synthesisResult = await synthesizeSpeech(responseText);
    if (!synthesisResult) {
      setVisualState("idle");
      return;
    }

    voicePlaybackControllerRef.current.play(synthesisResult.audioUrl, {
      onStart: () => {
        setVoiceState((currentState) => ({
          ...currentState,
          outputState: "speaking"
        }));
        setVisualState("speaking");
      },
      onEnd: () => {
        resetVoiceOutputState("idle");
      },
      onError: () => {
        resetVoiceOutputState("idle");
      }
    });
  }, [resetVoiceOutputState, scheduleResponseLayerHide, showResponseLayer, synthesizeSpeech, voicePreferences.voiceOutputEnabled]);

  const completeTextResponseWithErrorHandling = useCallback(async (responseText: string, pulseKey: string) => {
    try {
      await completeTextResponse(responseText, pulseKey);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "语音播放失败，请检查语音配置。";
      showResponseLayer({
        text: errorMessage,
        tone: "error",
        source: "voice-reply",
        pulseKey: "voice-reply-error"
      });
      scheduleResponseLayerHide(ERROR_RESPONSE_HIDE_MS);
      setVisualState("idle");
    }
  }, [completeTextResponse, scheduleResponseLayerHide, showResponseLayer]);

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

  useVoiceInputMonitor({
    isEnabled: voicePreferences.voiceInputEnabled,
    onInputStateChange: (nextInputState) => {
      setVoiceState((currentState) => ({
        ...currentState,
        inputState: nextInputState
      }));
    },
    onActivityLevelChange: (nextActivityLevel) => {
      setVoiceState((currentState) => ({
        ...currentState,
        activityLevel: nextActivityLevel
      }));
    },
    onVisualStateChange: (nextVisualState) => {
      if (textExchangeActiveRef.current || isExpandedResponseOpen || voiceState.outputState === "speaking") {
        return;
      }

      if (nextVisualState === "listening") {
        hideResponseLayer();
      }

      if (nextVisualState === "thinking" && voiceTranscriptPreview.trim()) {
        handleVoiceFinalTranscript(voiceTranscriptPreview);
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

  const stopVoicePlayback = useCallback(() => {
    voicePlaybackControllerRef.current.stop();
    resetVoiceOutputState(voicePreferences.voiceInputEnabled ? "listening" : "idle");
  }, [resetVoiceOutputState, voicePreferences.voiceInputEnabled]);

  const handleVoiceOutputToggle = useCallback(() => {
    const nextVoiceOutputEnabled = !voicePreferences.voiceOutputEnabled;
    updateVoicePreferences({
      ...voicePreferences,
      voiceOutputEnabled: nextVoiceOutputEnabled
    });

    if (!nextVoiceOutputEnabled) {
      stopVoicePlayback();
    }
  }, [stopVoicePlayback, updateVoicePreferences, voicePreferences]);

  const handleTextMessage = useCallback(async (message: string, attachments: VoidConversationAttachment[]) => {
    textExchangeActiveRef.current = true;
    stopVoicePlayback();
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
      await completeTextResponseWithErrorHandling(assistantResponse.content, "complete");
    } catch (error) {
      failTextResponse(error, "error", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [commitConversationHistory, completeTextResponseWithErrorHandling, failTextResponse, requestVoidResponse, showResponseLayer, stopVoicePlayback, syncConversationHistory]);

  const handleRegenerateLatestUserMessage = useCallback(async (messageIndex: number, content: string) => {
    const currentHistory = conversationHistoryRef.current;
    const targetMessage = currentHistory[messageIndex];

    if (!targetMessage || targetMessage.role !== "user") {
      return;
    }

    textExchangeActiveRef.current = true;
    stopVoicePlayback();
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
      await completeTextResponseWithErrorHandling(assistantResponse.content, "complete-regenerate");
    } catch (error) {
      failTextResponse(error, "error-regenerate", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [commitConversationHistory, completeTextResponseWithErrorHandling, failTextResponse, requestVoidResponse, showResponseLayer, stopVoicePlayback, syncConversationHistory]);

  const handleVoiceInputToggle = useCallback(() => {
    const nextVoiceInputEnabled = !voicePreferences.voiceInputEnabled;
    const runtimeConfig = loadVoiceRuntimeConfig();
    updateVoicePreferences({
      ...voicePreferences,
      voiceInputEnabled: nextVoiceInputEnabled
    });

    if (nextVoiceInputEnabled) {
      const sttProvider = new DoubaoStreamingSttProvider({
        apiKey: runtimeConfig.doubaoApiKey
      });

      voiceSessionControllerRef.current = new VoiceSessionController({
        sttProvider,
        onInterimTranscript: (text) => {
          setVoiceTranscriptPreview(text);
          if (text.trim()) {
            showResponseLayer({
              text,
              tone: "quiet",
              source: "voice-transcript",
              pulseKey: "voice-interim"
            });
          }
        },
        onFinalTranscript: (text) => {
          void handleTextMessage(text, []);
        },
        onError: handleVoiceSessionError
      });

      void voiceSessionControllerRef.current.start();
      return;
    }

    void voiceSessionControllerRef.current?.stop();
    voiceSessionControllerRef.current = null;
    setVoiceTranscriptPreview("");
    setVoiceState((currentState) => ({
      ...currentState,
      inputState: "mic_off",
      activityLevel: "silent"
    }));

    if (!textExchangeActiveRef.current && voiceState.outputState !== "speaking") {
      setVisualState("idle");
    }
  }, [handleTextMessage, handleVoiceSessionError, showResponseLayer, updateVoicePreferences, voicePreferences, voiceState.outputState]);

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
      stopVoicePlayback();
      if (nextState === "listening") {
        hideResponseLayer();
      }
      setVisualState(nextState);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideResponseLayer, isExpandedResponseOpen, stopVoicePlayback]);

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
      stopVoicePlayback();
      void voiceSessionControllerRef.current?.stop();
      window.clearTimeout(responseLayerHideTimeoutRef.current);
      window.cancelAnimationFrame(expandedProgressRafRef.current);
    };
  }, [stopVoicePlayback]);

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
        voiceInputEnabled={voicePreferences.voiceInputEnabled}
        voiceOutputEnabled={voicePreferences.voiceOutputEnabled}
        onSend={handleTextMessage}
        onThinkingModeChange={handleThinkingModeChange}
        onVoiceInputToggle={handleVoiceInputToggle}
        onVoiceOutputToggle={handleVoiceOutputToggle}
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

function buildVoiceProviderErrorMessage(error: ProviderRequestError) {
  if (error.kind === "proxy-unavailable") {
    return error.message;
  }

  if (error.kind === "network") {
    return error.serviceMessage || error.message;
  }

  const status = error.status ?? 0;
  const serviceMessage = error.serviceMessage.trim();
  const isFishAudioEndpoint = (error.endpointUrl ?? "").includes("fish.audio");

  if (status === 401 && isFishAudioEndpoint) {
    return `FishAudio TTS 鉴权失败（401）。请确认填写的是官方 API Key，且该 Key 仍然有效。${serviceMessage ? ` 服务端信息：${serviceMessage}` : ""}`;
  }

  if (status === 403 && isFishAudioEndpoint) {
    return `FishAudio TTS 无权访问当前模型或音色（403）。请确认该 API Key 对应账户具备模型或音色权限。${serviceMessage ? ` 服务端信息：${serviceMessage}` : ""}`;
  }

  if (status === 402 && isFishAudioEndpoint) {
    return `FishAudio TTS 余额不足或额度不可用（402）。${serviceMessage ? ` 服务端信息：${serviceMessage}` : ""}`;
  }

  return serviceMessage || error.message;
}

function resolveTtsErrorMessage(error: unknown) {
  if (error instanceof ProviderRequestError) {
    return buildVoiceProviderErrorMessage(error);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "语音合成失败。";
}
