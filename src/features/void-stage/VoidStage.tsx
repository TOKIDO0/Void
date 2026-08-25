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
import { parseLocalUiCommand, type LocalUiCommand } from "../agent/localCommands/localUiCommandParser";
import type { ConfirmationDecision, ConfirmationRequest } from "../agent/permissions";
import { parseVoiceConfirmationIntent } from "../agent/permissions";
import { AgentConfirmBar } from "../agent/ui/AgentConfirmBar";
import { ExpandedResponseOverlay } from "../expanded-response/ExpandedResponseOverlay";
import { VoidResponseLayer } from "../response-layer/VoidResponseLayer";
import { loadModelConfig, updateThinkingModeEnabled } from "../settings/modelConfig";
import { ModelSettingsModal } from "../settings/ModelSettingsModal";
import { LuminousTextEntry } from "../text-entry/LuminousTextEntry";
import { VOID_VISUAL_STATE_BY_KEY, type VoidVisualState } from "../void-state/voidVisualState";
import { loadVoicePreferences, saveVoicePreferences, type VoicePreferences } from "../voice/voicePreferences";
import { loadVoiceRuntimeConfig } from "../voice/voiceRuntimeConfig";
import { VoiceSessionController } from "../voice/voiceSessionController";
import { DEFAULT_VOICE_STATE, type VoiceActivityLevel, type VoiceStateSnapshot } from "../voice/voiceState";
import { DoubaoStreamingSttProvider } from "../voice/stt/doubaoStreamingSttProvider";
import { VoiceTtsOrchestrator } from "../voice/tts/voiceTtsOrchestrator";
import { VoicePlaybackController } from "../voice/tts/voicePlaybackController";
import type { VoiceSynthesisResult } from "../voice/tts/voiceTtsContract";
import { stripLinksForSpeech } from "../voice/tts/speechTextSanitizer";
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
import { recognizeSocialEvent } from "../emotion/socialEventRecognizer";
import { evolveAgentAffect } from "../emotion/agentAffectEngine";
import { loadAgentAffectState, saveAgentAffectState } from "../emotion/agentAffectStore";
import type { AgentAffectState } from "../emotion/agentAffectTypes";
import {
  deriveBehaviorDecision,
  type BehaviorDecision
} from "../emotion/behaviorPolicy";
import {
  markTtsExpressionEmitted,
  planTtsExpression
} from "../emotion/expression/expressionPlanner";
import type { TtsExpressionAction } from "../emotion/expression/expressionTypes";
import { classifyTaskContext } from "../emotion/taskContextClassifier";
import type { VoiceSynthesisExpression } from "../voice/tts/voiceTtsContract";
import { MemoryManagerPanel } from "../memory/ui/MemoryManagerPanel";
import { resolveSkillPromptHint } from "../agent/skills/skillsBridgeClient";
import {
  clearPendingMemoryConfirmations,
  enqueuePendingMemoryConfirmation,
  hasPendingMemoryConfirmations,
  parseMemoryConfirmationIntent,
  peekPendingMemoryConfirmation,
  dequeuePendingMemoryConfirmation
} from "../memory/pendingMemoryConfirmations";
import { assessSalience } from "../memory/memorySalience";
import { assessSensitivity, resolveWriteDecision } from "../memory/memoryPolicy";
import { upsertMemoryDeduped } from "../memory/memoryStore";
import type { MemoryType, SubjectType, Sensitivity } from "../memory/memoryTypes";
import { deriveAgentRelationshipMemoryCandidate } from "../memory/agentRelationshipMemory";
import { enqueueMemoryExtraction } from "../memory/memoryExtractionQueue";
import type { SocialEventReading } from "../emotion/agentAffectTypes";

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
// 语音定稿刚发出后的短静默：这一窗口内的 residual partial / 尾音 VAD 不得打断新开的 AI 回合，
// 否则会出现「模型已开始请求 → 立刻被 barge-in abort → TTS 永远无声」。
const BARGE_IN_POST_COMMIT_GUARD_MS = 1600;
const ERROR_RESPONSE_HIDE_MS = 14000;
const THINKING_TEXT = "正在思考...";
const REGENERATING_TEXT = "正在重新思考...";
const MODEL_CONNECTION_FALLBACK_ERROR = "模型连接失败，请检查配置。";

type ThinkingModePulseDirection = "on" | "off";

