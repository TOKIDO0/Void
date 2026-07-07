// 情绪 → 回应策略的纯映射。
// 设计依据：`.md/19_VOID_情绪系统专项设计文档.md` 第 4 节；策略措辞严格来自
// `02_VOID_Agent人格与情绪系统文档.md` 第 5 节，不自由发挥。

import type { AgentEmotionState, EmotionLabel, UserEmotionReading } from "./emotionTypes";

/** TTS 情绪表达参数（豆包 seed-tts 的 audio_params 子集，均为可选） */
export type TtsExpressionParams = {
  speechRate?: number;
  loudnessRate?: number;
  pitch?: number;
};

/** 中央流体视觉的情绪偏移提示（对当前 state profile 做小幅乘性偏移） */
export type VisualProfileHint = {
  noiseSpeedScale: number;
  edgeBoostScale: number;
  amplitudeScale: number;
};

/** policy 的完整派生结果 */
export type EmotionResponsePolicy = {
  systemPromptSuffix: string;
  ttsExpression: TtsExpressionParams;
  visualHint: VisualProfileHint;
};

/**
 * 每类用户情绪对应的 System Prompt 策略句（来自 02 号文档第 5 节回应策略列）。
 */
const USER_EMOTION_STRATEGY: Record<EmotionLabel, string> = {
  neutral: "用户情绪平稳。保持简短、高效、结构化，别打扰节奏。",
  happy: "用户偏开心或兴奋。跟着开心，但帮用户把灵感落地，别泼冷水。",
  stressed: "用户偏压力或焦虑。先降速安抚，再把问题拆成 1-3 个小步骤，不要一次灌太多信息。",
  sad: "用户偏难过或失落。先陪着，多问感受，别急着给建议、别说教。",
  angry: "用户偏愤怒或不满。让用户先说完，不反驳、不煽动，再引导他说出真正想保护的东西。"
};

/**
 * VOID 自身情绪对应的语气基调描述（Agent 有情绪，体现在语气而非括号标注）。
 */
const AGENT_TONE_BY_LABEL: Record<EmotionLabel, string> = {
  neutral: "冷静、克制",
  happy: "轻松、带一点暖意",
  stressed: "沉稳、把节奏压住",
  sad: "温和、偏关切",
  angry: "克制、不被带动"
};

/** VOID 情绪强度分档，用于措辞轻重 */
function describeIntensity(intensity: number): string {
  if (intensity >= 0.66) {
    return "较明显";
  }
  if (intensity >= 0.33) {
    return "适中";
  }
  return "轻微";
}

/** 用户情绪置信度分档 */
function describeConfidence(confidence: number): string {
  if (confidence >= 0.66) {
    return "较高";
  }
  if (confidence >= 0.4) {
    return "中";
  }
  return "偏低";
}

/**
 * 由 Agent 情绪与本轮用户情绪，派生本轮回应策略。
 */
export function deriveEmotionResponsePolicy(
  agentState: AgentEmotionState,
  reading: UserEmotionReading
): EmotionResponsePolicy {
  return {
    systemPromptSuffix: buildSystemPromptSuffix(agentState, reading),
    ttsExpression: buildTtsExpression(agentState),
    visualHint: buildVisualHint(agentState)
  };
}

function buildSystemPromptSuffix(agentState: AgentEmotionState, reading: UserEmotionReading): string {
  const userStrategy = USER_EMOTION_STRATEGY[reading.label];
  const agentTone = AGENT_TONE_BY_LABEL[agentState.label];
  const intensityLabel = describeIntensity(agentState.intensity);
  const confidenceLabel = describeConfidence(reading.confidence);

  const lines = [
    "以下是本轮情绪上下文，仅用于调节你的语气与策略，不要向用户复述这些判断：",
    `用户情绪判断：${reading.label}（置信度${confidenceLabel}）。${userStrategy}`,
    `你此刻的情绪基调：${agentTone}（强度${intensityLabel}）。情绪通过语气自然表达，不必强行加括号标注。`
  ];

  // 安全场景追加强约束（呼应 03 号 System Prompt 关怀模式）
  if (reading.safetyCritical) {
    lines.push(
      "注意：用户可能处于极端情绪或安全风险中。立即切换关怀模式，停止普通聊天逻辑，认真确认用户是否安全，并建议他联系信任的人或专业心理援助。"
    );
  }

  return lines.join("\n");
}

/**
 * TTS 表达参数：基准 1.0，按情绪小幅偏移。
 * 数值区间为设计阶段的保守初值，落地时按实测标定（见 19 号文档第 4.2 / 9 节）。
 */
function buildTtsExpression(agentState: AgentEmotionState): TtsExpressionParams {
  switch (agentState.label) {
    case "happy":
      return { speechRate: 1.08, pitch: 1.03 };
    case "stressed":
    case "sad":
      return { speechRate: 0.92, loudnessRate: 0.96 };
    case "angry":
      return { speechRate: 0.96 };
    default:
      return {};
  }
}

/**
 * 视觉偏移提示：基准 1.0 的小幅乘性偏移，clamp 由消费方叠加时保证。
 * 一期可暂不接入视觉（见 19 号文档第 4.3 节），此处先给出稳定映射。
 */
function buildVisualHint(agentState: AgentEmotionState): VisualProfileHint {
  const k = agentState.intensity;
  switch (agentState.label) {
    case "happy":
      return { noiseSpeedScale: 1 + 0.2 * k, edgeBoostScale: 1 + 0.12 * k, amplitudeScale: 1 + 0.1 * k };
    case "angry":
      return { noiseSpeedScale: 1 + 0.28 * k, edgeBoostScale: 1 + 0.24 * k, amplitudeScale: 1 + 0.06 * k };
    case "stressed":
      return { noiseSpeedScale: 1 + 0.16 * k, edgeBoostScale: 1 + 0.08 * k, amplitudeScale: 1 - 0.04 * k };
    case "sad":
      return { noiseSpeedScale: 1 - 0.22 * k, edgeBoostScale: 1 - 0.12 * k, amplitudeScale: 1 - 0.16 * k };
    default:
      return { noiseSpeedScale: 1, edgeBoostScale: 1, amplitudeScale: 1 };
  }
}
