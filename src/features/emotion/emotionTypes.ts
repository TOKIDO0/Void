// 情绪系统类型定义（唯一真源）。
// 设计依据：`.md/19_VOID_情绪系统专项设计文档.md` 第 1 节，情绪标签与 `02_VOID_Agent人格与情绪系统文档.md` 第 5 节五类严格对齐。

/**
 * 情绪标签：仅此五类 + neutral。
 * 扩项必须先修改 `02` 号人格文档，再改本枚举，不得擅自新增。
 */
export type EmotionLabel =
  | "neutral" // 平静 / 专注（默认态）
  | "happy" // 开心 / 兴奋
  | "stressed" // 压力 / 焦虑
  | "sad" // 难过 / 失落
  | "angry"; // 愤怒 / 不满

/**
 * 用户侧情绪识别结果：对单轮用户输入的一次判定。
 */
export type UserEmotionReading = {
  /** 主情绪标签 */
  label: EmotionLabel;
  /** 本轮该情绪的强度，0–1 */
  intensity: number;
  /** 识别置信度，0–1；低置信度不驱动强反应 */
  confidence: number;
  /** 命中的可解释线索，便于调试与记忆写入 */
  signals: {
    /** 文本线索：命中的负面词 / 否定 / 重复 / 标点密度等规则名 */
    text?: string[];
    /** 声学线索（语音链路接入后才有）：语速 / 停顿 / 音量 */
    acoustic?: string[];
  };
  /** 识别所用信号来源 */
  source: "text" | "text+acoustic";
  /** 识别时间戳（epoch ms） */
  at: number;
  /** 是否命中安全高优先场景（自伤 / 身体症状 / 危险行为），命中时压过情绪演化 */
  safetyCritical: boolean;
};

/**
 * Agent 侧情绪状态：VOID 自身带惯性的持续情绪，不是每轮识别结果的镜像。
 */
export type AgentEmotionState = {
  /** 当前主情绪 */
  label: EmotionLabel;
  /** 当前强度，0–1 */
  intensity: number;
  /** 上次演化时间戳（epoch ms） */
  updatedAt: number;
  /** 近 N 轮轨迹，供衰减 / 趋势判断与视觉平滑 */
  history: Array<{
    label: EmotionLabel;
    intensity: number;
    at: number;
  }>;
};

/** Agent 情绪初始态 */
export const INITIAL_AGENT_EMOTION_STATE: AgentEmotionState = {
  label: "neutral",
  intensity: 0.2,
  updatedAt: 0,
  history: []
};

/** 情绪轨迹保留的最大轮数 */
export const AGENT_EMOTION_HISTORY_LIMIT = 8;
