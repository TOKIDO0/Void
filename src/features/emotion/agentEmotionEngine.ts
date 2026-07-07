// Agent 情绪演化引擎：惯性 + 衰减 + 牵引 + 安全护栏。
// 设计依据：`.md/19_VOID_情绪系统专项设计文档.md` 第 5 节。

import {
  AGENT_EMOTION_HISTORY_LIMIT,
  type AgentEmotionState,
  type EmotionLabel,
  type UserEmotionReading
} from "./emotionTypes";

/** 惯性系数：新强度 = prev * α + target * (1-α)，偏惯性 */
const INERTIA_ALPHA = 0.6;
/** 情绪向 neutral 回落的时间常数（ms）：约 3 分钟衰减到 1/e */
const DECAY_TIME_CONSTANT_MS = 180_000;
/** 标签切换所需的最小目标强度×置信度门槛，防抖 */
const LABEL_SWITCH_THRESHOLD = 0.45;
/** 安全场景下强制的关怀基调强度 */
const SAFETY_CARE_INTENSITY = 0.85;

/**
 * 由上一状态与本轮用户情绪，演化出新的 Agent 情绪状态。
 * @param previous 上一持久化状态
 * @param reading 本轮用户情绪识别结果
 * @param now 当前时间戳（默认 Date.now，便于未来测试注入）
 */
export function evolveAgentEmotion(
  previous: AgentEmotionState,
  reading: UserEmotionReading,
  now: number = Date.now()
): AgentEmotionState {
  // 护栏优先级最高：安全场景绕过惯性，强制温和关切基调
  if (reading.safetyCritical) {
    return appendHistory(
      {
        label: "sad",
        intensity: SAFETY_CARE_INTENSITY,
        updatedAt: now,
        history: previous.history
      },
      now
    );
  }

  // 先按时间对上一状态做向 neutral 的衰减
  const decayed = decayTowardNeutral(previous, now);

  // 牵引力：用户情绪对 Agent 的影响受置信度加权
  const traction = reading.confidence;
  const targetIntensity = reading.intensity * traction;

  // 标签是否切换：需目标情绪足够强且置信，否则维持当前标签仅调强度
  const shouldSwitchLabel =
    reading.label !== "neutral"
    && reading.label !== decayed.label
    && targetIntensity >= LABEL_SWITCH_THRESHOLD;

  const nextLabel: EmotionLabel = shouldSwitchLabel ? reading.label : decayed.label;

  // 强度惯性混合：同标签向目标靠拢；切换标签时用目标强度起步
  const nextIntensity = shouldSwitchLabel
    ? targetIntensity
    : clampUnit(decayed.intensity * INERTIA_ALPHA + targetIntensity * (1 - INERTIA_ALPHA));

  return appendHistory(
    {
      label: nextLabel,
      intensity: nextIntensity,
      updatedAt: now,
      history: decayed.history
    },
    now
  );
}

/**
 * 按距上次更新的时长，将情绪强度向 neutral 指数衰减。
 * 强度衰减到很低时标签回落 neutral，模拟情绪平复。
 */
function decayTowardNeutral(state: AgentEmotionState, now: number): AgentEmotionState {
  if (state.label === "neutral" || !state.updatedAt) {
    return state;
  }

  const elapsed = Math.max(0, now - state.updatedAt);
  const decayFactor = Math.exp(-elapsed / DECAY_TIME_CONSTANT_MS);
  const decayedIntensity = clampUnit(state.intensity * decayFactor);

  if (decayedIntensity < 0.15) {
    return { label: "neutral", intensity: 0.2, updatedAt: state.updatedAt, history: state.history };
  }

  return { ...state, intensity: decayedIntensity };
}

function appendHistory(state: AgentEmotionState, now: number): AgentEmotionState {
  return {
    ...state,
    history: [
      ...state.history,
      { label: state.label, intensity: state.intensity, at: now }
    ].slice(-AGENT_EMOTION_HISTORY_LIMIT)
  };
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
