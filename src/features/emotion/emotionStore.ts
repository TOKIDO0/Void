// Agent 情绪状态的本地持久化。
// 设计依据：`.md/19_VOID_情绪系统专项设计文档.md` 第 7 节。
// 一期用 localStorage，Tauri 阶段再迁 SQLite。

import {
  AGENT_EMOTION_HISTORY_LIMIT,
  INITIAL_AGENT_EMOTION_STATE,
  type AgentEmotionState,
  type EmotionLabel
} from "./emotionTypes";

const AGENT_EMOTION_STORAGE_KEY = "void.emotionState";
const AGENT_EMOTION_STORAGE_VERSION = 1;

type StoredAgentEmotionPayload = {
  version: 1;
  state: AgentEmotionState;
};

const VALID_EMOTION_LABELS: EmotionLabel[] = ["neutral", "happy", "stressed", "sad", "angry"];

/**
 * 读取上次持久化的 Agent 情绪状态；不存在或损坏则回落初始态。
 * 进程重启后 VOID 情绪连续，不至于每次冷启都归零。
 */
export function loadAgentEmotionState(): AgentEmotionState {
  const rawState = window.localStorage.getItem(AGENT_EMOTION_STORAGE_KEY);
  if (!rawState) {
    return { ...INITIAL_AGENT_EMOTION_STATE };
  }

  try {
    const parsed = JSON.parse(rawState) as unknown;
    const state = extractStoredState(parsed);
    if (!state) {
      clearAgentEmotionState();
      return { ...INITIAL_AGENT_EMOTION_STATE };
    }

    return state;
  } catch {
    clearAgentEmotionState();
    return { ...INITIAL_AGENT_EMOTION_STATE };
  }
}

/**
 * 持久化 Agent 情绪状态，轨迹裁剪到上限。
 */
export function saveAgentEmotionState(state: AgentEmotionState) {
  const payload: StoredAgentEmotionPayload = {
    version: AGENT_EMOTION_STORAGE_VERSION,
    state: {
      label: state.label,
      intensity: clampUnit(state.intensity),
      updatedAt: state.updatedAt,
      history: state.history.slice(-AGENT_EMOTION_HISTORY_LIMIT)
    }
  };

  window.localStorage.setItem(AGENT_EMOTION_STORAGE_KEY, JSON.stringify(payload));
}

export function clearAgentEmotionState() {
  window.localStorage.removeItem(AGENT_EMOTION_STORAGE_KEY);
}

function extractStoredState(value: unknown): AgentEmotionState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<StoredAgentEmotionPayload>;
  if (payload.version !== AGENT_EMOTION_STORAGE_VERSION || !payload.state) {
    return null;
  }

  const state = payload.state;
  if (!isValidEmotionLabel(state.label) || typeof state.intensity !== "number") {
    return null;
  }

  return {
    label: state.label,
    intensity: clampUnit(state.intensity),
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : 0,
    history: Array.isArray(state.history)
      ? state.history
          .filter(
            (entry) =>
              entry
              && isValidEmotionLabel(entry.label)
              && typeof entry.intensity === "number"
              && typeof entry.at === "number"
          )
          .slice(-AGENT_EMOTION_HISTORY_LIMIT)
      : []
  };
}

function isValidEmotionLabel(value: unknown): value is EmotionLabel {
  return typeof value === "string" && VALID_EMOTION_LABELS.includes(value as EmotionLabel);
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
