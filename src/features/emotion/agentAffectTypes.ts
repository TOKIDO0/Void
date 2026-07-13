// 二期 Agent 关系情感（Affect）类型真源。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §4.2–4.3。
// 与一期 AgentEmotionState（分钟级语气天气）并行，禁止混进 emotionTypes 的五类情绪。

/**
 * 用户对 VOID 的社会事件种类（第一批；扩项须先改 33 号文档）。
 */
export type SocialEventKind =
  | "insult"
  | "mock"
  | "tease"
  | "dismiss"
  | "ignore_cold"
  | "interrupt_spam"
  | "order_only"
  | "praise"
  | "thanks"
  | "apology"
  | "soft_repair";

/**
 * 单轮社会事件识别结果：用户「怎么对待 VOID」，不是用户自己开不开心。
 */
export type SocialEventReading = {
  /** 事件种类 */
  kind: SocialEventKind;
  /** 本轮冒犯或友好强度，0–1 */
  intensity: number;
  /** 识别置信度，0–1；过低时引擎应弱处理 */
  confidence: number;
  /** 事件情感极性 */
  valence: "negative" | "positive" | "mixed";
  /** 可解释命中线索（规则名/关键词），便于调试 */
  signals: string[];
  /** 识别时间戳（epoch ms） */
  at: number;
};

/**
 * 关系向主情绪色（不等于用户此刻心情，也不等于一期五类 EmotionLabel）。
 */
export type AffectMood =
  | "steady"
  | "warm"
  | "playful"
  | "sulky"
  | "cold"
  | "wounded"
  | "defiant"
  | "caring_override";

/**
 * VOID 对用户的关系情感状态：小时级惯性，进程重启不归零。
 * 持久化键：void.agentAffectState（见 agentAffectStore）。
 */
export type AgentAffectState = {
  /** 当前关系主色 */
  mood: AffectMood;
  /** 沉浸在该 mood 的强度，0–1 */
  intensity: number;
  /** 亲近度：+亲近，-疏离，范围约 -1～+1 */
  rapport: number;
  /** 积怨：被冒犯累积，0～1，慢衰减 */
  grievance: number;
  /** 上次显著社会事件种类 */
  lastEventKind?: SocialEventKind;
  /** 上次显著事件时间 */
  lastEventAt: number;
  /** 上次演化时间 */
  updatedAt: number;
  /**
   * 硬拒窗口结束时间（epoch ms）。
   * P3 在严重冲突时写入，超时或关系修复后清除。
   */
  refuseCooldownUntil?: number;
  /** 轨迹：供衰减调试与后续策略，非给用户看 */
  history: Array<{
    mood: AffectMood;
    intensity: number;
    grievance: number;
    rapport: number;
    at: number;
  }>;
};

/** 关系情感初始态：平稳、无积怨 */
export const INITIAL_AGENT_AFFECT_STATE: AgentAffectState = {
  mood: "steady",
  intensity: 0.2,
  rapport: 0,
  grievance: 0,
  lastEventAt: 0,
  updatedAt: 0,
  history: []
};

/** 关系轨迹保留条数（略长于一期，便于小时级回看） */
export const AGENT_AFFECT_HISTORY_LIMIT = 16;

/** 全部合法 mood，供 store 校验 */
export const VALID_AFFECT_MOODS: AffectMood[] = [
  "steady",
  "warm",
  "playful",
  "sulky",
  "cold",
  "wounded",
  "defiant",
  "caring_override"
];

/** 全部合法社会事件 kind，供 store 校验 */
export const VALID_SOCIAL_EVENT_KINDS: SocialEventKind[] = [
  "insult",
  "mock",
  "tease",
  "dismiss",
  "ignore_cold",
  "interrupt_spam",
  "order_only",
  "praise",
  "thanks",
  "apology",
  "soft_repair"
];
