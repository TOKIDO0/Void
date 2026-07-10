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
import { stripStageDirections } from "../agent/responseTextDisplay";
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
import { DEFAULT_VOICE_STATE, type VoiceActivityLevel, type VoiceStateSnapshot } from "../voice/voiceState";
import { DoubaoStreamingSttProvider } from "../voice/stt/doubaoStreamingSttProvider";
import { VoiceTtsOrchestrator } from "../voice/tts/voiceTtsOrchestrator";
import { VoicePlaybackController } from "../voice/tts/voicePlaybackController";
import { ProviderRequestError } from "../../lib/model-providers/providerErrors";
import { recognizeUserEmotion } from "../emotion/userEmotionRecognizer";
import { evolveAgentEmotion } from "../emotion/agentEmotionEngine";
import {
  deriveEmotionResponsePolicy,
  type EmotionResponsePolicy,
  type VisualProfileHint
} from "../emotion/emotionToResponsePolicy";
import { loadAgentEmotionState, saveAgentEmotionState } from "../emotion/emotionStore";
import type { AgentEmotionState, EmotionLabel, UserEmotionReading } from "../emotion/emotionTypes";
import type { VoiceSynthesisExpression } from "../voice/tts/voiceTtsContract";
import { MemoryManagerPanel } from "../memory/ui/MemoryManagerPanel";
import { classifyMemory } from "../memory/memoryClassifier";
import { assessSalience } from "../memory/memorySalience";
import { assessSensitivity, resolveWriteDecision } from "../memory/memoryPolicy";
import { upsertMemoryDeduped } from "../memory/memoryStore";
import type { MemoryType, SubjectType, Sensitivity } from "../memory/memoryTypes";

// 情绪视觉偏移的中性初值：各字段乘性系数为 1，即不偏移（等价于纯 profile）。
const NEUTRAL_VISUAL_HINT: VisualProfileHint = {
  noiseSpeedScale: 1,
  edgeBoostScale: 1,
  amplitudeScale: 1
};

// 归一化语音定稿文本用于等价去重：剥离所有空白与标点，
// 使「我觉得你好虚伪啊」与「我觉得你好虚伪啊。」判为同一句。
function normalizeVoiceFinal(text: string) {
  return text.replace(/[\s\p{P}]/gu, "");
}

// 情绪趋势记忆的合并时间窗：同一情绪标签在此窗内再次显著时，合并/更新为一条而非新增，
// 只保留趋势而非流水账（25 号 §2.3 优化点 4）。窗外再现则作为新的趋势点。
const EMOTION_MEMORY_MERGE_WINDOW_MS = 2 * 60 * 60 * 1000;

// 情绪标签中文措辞：仅用于 emotionTrend 记忆内容的自然表述（D4）。neutral 不写记忆，故不含。
const EMOTION_LABEL_TEXT: Record<Exclude<EmotionLabel, "neutral">, string> = {
  happy: "开心",
  stressed: "压力",
  sad: "低落",
  angry: "不满"
};

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
// 打断（barge-in）判定门槛：STT 文本最小字数。
// 方案 A（AI 优先）：AI 忙时必须「本地音量 VAD 确认真实人声」+「STT 文本达到门槛」才真正打断，
// 以过滤环境音/回声被 STT 识别成幻觉文字导致的误打断。
// AI 播报中会外放 TTS、回声风险最高，门槛更严；仅思考中（无外放）门槛较松。
const BARGE_IN_MIN_CHARS_THINKING = 2;
const BARGE_IN_MIN_CHARS_SPEAKING = 4;
const ERROR_RESPONSE_HIDE_MS = 14000;
const THINKING_TEXT = "正在思考...";
const REGENERATING_TEXT = "正在重新思考...";
const MODEL_CONNECTION_FALLBACK_ERROR = "模型连接失败，请检查配置。";

