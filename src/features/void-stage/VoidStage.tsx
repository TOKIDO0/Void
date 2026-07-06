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
import { VoiceTtsOrchestrator } from "../voice/tts/voiceTtsOrchestrator";
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
  const voiceOutputAbortControllerRef = useRef<AbortController | null>(null);
  const voiceOutputStreamFinishedRef = useRef(true);
  // 对话回合的单调递增 id：用户打断（barge-in）时自增以「作废」当前回合的后续副作用
  const activeExchangeIdRef = useRef(0);
  // 当前回合开始前的历史快照，打断时回滚，避免残留空回合并防止过期提交污染新回合
  const exchangeBaseHistoryRef = useRef<VoidConversationMessage[]>([]);

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

  // 开启一个新的对话回合：自增回合 id、标记交换进行中、记录回滚基线，返回本回合 id。
  const beginExchange = useCallback((baseHistory: VoidConversationMessage[]) => {
    activeExchangeIdRef.current += 1;
    textExchangeActiveRef.current = true;
    exchangeBaseHistoryRef.current = baseHistory;
    return activeExchangeIdRef.current;
  }, []);

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

  const resetVoiceOutputState = useCallback((nextVisualState: VoidVisualState = "idle") => {
    setVoiceState((currentState) => ({
      ...currentState,
      outputState: "idle"
    }));

    if (!textExchangeActiveRef.current) {
      setVisualState(nextVisualState);
    }
  }, []);

  const tryCompleteVoiceOutputSession = useCallback((nextVisualState: VoidVisualState = "idle") => {
    if (!voiceOutputStreamFinishedRef.current || !voicePlaybackControllerRef.current.isIdle()) {
      return;
    }

    resetVoiceOutputState(nextVisualState);
  }, [resetVoiceOutputState]);

  const startVoiceOutputSession = useCallback(() => {
    voiceOutputAbortControllerRef.current?.abort();
    voiceOutputAbortControllerRef.current = new AbortController();
    voiceOutputStreamFinishedRef.current = false;

    voicePlaybackControllerRef.current.setLifecycle({
      onStart: () => {
        setVoiceState((currentState) => ({
          ...currentState,
          outputState: "speaking"
        }));
        setVisualState("speaking");
      },
      onEnd: () => {
        tryCompleteVoiceOutputSession("idle");
      },
      onError: () => {
        tryCompleteVoiceOutputSession("idle");
      }
    });

    return voiceOutputAbortControllerRef.current.signal;
  }, [tryCompleteVoiceOutputSession]);

  const finalizeVoiceOutputSession = useCallback((nextVisualState: VoidVisualState = "idle") => {
    voiceOutputStreamFinishedRef.current = true;
    tryCompleteVoiceOutputSession(nextVisualState);
  }, [tryCompleteVoiceOutputSession]);

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

    // 送入合成前剥离括号情绪标注（显示层保留原文）；净化后为空则无需发声
    const speechText = sanitizeTextForSpeech(responseText);
    if (!speechText) {
      setVisualState("idle");
      return;
    }

    const runtimeConfig = loadVoiceRuntimeConfig();
    const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
    const synthesisResult = await orchestrator.synthesize({
      text: speechText,
      requestMode: runtimeConfig.requestMode,
      voiceMode: "default",
      preferredGender: "female",
      scene: "default"
    });
    if (!synthesisResult) {
      setVisualState("idle");
      return;
    }

    startVoiceOutputSession();
    voicePlaybackControllerRef.current.enqueue(synthesisResult.audioUrl);
    finalizeVoiceOutputSession("idle");
  }, [finalizeVoiceOutputSession, scheduleResponseLayerHide, showResponseLayer, startVoiceOutputSession, voicePreferences.voiceOutputEnabled]);

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

  const streamVoiceOutput = useCallback(async (responseText: string) => {
    if (!voicePreferences.voiceOutputEnabled) {
      return;
    }

    const runtimeConfig = loadVoiceRuntimeConfig();
    const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
    const sentences = splitCompleteSentences(responseText, true);
    if (!sentences.length) {
      return;
    }

    const signal = startVoiceOutputSession();
    await orchestrator.synthesizeSentences(
      sentences,
      {
        requestMode: runtimeConfig.requestMode,
        voiceMode: "default",
        preferredGender: "female",
        scene: "default"
      },
      async ({ result }) => {
        if (signal.aborted) {
          URL.revokeObjectURL(result.audioUrl);
          return;
        }

        voicePlaybackControllerRef.current.enqueue(result.audioUrl);
      },
      signal
    );
    finalizeVoiceOutputSession("idle");
  }, [finalizeVoiceOutputSession, startVoiceOutputSession, voicePreferences.voiceOutputEnabled]);

  const createStreamingVoiceBatcher = useCallback(() => {
    if (!voicePreferences.voiceOutputEnabled) {
      return null;
    }

    const runtimeConfig = loadVoiceRuntimeConfig();
    const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
    const signal = startVoiceOutputSession();
    // 整轮语音输出只维护一个流式合成会话：全局并发受控，按 index 顺序入队，避免打爆供应商触发 429
    const synthesisSession = orchestrator.createStreamingSession(
      {
        requestMode: runtimeConfig.requestMode,
        voiceMode: "default",
        preferredGender: "female",
        scene: "default"
      },
      ({ result }) => {
        if (signal.aborted) {
          URL.revokeObjectURL(result.audioUrl);
          return;
        }

        voicePlaybackControllerRef.current.enqueue(result.audioUrl);
      },
      signal
    );
    let synthesizedCursor = 0;
    // 本轮已产出的合成块数量，供渐进式阈值定位（首块最短、后续渐长）
    let emittedChunkCount = 0;

    return {
      push(content: string) {
        const segment = content.slice(synthesizedCursor);
        const { sentences, consumedLength } = extractReadySentences(segment, false, emittedChunkCount);
        if (!sentences.length) {
          return;
        }

        synthesizedCursor += consumedLength;
        emittedChunkCount += sentences.length;
        // 送入合成前剥离括号情绪标注（显示层不受影响）；空句由合成会话内部跳过
        synthesisSession.push(sentences.map(sanitizeTextForSpeech));
      },
      async complete(content: string) {
        const segment = content.slice(synthesizedCursor);
        const { sentences, consumedLength } = extractReadySentences(segment, true, emittedChunkCount);
        synthesizedCursor += consumedLength;
        emittedChunkCount += sentences.length;
        if (sentences.length) {
          synthesisSession.push(sentences.map(sanitizeTextForSpeech));
        }
        await synthesisSession.complete();
        finalizeVoiceOutputSession("idle");
      }
    };
  }, [finalizeVoiceOutputSession, startVoiceOutputSession, voicePreferences.voiceOutputEnabled]);

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

      // 说完话的「发送」由豆包服务端 VAD 的 definite final 驱动（onFinalTranscript → handleTextMessage），
      // 此处 VAD 的 thinking 仅作等待识别定稿的视觉过渡，不再伪触发发送。
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

  // 稳定的关闭回调：必须用 useCallback 固定引用。
  // 否则关闭动画每帧回调 setExpandedProgress 触发父组件重渲染 → 每帧新建 onClose
  // → overlay 内 playClose 每帧 churn → 关闭同步 effect 每帧重跑，击穿关闭守卫导致模态框"还魂"。
  const closeExpandedResponse = useCallback(() => {
    setIsExpandedResponseOpen(false);
  }, []);

  const stopVoicePlayback = useCallback(() => {
    voiceOutputAbortControllerRef.current?.abort();
    voiceOutputAbortControllerRef.current = null;
    voiceOutputStreamFinishedRef.current = true;
    voicePlaybackControllerRef.current.stop();
    resetVoiceOutputState(voicePreferences.voiceInputEnabled ? "listening" : "idle");
  }, [resetVoiceOutputState, voicePreferences.voiceInputEnabled]);

  // 用户在 AI 思考/播报时开口即打断：停止播报、作废当前回合的后续副作用，并回滚乐观历史。
  const interruptForBargeIn = useCallback(() => {
    const wasGenerating = textExchangeActiveRef.current;
    activeExchangeIdRef.current += 1;
    textExchangeActiveRef.current = false;
    stopVoicePlayback();
    if (wasGenerating) {
      // 模型仍在生成：回滚到回合开始前的历史，丢弃这一被打断的问答，避免残留与过期提交
      commitConversationHistory(exchangeBaseHistoryRef.current);
    }
  }, [commitConversationHistory, stopVoicePlayback]);

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
    const previousHistory = conversationHistoryRef.current;
    const exchangeId = beginExchange(previousHistory);
    stopVoicePlayback();
    showResponseLayer({
      text: THINKING_TEXT,
      tone: "thinking",
      source: "text",
      pulseKey: "thinking"
    });
    setVisualState("thinking");

    const streamState = createPendingAssistantConversation(previousHistory, message, attachments);
    let latestConversationHistory = streamState.history;
    const modelConfig = {
      ...loadModelConfig(),
      thinkingModeEnabled
    };
    const canStream = modelConfig.streamEnabled && modelConfig.provider === "openai-compatible";
    const streamingVoiceBatcher = canStream ? createStreamingVoiceBatcher() : null;

    try {
      syncConversationHistory(latestConversationHistory);

      const syncStreamingAssistantMessage = (content: string) => {
        if (activeExchangeIdRef.current !== exchangeId) {
          return; // 已被用户打断：停止本回合的流式历史与语音副作用
        }
        latestConversationHistory = applyAssistantStreamContent(streamState, content);
        syncConversationHistory(latestConversationHistory);
        streamingVoiceBatcher?.push(content);
      };

      const assistantResponse = await requestVoidResponse(message, previousHistory, attachments, syncStreamingAssistantMessage);
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：放弃本回合的历史提交与 UI/语音收尾（历史已回滚）
      }
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      if (streamingVoiceBatcher) {
        await streamingVoiceBatcher.complete(assistantResponse.content);
        showResponseLayer({
          text: assistantResponse.content,
          tone: "quiet",
          source: "text",
          pulseKey: "complete"
        });
        scheduleResponseLayerHide();
        textExchangeActiveRef.current = false;
        return;
      }
      await completeTextResponseWithErrorHandling(assistantResponse.content, "complete");
    } catch (error) {
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：忽略本回合的错误
      }
      failTextResponse(error, "error", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [beginExchange, commitConversationHistory, completeTextResponseWithErrorHandling, createStreamingVoiceBatcher, failTextResponse, requestVoidResponse, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, syncConversationHistory, thinkingModeEnabled]);

  const handleRegenerateLatestUserMessage = useCallback(async (messageIndex: number, content: string) => {
    const currentHistory = conversationHistoryRef.current;
    const targetMessage = currentHistory[messageIndex];

    if (!targetMessage || targetMessage.role !== "user") {
      return;
    }

    const historyBeforeEditedMessage = currentHistory.slice(0, messageIndex);
    const exchangeId = beginExchange(historyBeforeEditedMessage);
    stopVoicePlayback();
    setVisualState("thinking");
    showResponseLayer({
      text: REGENERATING_TEXT,
      tone: "thinking",
      source: "text",
      pulseKey: "thinking-regenerate"
    });

    const streamState = createPendingAssistantConversation(historyBeforeEditedMessage, content);
    let latestConversationHistory = streamState.history;
    const modelConfig = {
      ...loadModelConfig(),
      thinkingModeEnabled
    };
    const canStream = modelConfig.streamEnabled && modelConfig.provider === "openai-compatible";
    const streamingVoiceBatcher = canStream ? createStreamingVoiceBatcher() : null;

    try {
      syncConversationHistory(latestConversationHistory);

      const syncStreamingAssistantMessage = (streamedContent: string) => {
        if (activeExchangeIdRef.current !== exchangeId) {
          return; // 已被用户打断：停止本回合的流式历史与语音副作用
        }
        latestConversationHistory = applyAssistantStreamContent(streamState, streamedContent);
        syncConversationHistory(latestConversationHistory);
        streamingVoiceBatcher?.push(streamedContent);
      };

      const assistantResponse = await requestVoidResponse(
        content,
        historyBeforeEditedMessage,
        targetMessage.attachments ?? [],
        syncStreamingAssistantMessage
      );
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：放弃本回合的历史提交与 UI/语音收尾（历史已回滚）
      }
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      if (streamingVoiceBatcher) {
        await streamingVoiceBatcher.complete(assistantResponse.content);
        showResponseLayer({
          text: assistantResponse.content,
          tone: "quiet",
          source: "text",
          pulseKey: "complete-regenerate"
        });
        scheduleResponseLayerHide();
        textExchangeActiveRef.current = false;
        return;
      }
      await completeTextResponseWithErrorHandling(assistantResponse.content, "complete-regenerate");
    } catch (error) {
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：忽略本回合的错误
      }
      failTextResponse(error, "error-regenerate", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [beginExchange, commitConversationHistory, completeTextResponseWithErrorHandling, createStreamingVoiceBatcher, failTextResponse, requestVoidResponse, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, syncConversationHistory, thinkingModeEnabled]);

  const handleVoiceInputToggle = useCallback(() => {
    const nextVoiceInputEnabled = !voicePreferences.voiceInputEnabled;
    const runtimeConfig = loadVoiceRuntimeConfig();
    updateVoicePreferences({
      ...voicePreferences,
      voiceInputEnabled: nextVoiceInputEnabled
    });

    if (nextVoiceInputEnabled) {
      const sttProvider = new DoubaoStreamingSttProvider({
        appKey: runtimeConfig.doubaoAppId,
        accessKey: runtimeConfig.doubaoApiKey
      });

      voiceSessionControllerRef.current = new VoiceSessionController({
        sttProvider,
        onInterimTranscript: (text) => {
          const trimmedText = text.trim();
          // 打断（barge-in）：AI 正在思考或播报时用户开口，立即停 AI 并作废该回合，
          // 随后把用户识别文字显示到预览层。长度≥2 过滤掉单字噪声/回声误触发。
          const isAgentBusy = textExchangeActiveRef.current || !voicePlaybackControllerRef.current.isIdle();
          if (trimmedText.length >= 2 && isAgentBusy) {
            interruptForBargeIn();
          }
          setVoiceTranscriptPreview(text);
          if (trimmedText) {
            showResponseLayer({
              text,
              tone: "quiet",
              source: "voice-transcript",
              pulseKey: "voice-interim"
            });
          }
        },
        onFinalTranscript: (text) => {
          setVoiceTranscriptPreview("");
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
  }, [handleTextMessage, handleVoiceSessionError, interruptForBargeIn, showResponseLayer, updateVoicePreferences, voicePreferences, voiceState.outputState]);

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
        onClose={closeExpandedResponse}
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

// 渐进式分块（progressive chunking）：首块尽量短以最小化首字发声延迟（TTFA），
// 后续块逐渐变长——此时首句已在播放，有余量从容合成，换取更少请求与更自然的韵律。
// 数组按「本轮已产出的合成块序号」取阈值，越靠后越长，末位为封顶值。
const SYNTHESIS_CHUNK_MIN_CHARS_RAMP = [6, 14, 24];
// 软切封顶：无强标点（。！？；换行）的超长串，达到此长度即允许在弱停顿（逗号、顿号）处切，避免一口气憋太长
const SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS = 40;

function resolveChunkMinChars(chunkIndex: number) {
  const rampIndex = Math.min(chunkIndex, SYNTHESIS_CHUNK_MIN_CHARS_RAMP.length - 1);
  return SYNTHESIS_CHUNK_MIN_CHARS_RAMP[rampIndex];
}

// 朗读文本净化：AI 回复中形如「（轻声）」「(笑)」的括号情绪/动作标注，显示时保留（用户可见其情绪），
// 但 TTS 合成前必须剥离，否则会被逐字读出。仅用于送入合成的文本，绝不改动显示层。
function sanitizeTextForSpeech(text: string) {
  return text
    // 成对括号及其内容：中文（）、英文 ()、【】、[]
    .replace(/（[^（）]*）/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace(/【[^【】]*】/g, "")
    .replace(/\[[^[\]]*\]/g, "")
    // 流式分块可能把一对括号切散，残留的孤立括号符号一并清除
    .replace(/[（）()【】[\]]/g, "")
    // 剥离后可能留下多余空白
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 从流式文本中切出「已就绪」的合成块。
 * @param includeRemainder 收尾时为 true，把剩余不足一块的尾巴也一并吐出
 * @param emittedChunkOffset 本轮此前已产出的合成块数量，用于渐进式阈值定位（首块最短）
 */
function extractReadySentences(text: string, includeRemainder: boolean, emittedChunkOffset = 0) {
  const sentences: string[] = [];
  let consumedLength = 0;
  let chunkStartIndex = 0;

  for (let index = 0; index < text.length; index += 1) {
    const isStrongBoundary = isSentenceDelimiter(text[index]);
    const isSoftBoundary = isSoftSentenceDelimiter(text[index]);
    if (!isStrongBoundary && !isSoftBoundary) {
      continue;
    }

    const chunk = text.slice(chunkStartIndex, index + 1).trim();
    const globalChunkIndex = emittedChunkOffset + sentences.length;
    // 首块允许在弱停顿处切以尽快开口；后续块仅当强标点、或已超过软切封顶时才允许弱停顿切分
    const boundaryAllowed = isStrongBoundary
      || globalChunkIndex === 0
      || chunk.length >= SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS;
    if (!boundaryAllowed || chunk.length < resolveChunkMinChars(globalChunkIndex)) {
      continue;
    }

    sentences.push(chunk);
    chunkStartIndex = index + 1;
    consumedLength = index + 1;
  }

  if (includeRemainder) {
    const remainder = text.slice(chunkStartIndex).trim();
    if (remainder) {
      sentences.push(remainder);
      consumedLength = text.length;
    }
  }

  return {
    sentences,
    consumedLength
  };
}

function splitCompleteSentences(text: string, includeRemainder: boolean) {
  return extractReadySentences(text, includeRemainder).sentences;
}

function isSentenceDelimiter(character: string) {
  return character === "。" || character === "！" || character === "？" || character === "；" || character === "\n";
}

function isSoftSentenceDelimiter(character: string) {
  return character === "，" || character === "、" || character === ",";
}