export function VoidStage() {
  const [visualState, setVisualState] = useState<VoidVisualState>("idle");
  const [isModelSettingsOpen, setIsModelSettingsOpen] = useState(false);
  const [isMemoryPanelOpen, setIsMemoryPanelOpen] = useState(false);
  // 2026-08-24 信息架构调整：安全状态迁入设置模态顶部页签；该值仅在打开瞬间作为初值消费
  const [settingsInitialTab, setSettingsInitialTab] = useState<"model" | "security">("model");
  // L2/L3 极简确认条（辅路径）；主路径仍是对话/语音驱动工具
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationResolverRef = useRef<((decision: ConfirmationDecision) => void) | null>(null);
  // ref 镜像：STT final 回调可能闭包到旧 render，结算确认必须以最新 pending 为准。
  const pendingConfirmationRef = useRef<ConfirmationRequest | null>(null);
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
  // 二期关系情感（小时级）：与一期分钟级语气并行；键 void.agentAffectState，供 P1-P3 演化与门禁决策。
  const agentAffectStateRef = useRef<AgentAffectState>(loadAgentAffectState());
  // 本轮用户情绪识别结果：供对话成功结束后判定「显著情绪」并写入 emotionTrend 记忆（D4）。
  const lastEmotionReadingRef = useRef<UserEmotionReading | null>(null);
  // P6：本轮社会事件与事件前 affect 快照，供成功回合后写 agentRelationship；重新生成不累计。
  const lastSocialReadingRef = useRef<SocialEventReading | null>(null);
  const lastAffectBeforeEventRef = useRef<AgentAffectState>(agentAffectStateRef.current);
  // 语音 final 内容闩锁：记录「上一条已发送定稿」的归一化文本（空串＝闩锁开放，允许下条放行）。
  // 与桥接/豆包分句时序完全解耦地拦截同一句的重复 final（无标点稿↔带标点定稿、上游抖动重发），
  // 根治双发双回复；闩锁在 onInterimTranscript 检出「明显是新一句」时开放。见 26 号 §4.1。
  const sentVoiceUtteranceNormalizedRef = useRef<string>("");
  // 上一条语音定稿提交时刻：用于 post-commit 护窗，挡住残余 partial 误 barge-in。
  const lastVoiceCommitAtRef = useRef(0);
  // 本轮情绪派生的 TTS 表达参数：整轮一致，供流式/整段合成透传给豆包 audio_params。
  const turnTtsExpressionRef = useRef<VoiceSynthesisExpression>({});
  // P4.a 本轮最多一句 TTS-only 边界表达；不写入回复历史，也不参与工具事实结算。
  const turnTtsExpressionActionRef = useRef<TtsExpressionAction | null>(null);
  // 情绪视觉偏移：驱动中央流体 profile 的乘性偏移，需触发重渲染故用 state。
  const [emotionVisualHint, setEmotionVisualHint] = useState<VisualProfileHint>(NEUTRAL_VISUAL_HINT);
  const responseLayerHideTimeoutRef = useRef(0);
  const expandedProgressRafRef = useRef(0);
  const expandedResponseProgressRef = useRef({ value: 0 });
  const voicePlaybackControllerRef = useRef(new VoicePlaybackController());
  const voiceSessionControllerRef = useRef<VoiceSessionController | null>(null);
  const voiceInputSessionIdRef = useRef(0);
  const voiceInputCallbacksRef = useRef<{
    onInterimTranscript: (text: string) => void;
    onFinalTranscript: (text: string) => void;
    onError: (error: Error) => void;
    onInputStateChange: (inputState: VoiceStateSnapshot["inputState"]) => void;
    onActivityLevelChange: (activityLevel: VoiceActivityLevel) => void;
    onRuntimeStatusChange: (status: VoiceStateSnapshot["runtimeStatus"]) => void;
  } | null>(null);
  const voiceOutputAbortControllerRef = useRef<AbortController | null>(null);
  const voiceOutputStreamFinishedRef = useRef(true);
  // 本地音量 VAD 的最新活跃度快照（ref 供 STT 回调同步读取，避免闭包旧值）：
  // 打断判定的「真实人声」二次校验依据，"active" 表示麦克风能量高于环境噪声阈值。
  const voiceActivityLevelRef = useRef<VoiceActivityLevel>("silent");
  // 真实 TTS 播放电平信号（0-1 + 更新时间戳）；Blob fallback 不产生更新，视觉侧按超时回退模拟脉冲
  const playbackLevelSignalRef = useRef<{ value: number; updatedAt: number }>({ value: 0, updatedAt: 0 });
  // 对话回合的单调递增 id：用户打断（barge-in）时自增以「作废」当前回合的后续副作用
  const activeExchangeIdRef = useRef(0);
  const exchangeAbortControllerRef = useRef<AbortController | null>(null);
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
    exchangeAbortControllerRef.current?.abort();
    const pending = pendingConfirmationRef.current;
    const resolvePending = confirmationResolverRef.current;
    if (pending && resolvePending) {
      confirmationResolverRef.current = null;
      pendingConfirmationRef.current = null;
      setPendingConfirmation(null);
      resolvePending({
        requestId: pending.id,
        approved: false,
        decidedAt: Date.now(),
        note: "任务已取消"
      });
    }
    const controller = new AbortController();
    exchangeAbortControllerRef.current = controller;
    activeExchangeIdRef.current += 1;
    textExchangeActiveRef.current = true;
    exchangeBaseHistoryRef.current = baseHistory;
    return { exchangeId: activeExchangeIdRef.current, signal: controller.signal };
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
    // 握手失败 / 连接中断：立刻回滚「开麦」开关，避免 UI 显示在听实际已断。
    void voiceSessionControllerRef.current?.stop();
    voiceSessionControllerRef.current = null;
    setVoiceTranscriptPreview("");
    setVoicePreferences((currentPreferences) => {
      if (!currentPreferences.voiceInputEnabled) {
        return currentPreferences;
      }
      const nextPreferences = {
        ...currentPreferences,
        voiceInputEnabled: false
      };
      saveVoicePreferences(nextPreferences);
      return nextPreferences;
    });
    setVoiceState((currentState) => ({
      ...currentState,
      inputState: "mic_off",
      activityLevel: "silent",
      runtimeStatus: "error"
    }));
    if (!textExchangeActiveRef.current) {
      setVisualState("idle");
    }
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
      },
      // 阶段 2 挂账项：真实 TTS 播放电平 → 经 ref 直通 R3F useFrame，不走 setState（约 10Hz，避免重渲染）
      onLevel: (level) => {
        playbackLevelSignalRef.current.value = level;
        playbackLevelSignalRef.current.updatedAt = performance.now();
      }
    });

    return voiceOutputAbortControllerRef.current.signal;
  }, [tryCompleteVoiceOutputSession]);

  const finalizeVoiceOutputSession = useCallback((nextVisualState: VoidVisualState = "idle") => {
    voiceOutputStreamFinishedRef.current = true;
    tryCompleteVoiceOutputSession(nextVisualState);
  }, [tryCompleteVoiceOutputSession]);

  // 本轮情绪结算：
  // - 一期：识别用户情绪 → 演化短时 Agent 语气 → 持久化 → 派生 TTS/视觉/旧后缀
  // - 二期 P1/P2：识别社会事件 → 演化小时级关系情感 → 派生关系行为与 Prompt 后缀
  // 必须在创建语音批处理器之前调用，使 TTS 表达参数（整轮一致）在首句合成前就绪。
  const resolveTurnEmotion = useCallback((
    message: string,
    applySocialEvent = true
  ): EmotionResponsePolicy & { behaviorDecision: BehaviorDecision } => {
    const emotionReading = recognizeUserEmotion(message);
    // 暂存本轮识别结果，供对话成功结束后的 emotionTrend 记忆写入判定（D4）。
    lastEmotionReadingRef.current = emotionReading;
    const nextAgentEmotion = evolveAgentEmotion(agentEmotionStateRef.current, emotionReading);
    agentEmotionStateRef.current = nextAgentEmotion;
    saveAgentEmotionState(nextAgentEmotion);

    // 关系情感并行结算：与一期共用 safetyCritical，避免安全词表双写。
    // 重新生成沿用同一条用户消息，不得再次累计同一个社会事件，否则一次辱骂会被重复记仇。
    // P6 同样依赖 applySocialEvent：只有正常发送才记下社会事件，成功后才写长期关系档案。
    const previousAffect = agentAffectStateRef.current;
    const socialReading = applySocialEvent ? recognizeSocialEvent(message) : null;
    lastAffectBeforeEventRef.current = previousAffect;
    lastSocialReadingRef.current = socialReading;
    const nextAgentAffect = evolveAgentAffect(previousAffect, socialReading, {
      safetyCritical: emotionReading.safetyCritical
    });
    agentAffectStateRef.current = nextAgentAffect;
    saveAgentAffectState(nextAgentAffect);

    // P3：任务情境与关系状态共同决定合作档位；安全/健康和重要数据保全不可被情绪拒绝。
    const taskContext = classifyTaskContext(message, {
      affectState: nextAgentAffect,
      socialEvent: socialReading,
      safetyCritical: emotionReading.safetyCritical
    });
    const baseBehaviorDecision = deriveBehaviorDecision(
      nextAgentAffect,
      emotionReading,
      taskContext
    );
    const behaviorDecision: BehaviorDecision = {
      ...baseBehaviorDecision,
      expressionPlan: planTtsExpression(message, baseBehaviorDecision)
    };
    const emotionPolicy = deriveEmotionResponsePolicy(nextAgentEmotion, emotionReading);
    // TTS 表达走 ref（整轮一致，合成时读取）；视觉偏移走 state（驱动中央流体重渲染）。
    turnTtsExpressionRef.current = emotionPolicy.ttsExpression;
    turnTtsExpressionActionRef.current = behaviorDecision.expressionPlan[0] ?? null;
    setEmotionVisualHint(emotionPolicy.visualHint);
    return { ...emotionPolicy, behaviorDecision };
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
    /** 来源标记；普通对话事实默认 conversation，P6 关系事件用 agentAffect。 */
    source?: string;
    /** 置信度；缺省 0.6，P6 可透传社会事件置信度。 */
    confidence?: number;
  }) => {
    const decision = resolveWriteDecision({
      memoryType: candidate.memoryType,
      subjectType: candidate.subjectType,
      content: candidate.content,
      sensitivity: candidate.sensitivity
    });
    if (decision.action === "blocked") {
      return;
    }
    // 阶段 AA（42 号文档）：confirm 候选进入对话式确认队列（不弹窗），
    // 由回复收尾询问 + 用户下一句话结算；auto 候选维持原直写路径。
    if (decision.action === "confirm") {
      enqueuePendingMemoryConfirmation({
        memoryType: candidate.memoryType,
        subjectType: candidate.subjectType,
        subjectName: candidate.subjectName,
        content: candidate.content,
        sensitivity: candidate.sensitivity,
        mergeWindowMs: candidate.mergeWindowMs,
        source: candidate.source,
        confidence: candidate.confidence
      });
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
        confidence: candidate.confidence ?? 0.6,
        source: candidate.source ?? "conversation",
        sensitivity: candidate.sensitivity,
        createdAt: now,
        updatedAt: now
      },
      { mergeWindowMs: candidate.mergeWindowMs }
    );
  }, []);

  /**
   * 阶段 AA：把队首待确认记忆写成正式条目（approve）或丢弃（reject）。
   * 结算后若队列仍有候选，返回 true 提示调用方继续追加下一条询问。
   */
  const settlePendingMemoryConfirmation = useCallback((approved: boolean) => {
    const candidate = dequeuePendingMemoryConfirmation();
    if (!candidate) {
      return false;
    }
    if (approved) {
      const now = Date.now();
      upsertMemoryDeduped(
        {
          id: crypto.randomUUID(),
          memoryType: candidate.memoryType,
          subjectType: candidate.subjectType,
          subjectName: candidate.subjectName,
          content: candidate.content,
          confidence: candidate.confidence ?? 0.7,
          source: candidate.source ?? "conversation",
          sensitivity: candidate.sensitivity,
          createdAt: now,
          updatedAt: now
        },
        { mergeWindowMs: candidate.mergeWindowMs }
      );
    }
    return hasPendingMemoryConfirmations();
  }, []);

  /** 回复收尾询问话术：队首候选的人话确认句（进文字层与 TTS，不进对话历史）。 */
  const buildPendingMemoryAskMessage = useCallback(() => {
    const candidate = peekPendingMemoryConfirmation();
    if (!candidate) {
      return null;
    }
    const subjectPrefix = candidate.subjectName ? `${candidate.subjectName}的` : "";
    return `对了，你刚才提到「${subjectPrefix}${candidate.content}」。要把这条记进长期记忆吗？说「记下来」或「不用」就行。`;
  }, []);

  // D2 用户输入自动写入：本地 salience 准入后，后台 LLM 拆条提炼再落库。
  // - 不 await：不挡主回复 / TTS / UI
  // - 失败不写整句原文，避免「家人」等噪声把主体/分区带偏
  // - 仅对用户本人说的话建档，不含 AI 回复
  const captureMemoryFromUserMessage = useCallback((message: string) => {
    const content = message.trim();
    if (!content) {
      return;
    }

    // 准入闸：只认「陈述性自述 / 明确记住指令」；问句与关键词点名一律不写。
    if (!assessSalience(content).worth) {
      return;
    }

    // 快照当前模型配置；后台任务不读 UI 最新态，避免用户改设置中途串配置
    const modelConfig = loadModelConfig();
    enqueueMemoryExtraction({
      userMessage: content,
      modelConfig,
      onPersist: (facts) => {
        for (const fact of facts) {
          persistCandidateMemory({
            memoryType: fact.memoryType,
            subjectType: fact.subjectType,
            subjectName: fact.subjectName,
            content: fact.content,
            sensitivity: fact.sensitivity,
            confidence: fact.confidence,
            source: "conversation-llm-extract"
          });
        }
      }
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

  // P6：显著关系事件写入 agentRelationship。
  // - 只消费 SocialEventReading + 事件前 affect，不新开第二套识别。
  // - 仅正常发送成功路径调用；重新生成不调用，避免同一事件重复累计。
  // - 中性摘要 + 6 小时同类合并；不存原话、分数、健康或亲属信息。
  const captureAgentRelationshipMemory = useCallback(() => {
    const candidate = deriveAgentRelationshipMemoryCandidate(
      lastSocialReadingRef.current,
      lastAffectBeforeEventRef.current
    );
    if (!candidate) {
      return;
    }

    persistCandidateMemory({
      memoryType: candidate.memoryType,
      subjectType: candidate.subjectType,
      subjectName: candidate.subjectName,
      content: candidate.content,
      sensitivity: candidate.sensitivity,
      source: candidate.source,
      confidence: candidate.confidence,
      mergeWindowMs: candidate.mergeWindowMs
    });
  }, [persistCandidateMemory]);

  const settleConfirmation = useCallback((decision: ConfirmationDecision) => {
    const resolve = confirmationResolverRef.current;
    confirmationResolverRef.current = null;
    pendingConfirmationRef.current = null;
    setPendingConfirmation(null);
    resolve?.(decision);
  }, []);

  /**
   * 阶段 F2：当确认条挂起时，用户说「好/取消」或打同样文字，直接过权限门，
   * 不再开一轮新的对话。解析不到明确意图时返回 false，走正常消息路径。
   */
  const trySettlePendingConfirmationByUtterance = useCallback((utterance: string) => {
    const pending = pendingConfirmationRef.current;
    if (!pending || !confirmationResolverRef.current) {
      return false;
    }

    const intent = parseVoiceConfirmationIntent(utterance);
    if (!intent) {
      return false;
    }

    settleConfirmation({
      requestId: pending.id,
      approved: intent === "approve",
      decidedAt: Date.now(),
      note: intent === "approve" ? "用户口头/文字确认" : "用户口头/文字取消"
    });
    showResponseLayer({
      text: intent === "approve" ? "已确认，继续执行…" : "已取消该操作。",
      tone: "thinking",
      source: "text",
      pulseKey: intent === "approve" ? "tool-confirm-approved" : "tool-confirm-rejected"
    });
    return true;
  }, [settleConfirmation, showResponseLayer]);

  const requestConfirmation = useCallback((request: ConfirmationRequest) => {
    return new Promise<ConfirmationDecision>((resolve) => {
      // 若上一条未决，先按拒绝收口，避免悬挂
      if (confirmationResolverRef.current) {
        confirmationResolverRef.current({
          requestId: pendingConfirmationRef.current?.id ?? request.id,
          approved: false,
          decidedAt: Date.now(),
          note: "被新的确认请求替换"
        });
      }
      confirmationResolverRef.current = resolve;
      pendingConfirmationRef.current = request;
      setPendingConfirmation(request);
      showResponseLayer({
        text: "需要你确认后才能继续。你可以说「好」或「取消」。",
        tone: "thinking",
        source: "text",
        pulseKey: "tool-confirm"
      });
    });
  }, [showResponseLayer]);

  const requestVoidResponse = useCallback((
    message: string,
    history: VoidConversationMessage[],
    attachments: VoidConversationAttachment[] = [],
    onStreamContent: ((content: string) => void) | undefined,
    emotionSystemPromptSuffix: string,
    behaviorDecision: BehaviorDecision,
    signal: AbortSignal,
    skillPromptHint?: string
  ) => {
    const modelConfig = {
      ...loadModelConfig(),
      thinkingModeEnabled
    };
    // 工具循环内部非流式；仅纯聊天且 openai-compatible 时流式
    const canStream =
      modelConfig.streamEnabled
      && modelConfig.provider === "openai-compatible";
    let streamedContent = "";
    let didStartStreaming = false;

    return sendVoidMessage(
      message,
      history,
      {
        ...modelConfig,
        streamEnabled: canStream
      },
      attachments,
      canStream
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
        : undefined,
      emotionSystemPromptSuffix,
      behaviorDecision.systemPromptAffectSuffix,
      {
        requestConfirmation,
        behaviorDecision,
        signal,
        skillPromptHint,
        onProgress: (progressMessage) => {
          if (!progressMessage.trim()) {
            return;
          }
          showResponseLayer({
            text: progressMessage,
            tone: "thinking",
            source: "text",
            pulseKey: "tool-progress"
          });
        }
      }
    );
  }, [requestConfirmation, showResponseLayer, thinkingModeEnabled]);

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

    // 送入合成前剥离括号情绪标注；P4.a 插句仅进入 TTS，不写入显示或历史。
    const speechText = sanitizeTextForSpeech(responseText);
    const expressionAction = turnTtsExpressionActionRef.current;
    const speechSegments = [expressionAction?.text ?? "", speechText].filter(Boolean);
    if (!speechSegments.length) {
      setVisualState("idle");
      return;
    }

    const runtimeConfig = loadVoiceRuntimeConfig();
    if (!runtimeConfig.doubaoSpeakerId.trim()) {
      console.warn("[VOID TTS] 语音输出已开启，但缺少 doubaoSpeakerId，无法合成。");
      setVisualState("idle");
      return;
    }

    const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
    const signal = startVoiceOutputSession();
    await orchestrator.synthesizeSentences(
      speechSegments,
      {
        requestMode: runtimeConfig.requestMode,
        voiceMode: "default",
        preferredGender: "female",
        scene: "default",
        // 插句与普通回复复用同一整轮表达参数，禁止逐句改变音色或语速。
        expression: turnTtsExpressionRef.current
      },
      ({ index, result }) => {
        if (signal.aborted) {
          if ("audioUrl" in result) {
            URL.revokeObjectURL(result.audioUrl);
          } else {
            void result.pcmStream.cancel();
          }
          return;
        }

        enqueueSynthesisResult(voicePlaybackControllerRef.current, result);
        if (expressionAction && index === 0) {
          markTtsExpressionEmitted(expressionAction);
          if (turnTtsExpressionActionRef.current === expressionAction) {
            turnTtsExpressionActionRef.current = null;
          }
        }
      },
      signal
    );
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
          if ("audioUrl" in result) {
            URL.revokeObjectURL(result.audioUrl);
          } else {
            void result.pcmStream.cancel();
          }
          return;
        }

        enqueueSynthesisResult(voicePlaybackControllerRef.current, result);
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
    if (!runtimeConfig.doubaoSpeakerId.trim()) {
      console.warn("[VOID TTS] 语音输出已开启，但缺少 doubaoSpeakerId，流式语音不会发声。");
      return null;
    }

    const orchestrator = new VoiceTtsOrchestrator(runtimeConfig);
    const signal = startVoiceOutputSession();
    const expressionAction = turnTtsExpressionActionRef.current;
    let didQueueExpression = false;
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
      ({ index, result }) => {
        if (signal.aborted) {
          if ("audioUrl" in result) {
            URL.revokeObjectURL(result.audioUrl);
          } else {
            void result.pcmStream.cancel();
          }
          return;
        }

        enqueueSynthesisResult(voicePlaybackControllerRef.current, result);
        if (expressionAction && didQueueExpression && index === 0) {
          markTtsExpressionEmitted(expressionAction);
          if (turnTtsExpressionActionRef.current === expressionAction) {
            turnTtsExpressionActionRef.current = null;
          }
        }
      },
      signal
    );
    let synthesizedCursor = 0;
    // 本轮已产出的合成块数量，供渐进式阈值定位（首块最短、后续渐长）
    let emittedChunkCount = 0;

    const pushSpeechSentences = (sentences: string[]) => {
      const speechSentences = sentences.map(sanitizeTextForSpeech).filter(Boolean);
      if (!speechSentences.length) {
        return;
      }

      if (expressionAction && !didQueueExpression) {
        didQueueExpression = true;
        synthesisSession.push([expressionAction.text]);
      }
      synthesisSession.push(speechSentences);
    };

    return {
      push(content: string) {
        const segment = content.slice(synthesizedCursor);
        const { sentences, consumedLength } = extractReadySentences(segment, false, emittedChunkCount);
        if (!sentences.length) {
          return;
        }

        synthesizedCursor += consumedLength;
        emittedChunkCount += sentences.length;
        pushSpeechSentences(sentences);
      },
      async complete(content: string) {
        const segment = content.slice(synthesizedCursor);
        const { sentences, consumedLength } = extractReadySentences(segment, true, emittedChunkCount);
        synthesizedCursor += consumedLength;
        emittedChunkCount += sentences.length;
        if (sentences.length) {
          pushSpeechSentences(sentences);
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
    // 这里必须读取真实会话，而不是依赖 voiceInputEnabled state。
    // 开麦会更新偏好 state；若此回调随之换引用，组件清理 effect 会误判为卸载并关闭正在握手的 STT。
    resetVoiceOutputState(voiceSessionControllerRef.current ? "listening" : "idle");
  }, [resetVoiceOutputState]);

  // 用户在 AI 思考/播报时开口即打断：停止播报、作废当前回合的后续副作用，并回滚乐观历史。
  const interruptForBargeIn = useCallback(() => {
    const wasGenerating = textExchangeActiveRef.current;
    activeExchangeIdRef.current += 1;
    exchangeAbortControllerRef.current?.abort();
    exchangeAbortControllerRef.current = null;
    const pending = pendingConfirmationRef.current;
    if (pending) {
      settleConfirmation({
        requestId: pending.id,
        approved: false,
        decidedAt: Date.now(),
        note: "任务已取消"
      });
    }
    textExchangeActiveRef.current = false;
    stopVoicePlayback();
    if (wasGenerating) {
      // 模型仍在生成：回滚到回合开始前的历史，丢弃这一被打断的问答，避免残留与过期提交
      commitConversationHistory(exchangeBaseHistoryRef.current);
    }
  }, [commitConversationHistory, settleConfirmation, stopVoicePlayback]);

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

  // 本地 UI 指令执行器：命中纯控制指令时直接操作 UI 并给一句简短反馈，不进模型对话。
  // 返回 true 表示已消费该输入（短路对话）；thinking 非独立句时切换后仍继续对话。
  const tryExecuteLocalUiCommand = useCallback((command: LocalUiCommand): boolean => {
    const acknowledge = (text: string) => {
      showResponseLayer({
        text,
        tone: "quiet",
        source: "text",
        pulseKey: "local-ui-command"
      });
      scheduleResponseLayerHide();
    };

    if (command.kind === "modal") {
      if (command.target === "settings") {
        setSettingsInitialTab("model");
        setIsModelSettingsOpen(command.open);
      } else if (command.target === "memory") {
        setIsMemoryPanelOpen(command.open);
      } else if (command.target === "security") {
        // 「打开安全面板」→ 设置中心的安全状态页签
        setSettingsInitialTab("security");
        setIsModelSettingsOpen(command.open);
      } else if (command.open) {
        openExpandedResponse();
        if (!conversationHistoryRef.current.length) {
          acknowledge("还没有历史记录，先聊几句再看吧。");
          return true;
        }
      } else {
        closeExpandedResponse();
      }
      return true;
    }

    if (command.kind === "voiceInput") {
      updateVoicePreferences({
        ...voicePreferences,
        voiceInputEnabled: command.enable
      });
      // 关麦后 STT 停止，语音无法再下指令——必须明确告知只剩打字。
      acknowledge(command.enable ? "麦克风已打开，我在听。" : "麦克风已关闭，之后请用文字跟我交流。");
      return true;
    }

    if (command.kind === "voiceOutput") {
      updateVoicePreferences({
        ...voicePreferences,
        voiceOutputEnabled: command.enable
      });
      if (!command.enable) {
        stopVoicePlayback();
      }
      acknowledge(command.enable ? "语音播报已打开。" : "语音播报已关闭。");
      return true;
    }

    // thinking：独立句是纯控制指令；带要求的句子只切换模式，继续走对话。
    handleThinkingModeChange(command.enable);
    if (command.standalone) {
      acknowledge(command.enable ? "深度思考模式已开启。" : "深度思考模式已关闭。");
      return true;
    }
    return false;
  }, [closeExpandedResponse, handleThinkingModeChange, openExpandedResponse, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, updateVoicePreferences, voicePreferences]);

  const handleTextMessage = useCallback(async (message: string, attachments: VoidConversationAttachment[]) => {
    // 确认门挂起时，短指令「好/取消」优先结算，不新开对话。
    if (attachments.length === 0 && trySettlePendingConfirmationByUtterance(message)) {
      return;
    }

    // 阶段 AA：待确认记忆挂起时，「记下来/不用」结算写入或丢弃；解析不了走正常对话。
    if (attachments.length === 0 && hasPendingMemoryConfirmations()) {
      const memoryIntent = parseMemoryConfirmationIntent(message);
      if (memoryIntent) {
        const hasMoreCandidates = settlePendingMemoryConfirmation(memoryIntent === "approve");
        const followUpAsk = hasMoreCandidates ? buildPendingMemoryAskMessage() : null;
        showResponseLayer({
          text: memoryIntent === "approve"
            ? (followUpAsk ?? "好，已经记进长期记忆了。")
            : (followUpAsk ?? "好，这条就不记了。"),
          tone: "quiet",
          source: "text",
          pulseKey: memoryIntent === "approve" ? "memory-confirm-approve" : "memory-confirm-reject"
        });
        scheduleResponseLayerHide();
        return;
      }
    }

    // 本地 UI 指令（打开设置/历史/记忆、开关麦克风/语音/思考模式）先于对话链路识别。
    if (attachments.length === 0) {
      const localCommand = parseLocalUiCommand(message);
      if (localCommand && tryExecuteLocalUiCommand(localCommand)) {
        return;
      }
    }

    const previousHistory = conversationHistoryRef.current;
    const { exchangeId, signal } = beginExchange(previousHistory);
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

      const assistantResponse = await requestVoidResponse(
        message,
        previousHistory,
        attachments,
        syncStreamingAssistantMessage,
        emotionPolicy.systemPromptSuffix,
        emotionPolicy.behaviorDecision,
        signal,
        // 阶段 Y：命中本地技能剧本时注入提示；解析失败/超时为 null 零副作用
        await resolveSkillPromptHint(message, signal)
      );
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：放弃本回合的历史提交与 UI/语音收尾（历史已回滚）
      }
      // 本回合成功结束（未被打断）：用户事实、情绪趋势、显著关系事件分别建档。
      // 重新生成路径不调用本段，避免同一社会事件重复累计到 agentRelationship。
      captureMemoryFromUserMessage(message);
      captureEmotionTrendMemory();
      captureAgentRelationshipMemory();
      // 阶段 AA：建档可能产生待确认候选（健康/敏感）——拼进回复末尾做对话式询问。
      // 询问句随回复进对话历史（用户答「记下来/不用」时模型有上下文）。
      const memoryAskMessage = buildPendingMemoryAskMessage();
      const finalReplyContent = memoryAskMessage
        ? `${assistantResponse.content}\n\n${memoryAskMessage}`
        : assistantResponse.content;
      const finalConversationHistory = finalizeAssistantStreamContent(streamState, finalReplyContent);
      commitConversationHistory(finalConversationHistory);
      if (streamingVoiceBatcher) {
        if (memoryAskMessage) {
          streamingVoiceBatcher.push(`\n\n${memoryAskMessage}`);
        }
        await streamingVoiceBatcher.complete(finalReplyContent);
        showResponseLayer({
          text: stripStageDirections(finalReplyContent),
          tone: "quiet",
          source: "text",
          pulseKey: "complete"
        });
        scheduleResponseLayerHide();
        textExchangeActiveRef.current = false;
        return;
      }
      await completeTextResponseWithErrorHandling(finalReplyContent, "complete");
    } catch (error) {
      if (activeExchangeIdRef.current !== exchangeId) {
        return; // 已被打断：忽略本回合的错误
      }
      failTextResponse(error, "error", latestConversationHistory, streamState.assistantMessageIndex);
    }
  }, [beginExchange, captureAgentRelationshipMemory, captureEmotionTrendMemory, captureMemoryFromUserMessage, commitConversationHistory, completeTextResponseWithErrorHandling, createStreamingVoiceBatcher, settlePendingMemoryConfirmation, buildPendingMemoryAskMessage, failTextResponse, requestVoidResponse, resolveTurnEmotion, scheduleResponseLayerHide, showResponseLayer, stopVoicePlayback, syncConversationHistory, thinkingModeEnabled, tryExecuteLocalUiCommand, trySettlePendingConfirmationByUtterance]);

  const handleRegenerateLatestUserMessage = useCallback(async (messageIndex: number, content: string) => {
    const currentHistory = conversationHistoryRef.current;
    const targetMessage = currentHistory[messageIndex];

    if (!targetMessage || targetMessage.role !== "user") {
      return;
    }

    const historyBeforeEditedMessage = currentHistory.slice(0, messageIndex);
    const { exchangeId, signal } = beginExchange(historyBeforeEditedMessage);
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
    const emotionPolicy = resolveTurnEmotion(content, false);
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
        emotionPolicy.systemPromptSuffix,
        emotionPolicy.behaviorDecision,
        signal,
        // 阶段 Y：重新生成同样按原文匹配技能剧本
        await resolveSkillPromptHint(content, signal)
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

  const handleVoiceInterimTranscript = useCallback((text: string) => {
    const trimmedText = text.trim();
    const isSpeaking = !voicePlaybackControllerRef.current.isIdle();
    const isAgentBusy = textExchangeActiveRef.current || isSpeaking;
    const interimNormalized = trimmedText ? normalizeVoiceFinal(trimmedText) : "";
    const sentNormalized = sentVoiceUtteranceNormalizedRef.current;

    if (isAgentBusy) {
      if (!trimmedText || !interimNormalized) return;
      const inPostCommitGuard = Date.now() - lastVoiceCommitAtRef.current < BARGE_IN_POST_COMMIT_GUARD_MS;
      const isEchoOfLastCommit = Boolean(
        sentNormalized
        && (
          interimNormalized === sentNormalized
          || sentNormalized.startsWith(interimNormalized)
          || interimNormalized.startsWith(sentNormalized)
        )
      );
      if (inPostCommitGuard || isEchoOfLastCommit) return;

      const isRealHumanVoice = voiceActivityLevelRef.current === "active";
      const minChars = isSpeaking ? BARGE_IN_MIN_CHARS_SPEAKING : BARGE_IN_MIN_CHARS_THINKING;
      if (isRealHumanVoice && interimNormalized.length >= minChars) {
        interruptForBargeIn();
        setVoiceTranscriptPreview(text);
        showResponseLayer({
          text,
          tone: "quiet",
          source: "voice-transcript",
          pulseKey: "voice-interim"
        });
      }
      return;
    }

    if (sentNormalized && interimNormalized && !sentNormalized.startsWith(interimNormalized)) {
      sentVoiceUtteranceNormalizedRef.current = "";
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
  }, [interruptForBargeIn, showResponseLayer]);

  const handleVoiceFinalTranscript = useCallback((text: string) => {
    setVoiceTranscriptPreview("");
    const normalized = normalizeVoiceFinal(text);
    if (normalized && normalized === sentVoiceUtteranceNormalizedRef.current) return;
    sentVoiceUtteranceNormalizedRef.current = normalized;
    lastVoiceCommitAtRef.current = Date.now();
    void handleTextMessage(text, []);
  }, [handleTextMessage]);

  voiceInputCallbacksRef.current = {
    onInterimTranscript: handleVoiceInterimTranscript,
    onFinalTranscript: handleVoiceFinalTranscript,
    onError: handleVoiceSessionError,
    onInputStateChange: (inputState) => {
      setVoiceState((current) => ({ ...current, inputState }));
      if (textExchangeActiveRef.current || !voicePlaybackControllerRef.current.isIdle()) return;
      if (inputState === "listening") setVisualState("listening");
      if (inputState === "transcribing") setVisualState("thinking");
      if (inputState === "standby") setVisualState("idle");
    },
    onActivityLevelChange: (activityLevel) => {
      voiceActivityLevelRef.current = activityLevel;
      setVoiceState((current) => ({ ...current, activityLevel }));
    },
    onRuntimeStatusChange: (runtimeStatus) => {
      setVoiceState((current) => ({ ...current, runtimeStatus }));
    }
  };

  // 偏好只表达用户期望；真实 STT 生命周期由本 effect 唯一拥有。
  // 冷启动默认开启时会立即创建会话，旧 session 的迟到回调由单调 id 丢弃。
  useEffect(() => {
    const sessionId = voiceInputSessionIdRef.current + 1;
    voiceInputSessionIdRef.current = sessionId;

    if (!voicePreferences.voiceInputEnabled) {
      const previousController = voiceSessionControllerRef.current;
      voiceSessionControllerRef.current = null;
      void previousController?.stop();
      setVoiceTranscriptPreview("");
      voiceActivityLevelRef.current = "silent";
      setVoiceState((current) => ({
        ...current,
        inputState: "mic_off",
        activityLevel: "silent",
        runtimeStatus: "off"
      }));
      if (!textExchangeActiveRef.current && voicePlaybackControllerRef.current.isIdle()) setVisualState("idle");
      return;
    }

    const currentCallbacks = () => voiceInputCallbacksRef.current;
    const controller = new VoiceSessionController({
      sttProvider: new DoubaoStreamingSttProvider(),
      onInterimTranscript: (text) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onInterimTranscript(text);
      },
      onFinalTranscript: (text) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onFinalTranscript(text);
      },
      onError: (error) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onError(error);
      },
      onInputStateChange: (state) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onInputStateChange(state);
      },
      onActivityLevelChange: (level) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onActivityLevelChange(level);
      },
      onRuntimeStatusChange: (status) => {
        if (voiceInputSessionIdRef.current === sessionId) currentCallbacks()?.onRuntimeStatusChange(status);
      }
    });
    voiceSessionControllerRef.current = controller;
    void controller.start();

    return () => {
      if (voiceInputSessionIdRef.current === sessionId) {
        voiceInputSessionIdRef.current += 1;
      }
      if (voiceSessionControllerRef.current === controller) {
        voiceSessionControllerRef.current = null;
      }
      void controller.stop();
    };
  }, [voicePreferences.voiceInputEnabled]);

  const handleVoiceInputToggle = useCallback(() => {
    updateVoicePreferences({
      ...voicePreferences,
      voiceInputEnabled: !voicePreferences.voiceInputEnabled
    });
  }, [updateVoicePreferences, voicePreferences]);

  const handleOpenModelConfig = useCallback(() => {
    setSettingsInitialTab("model");
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
      activeExchangeIdRef.current += 1;
      exchangeAbortControllerRef.current?.abort();
      exchangeAbortControllerRef.current = null;
      const pending = pendingConfirmationRef.current;
      if (pending && confirmationResolverRef.current) {
        confirmationResolverRef.current({
          requestId: pending.id,
          approved: false,
          decidedAt: Date.now(),
          note: "任务已取消"
        });
        confirmationResolverRef.current = null;
        pendingConfirmationRef.current = null;
      }
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
        playbackLevelSignal={playbackLevelSignalRef}
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
      <ModelSettingsModal
        isOpen={isModelSettingsOpen}
        onClose={() => setIsModelSettingsOpen(false)}
        initialTab={settingsInitialTab}
      />
      <MemoryManagerPanel isOpen={isMemoryPanelOpen} onClose={() => setIsMemoryPanelOpen(false)} />
      {pendingConfirmation ? (
        <AgentConfirmBar
          request={pendingConfirmation}
          onApprove={() => {
            settleConfirmation({
              requestId: pendingConfirmation.id,
              approved: true,
              decidedAt: Date.now()
            });
          }}
          onReject={() => {
            settleConfirmation({
              requestId: pendingConfirmation.id,
              approved: false,
              decidedAt: Date.now(),
              note: "用户拒绝了该操作"
            });
          }}
        />
      ) : null}
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

/** 把合成结果分发给播放控制器：PCM 走 AudioWorklet，URL 走 HTMLAudio 队列。 */
function enqueueSynthesisResult(
  playbackController: VoicePlaybackController,
  result: VoiceSynthesisResult
) {
  if ("pcmStream" in result) {
    playbackController.enqueuePcmStream(result.pcmStream, result.sampleRate, result.sessionId);
    return;
  }
  playbackController.enqueue(result.audioUrl);
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
  return stripLinksForSpeech(stripStageDirections(text))
    // 成对括号及其内容：中文（）、英文 ()、【】、[]
    .replace(/（[^（）]*）/g, "")
    .replace(/\([^()]*\)/g, "")
    .replace(/【[^【】]*】/g, "")
    .replace(/\[[^[\]]*\]/g, "")
    // 流式分块可能把一对括号切散，残留的孤立括号符号一并清除
    .replace(/[（）()【】[\]]/g, "")
    // 防止不完整流块残留孤立的 Markdown 控制符进入 TTS。
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
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