type ThinkingModePulseDirection = "on" | "off";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [isMemoryPanelOpen, setIsMemoryPanelOpen] = useState(false);
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
  // Agent 情绪状态（带惯性/衰减）：从本地持久化载入，随每轮对话演化后回写。
  const agentEmotionStateRef = useRef<AgentEmotionState>(loadAgentEmotionState());
  // 本轮用户情绪识别结果：供对话成功结束后判定「显著情绪」并写入 emotionTrend 记忆（D4）。
  const lastEmotionReadingRef = useRef<UserEmotionReading | null>(null);
  // 语音 final 内容闩锁：记录「上一条已发送定稿」的归一化文本（空串＝闩锁开放，允许下条放行）。
  // 与桥接/豆包分句时序完全解耦地拦截同一句的重复 final（无标点稿↔带标点定稿、上游抖动重发），
  // 根治双发双回复；闩锁在 onInterimTranscript 检出「明显是新一句」时开放。见 26 号 §4.1。
  const sentVoiceUtteranceNormalizedRef = useRef<string>("");
  // 本轮情绪派生的 TTS 表达参数：整轮一致，供流式/整段合成透传给豆包 audio_params。
  const turnTtsExpressionRef = useRef<VoiceSynthesisExpression>({});
  // 情绪视觉偏移：驱动中央流体 profile 的乘性偏移，需触发重渲染故用 state。
  const [emotionVisualHint, setEmotionVisualHint] = useState<VisualProfileHint>(NEUTRAL_VISUAL_HINT);
  const responseLayerHideTimeoutRef = useRef(0);
  const expandedProgressRafRef = useRef(0);
  const expandedResponseProgressRef = useRef({ value: 0 });
  const voicePlaybackControllerRef = useRef(new VoicePlaybackController());
  const voiceSessionControllerRef = useRef<VoiceSessionController | null>(null);
  const voiceOutputAbortControllerRef = useRef<AbortController | null>(null);
  const voiceOutputStreamFinishedRef = useRef(true);
  // 本地音量 VAD 的最新活跃度快照（ref 供 STT 回调同步读取，避免闭包旧值）：
  // 打断判定的「真实人声」二次校验依据，"active" 表示麦克风能量高于环境噪声阈值。
  const voiceActivityLevelRef = useRef<VoiceActivityLevel>("silent");
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

  // 本轮情绪结算：识别用户情绪 → 演化 Agent 情绪 → 持久化 → 派生策略。
  // 必须在创建语音批处理器之前调用，使 TTS 表达参数（整轮一致）在首句合成前就绪。
  // 一期只用文本；语音链路的声学线索后续接入 recognizeUserEmotion 第二参。
  const resolveTurnEmotion = useCallback((message: string): EmotionResponsePolicy => {
    const emotionReading = recognizeUserEmotion(message);
    // 暂存本轮识别结果，供对话成功结束后的 emotionTrend 记忆写入判定（D4）。
    lastEmotionReadingRef.current = emotionReading;
    const nextAgentEmotion = evolveAgentEmotion(agentEmotionStateRef.current, emotionReading);
    agentEmotionStateRef.current = nextAgentEmotion;
    saveAgentEmotionState(nextAgentEmotion);
    const emotionPolicy = deriveEmotionResponsePolicy(nextAgentEmotion, emotionReading);
    // TTS 表达走 ref（整轮一致，合成时读取）；视觉偏移走 state（驱动中央流体重渲染）。
    turnTtsExpressionRef.current = emotionPolicy.ttsExpression;
    setEmotionVisualHint(emotionPolicy.visualHint);
    return emotionPolicy;
  }, []);

  // 记忆写入统一底层通道：接收已定分区/主体/敏感的候选记忆，走 policy 裁决后落库。
  // - auto：直接写入；confirm：项目暂无确认 UI，本次保守跳过（敏感/健康信息不自动落库）；
  // - blocked：policy 层已硬拦截永不名单与高敏，直接丢弃。
  // classifier/policy/store 只 import 不改，接线处只负责生成 id/时间戳与来源。
  const persistCandidateMemory = useCallback((candidate: {
    memoryType: MemoryType;
    subjectType: SubjectType;
    subjectName: string;
    content: string;
    sensitivity: Sensitivity;
    /** 去重合并时间窗（毫秒）；情绪趋势按窗合并，普通记忆不传即永久去重。 */
    mergeWindowMs?: number;
  }) => {
    const decision = resolveWriteDecision({
      memoryType: candidate.memoryType,
      subjectType: candidate.subjectType,
      content: candidate.content,
      sensitivity: candidate.sensitivity
    });
    if (decision.action !== "auto") {
      return;
    }

    const now = Date.now();
    // 去重写入：同主体同内容命中既有条目则更新而非新增，避免记忆堆积。
    upsertMemoryDeduped(
      {
        id: crypto.randomUUID(),
        memoryType: candidate.memoryType,
        subjectType: candidate.subjectType,
        subjectName: candidate.subjectName,
        content: candidate.content,
        confidence: 0.6,
        source: "conversation",
        sensitivity: candidate.sensitivity,
        createdAt: now,
        updatedAt: now
      },
      { mergeWindowMs: candidate.mergeWindowMs }
    );
  }, []);

  // D2 用户输入自动写入：对本轮用户输入分类后走统一写入通道。
  // 仅对用户本人说的话建档，不含 AI 回复（避免把模型推测当事实记忆）。
  const captureMemoryFromUserMessage = useCallback((message: string) => {
    const content = message.trim();
    if (!content) {
      return;
    }

    // 准入闸：先判「值不值得长期记住」，拦掉纯社交 / 闲聊 / 情绪宣泄 / 问句，
    // 再交给分类器决定分区。这是根治「几乎每句话都被记下来」的第一道闸。
    if (!assessSalience(content).worth) {
      return;
    }

    const classified = classifyMemory(content);
    persistCandidateMemory({
      memoryType: classified.memoryType,
      subjectType: classified.subjectType,
      subjectName: classified.subjectName,
      content,
      sensitivity: classified.sensitivity
    });
  }, [persistCandidateMemory]);

  // D4 情绪联动：本轮情绪「显著」时写入一条 emotionTrend 记忆（分区固定，不过分类器）。
  // 显著性口径：非 neutral 且 intensity ≥ 0.6 且 confidence ≥ 0.5。
  const captureEmotionTrendMemory = useCallback(() => {
    const reading = lastEmotionReadingRef.current;
    if (!reading || reading.label === "neutral") {
      return;
    }
    if (reading.intensity < 0.6 || reading.confidence < 0.5) {
      return;
    }

    const content = `用户情绪偏${EMOTION_LABEL_TEXT[reading.label as Exclude<EmotionLabel, "neutral">]}`;
    persistCandidateMemory({
      memoryType: "emotionTrend",
      subjectType: "self",
      subjectName: "用户本人",
      content,
      sensitivity: assessSensitivity("emotionTrend", content),
      // 同一情绪 2 小时内合并为一条，避免情绪流水账。
      mergeWindowMs: EMOTION_MEMORY_MERGE_WINDOW_MS
    });
  }, [persistCandidateMemory]);

  const requestVoidResponse = useCallback((
    message: string,
    history: VoidConversationMessage[],
    attachments: VoidConversationAttachment[] = [],
    onStreamContent: ((content: string) => void) | undefined,
    emotionSystemPromptSuffix: string
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
          // 显示层剥离括号旁白（术语括号保留）；历史与合成走各自净化，互不影响
          text: stripStageDirections(streamedContent),
          tone: "quiet",
          source: "text",
          pulseKey: didStartStreaming ? "streaming-active" : "streaming-start"
        });
        didStartStreaming = true;
      }
      : undefined, emotionSystemPromptSuffix);
  }, [showResponseLayer, thinkingModeEnabled]);

  const handleThinkingModeChange = useCallback((nextThinkingModeEnabled: boolean) => {
    setThinkingModeEnabled(nextThinkingModeEnabled);
    setThinkingModePulseDirection(nextThinkingModeEnabled ? "on" : "off");
    setThinkingModePulseEventId((currentEventId) => currentEventId + 1);
    updateThinkingModeEnabled(nextThinkingModeEnabled);
  }, []);

  const completeTextResponse = useCallback(async (responseText: string, pulseKey: string) => {
    showResponseLayer({
      text: stripStageDirections(responseText),
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
      scene: "default",
      // 本轮情绪表达（整轮一致）：非流式整段路径同样透传
      expression: turnTtsExpressionRef.current
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
        scene: "default",
        // 本轮情绪表达（整轮一致）：resolveTurnEmotion 已在本批处理器创建前写入 ref
        expression: turnTtsExpressionRef.current
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
      // 同步写入 ref 供 STT 打断判定读取，再更新用于渲染的 state。
      voiceActivityLevelRef.current = nextActivityLevel;
      setVoiceState((currentState) => ({
        ...currentState,
        activityLevel: nextActivityLevel
      }));
    },
    onVisualStateChange: (nextVisualState) => {
      if (textExchangeActiveRef.current || isExpandedResponseOpen || voiceState.outputState === "speaking") {
        return;
      }

      // 说完话的「发送」由豆包服务端 VAD 的 definite final 驱动（onFinalTranscript → handleTextMessage），
      // 此处 VAD 的 thinking 仅作等待识别定稿的视觉过渡，不再伪触发发送。
      // 注意：不在此处调用 hideResponseLayer——预览层的显隐由 STT 回调（onInterimTranscript/
      // onFinalTranscript）与文本回合统一管理。音量 VAD 越权隐藏会在长句自然换气时把正在显示的
      // STT 预览硬藏一下又重现，造成"闪烁"（doc 18 问题 A）。
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
    // 情绪先结算：使 TTS 表达参数在批处理器创建前就绪，整轮一致，避免逐句变造成忽高忽低
    const emotionPolicy = resolveTurnEmotion(message);
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

      const assistantResponse = await requestVoidResponse(message, previousHistory, attachments, syncStreamingAssistantMessage, emotionPolicy.systemPromptSuffix);
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：放弃本回合的历史提交与 UI/语音收尾（历史已回滚）
      }
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      // 本回合成功结束（未被打断）：把用户输入建档，并按显著性写入情绪趋势记忆。
      captureMemoryFromUserMessage(message);
      captureEmotionTrendMemory();
      if (streamingVoiceBatcher) {
        await streamingVoiceBatcher.complete(assistantResponse.content);
        showResponseLayer({
          text: stripStageDirections(assistantResponse.content),
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
  }, [beginExchange, captureEmotionTrendMemory, captureMemoryFromUserMessage, commitConversationHistory, completeTextResponseWithErrorHandling, createStreamingVoiceBatcher, failTextResponse, requestVoidResponse, resolveTurnEmotion, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, syncConversationHistory, thinkingModeEnabled]);

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
    // 情绪先结算：使 TTS 表达参数在批处理器创建前就绪，整轮一致
    const emotionPolicy = resolveTurnEmotion(content);
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
        syncStreamingAssistantMessage,
        emotionPolicy.systemPromptSuffix
      );
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：放弃本回合的历史提交与 UI/语音收尾（历史已回滚）
      }
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, assistantResponse.content);
      commitConversationHistory(finalConversationHistory);
      if (streamingVoiceBatcher) {
        await streamingVoiceBatcher.complete(assistantResponse.content);
        showResponseLayer({
          text: stripStageDirections(assistantResponse.content),
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
  }, [beginExchange, commitConversationHistory, completeTextResponseWithErrorHandling, createStreamingVoiceBatcher, failTextResponse, requestVoidResponse, resolveTurnEmotion, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, syncConversationHistory, thinkingModeEnabled]);

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
          const isSpeaking = !voicePlaybackControllerRef.current.isIdle(); // AI 正在外放 TTS，回声风险最高
          const isAgentBusy = textExchangeActiveRef.current || isSpeaking;

          if (isAgentBusy) {
            // 方案 A（AI 优先）：AI 思考/播报期间，先压制识别文字——不让环境音/回声被 STT 识别出的
            // 幻觉文字覆盖 AI 当前输出或误触发打断。仅当同时满足以下二者，才判定为「真实的用户打断」：
            //   1) 本地音量 VAD 二次确认真实人声（能量高于环境噪声阈值，非回声/低电平噪声幻觉）；
            //   2) STT 文本达到最小字数门槛（播报中回声风险高、门槛更严）。
            const isRealHumanVoice = voiceActivityLevelRef.current === "active";
            const minChars = isSpeaking ? BARGE_IN_MIN_CHARS_SPEAKING : BARGE_IN_MIN_CHARS_THINKING;
            if (isRealHumanVoice && trimmedText.length >= minChars) {
              // 确认打断：停 AI、作废该回合，并把用户识别文字接管到预览层。
              interruptForBargeIn();
              setVoiceTranscriptPreview(text);
              showResponseLayer({
                text,
                tone: "quiet",
                source: "voice-transcript",
                pulseKey: "voice-interim"
              });
            }
            // 未确认打断：压制，不写预览层、不打断，保护 AI 当前输出不被闪断。
            return;
          }

          // 内容闩锁开放判据（仅在 AI 空闲、非回声抑制路径评估，避免播报期回声幻觉误开闩锁）：
          // 实时预览出现「明显是新一句」——归一化后已不再是「上一条已发送定稿」的前缀（含不相等），
          // 说明用户开始说不同内容，遂开放闩锁让下一条 final 正常放行。同一句的补标点/续说预览
          // 仍是其前缀，不会误开；与豆包时序、下标、标点全解耦。
          const sentNormalized = sentVoiceUtteranceNormalizedRef.current;
          if (sentNormalized && trimmedText) {
            const interimNormalized = normalizeVoiceFinal(trimmedText);
            if (interimNormalized && !sentNormalized.startsWith(interimNormalized)) {
              sentVoiceUtteranceNormalizedRef.current = "";
            }
          }

          // AI 空闲：正常显示识别预览。
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
          // 内容闩锁（正确性基石，与豆包分句/标点/时序解耦）：本条定稿归一化后若与「上一条已发送
          // 定稿」相同，即判为同一句的重复发射（无标点稿→带标点定稿、上游抖动重发），直接丢弃。
          // 不设时间窗——无论两条 final 间隔多久、豆包是否把补标点当新句重新分句，都不会双发。
          const normalized = normalizeVoiceFinal(text);
          if (normalized && normalized === sentVoiceUtteranceNormalizedRef.current) {
            return;
          }
          sentVoiceUtteranceNormalizedRef.current = normalized;
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

  const handleOpenMemoryManager = useCallback(() => {
    setIsMemoryPanelOpen(true);
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
        emotionVisualHint={emotionVisualHint}
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
        onOpenMemoryManager={handleOpenMemoryManager}
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
      <MemoryManagerPanel isOpen={isMemoryPanelOpen} onClose={() => setIsMemoryPanelOpen(false)} />
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
// 首块保低延迟（TTFA 只由第 0 块决定），后续块显著加长使其更接近完整句，
// 减少「半句起调」造成的跨句语气突变（依据见 21 号文档 §0 根因 B2）。
const SYNTHESIS_CHUNK_MIN_CHARS_RAMP = [8, 18, 30];
// 软切封顶：无强标点（。！？；换行）的超长串，达到此长度即允许在弱停顿（逗号、顿号）处切，避免一口气憋太长
const SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS = 48;

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
  // 括号嵌套深度：进入括号内不切句，保证成对括号（含内部标点）整体落在同一块，
  // 之后 sanitizeTextForSpeech 才能把旁白整体剥离，避免旁白被切散后残留文字被朗读。
  let bracketDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (isOpenBracket(character)) {
      bracketDepth += 1;
    } else if (isCloseBracket(character) && bracketDepth > 0) {
      bracketDepth -= 1;
    }

    const isStrongBoundary = isSentenceDelimiter(character);
    const isSoftBoundary = isSoftSentenceDelimiter(character);
    if (!isStrongBoundary && !isSoftBoundary) {
      continue;
    }

    // 括号内的标点一律不作为切分边界；仅当块已超软切封顶（异常超长未闭合括号）才放弃保护，防卡死
    if (bracketDepth > 0 && index + 1 - chunkStartIndex < SYNTHESIS_CHUNK_SOFT_FLUSH_CHARS) {
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

// 开/闭括号判定：供切句阶段的括号保护使用，覆盖中文（）、英文 ()、【】、[]。
function isOpenBracket(character: string) {
  return character === "（" || character === "(" || character === "【" || character === "[";
}

function isCloseBracket(character: string) {
  return character === "）" || character === ")" || character === "】" || character === "]";
}
