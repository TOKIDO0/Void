// Agent 关系情感本地持久化（二期）。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §8。
// 独立键 void.agentAffectState，禁止读写一期 void.emotionState。

import {
  AGENT_AFFECT_HISTORY_LIMIT,
  INITIAL_AGENT_AFFECT_STATE,
  VALID_AFFECT_MOODS,
  VALID_SOCIAL_EVENT_KINDS,
  type AffectMood,
  type AgentAffectState,
  type SocialEventKind
} from "./agentAffectTypes";

const AGENT_AFFECT_STORAGE_KEY = "void.agentAffectState";
const AGENT_AFFECT_STORAGE_VERSION = 1;

type StoredAgentAffectPayload = {
  version: 1;
  state: AgentAffectState;
};

/**
 * 读取持久化的关系情感；损坏或不存在则回落初始态。
 * 进程重启后积怨/mood 连续，实现「记仇不会一关软件就没」。
 */
export function loadAgentAffectState(): AgentAffectState {
  const rawState = window.localStorage.getItem(AGENT_AFFECT_STORAGE_KEY);
  if (!rawState) {
    return { ...INITIAL_AGENT_AFFECT_STATE, history: [] };
  }

  try {
    const parsed = JSON.parse(rawState) as unknown;
    const state = extractStoredState(parsed);
    if (!state) {
      clearAgentAffectState();
      return { ...INITIAL_AGENT_AFFECT_STATE, history: [] };
    }
    return state;
  } catch {
    clearAgentAffectState();
    return { ...INITIAL_AGENT_AFFECT_STATE, history: [] };
  }
}

/**
 * 写入关系情感；轨迹裁剪到上限。
 */
export function saveAgentAffectState(state: AgentAffectState) {
  const payload: StoredAgentAffectPayload = {
    version: AGENT_AFFECT_STORAGE_VERSION,
    state: {
      mood: state.mood,
      intensity: clampUnit(state.intensity),
      rapport: clampRapport(state.rapport),
      grievance: clampUnit(state.grievance),
      lastEventKind: state.lastEventKind,
      lastEventAt: state.lastEventAt,
      updatedAt: state.updatedAt,
      refuseCooldownUntil: state.refuseCooldownUntil,
      history: state.history.slice(-AGENT_AFFECT_HISTORY_LIMIT)
    }
  };

  window.localStorage.setItem(AGENT_AFFECT_STORAGE_KEY, JSON.stringify(payload));
}

export function clearAgentAffectState() {
  window.localStorage.removeItem(AGENT_AFFECT_STORAGE_KEY);
}

function extractStoredState(value: unknown): AgentAffectState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<StoredAgentAffectPayload>;
  if (payload.version !== AGENT_AFFECT_STORAGE_VERSION || !payload.state) {
    return null;
  }

  const state = payload.state;
  if (!isValidAffectMood(state.mood) || typeof state.intensity !== "number") {
    return null;
  }
  if (typeof state.grievance !== "number" || typeof state.rapport !== "number") {
    return null;
  }

  const lastEventKind =
    state.lastEventKind === undefined
      ? undefined
      : isValidSocialEventKind(state.lastEventKind)
        ? state.lastEventKind
        : undefined;

  return {
    mood: state.mood,
    intensity: clampUnit(state.intensity),
    rapport: clampRapport(state.rapport),
    grievance: clampUnit(state.grievance),
    lastEventKind,
    lastEventAt: typeof state.lastEventAt === "number" ? state.lastEventAt : 0,
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : 0,
    refuseCooldownUntil:
      typeof state.refuseCooldownUntil === "number" ? state.refuseCooldownUntil : undefined,
    history: Array.isArray(state.history)
      ? state.history
          .filter(
            (entry) =>
              entry
              && isValidAffectMood(entry.mood)
              && typeof entry.intensity === "number"
              && typeof entry.grievance === "number"
              && typeof entry.rapport === "number"
              && typeof entry.at === "number"
          )
          .map((entry) => ({
            mood: entry.mood,
            intensity: clampUnit(entry.intensity),
            grievance: clampUnit(entry.grievance),
            rapport: clampRapport(entry.rapport),
            at: entry.at
          }))
          .slice(-AGENT_AFFECT_HISTORY_LIMIT)
      : []
  };
}

function isValidAffectMood(value: unknown): value is AffectMood {
  return typeof value === "string" && VALID_AFFECT_MOODS.includes(value as AffectMood);
}

function isValidSocialEventKind(value: unknown): value is SocialEventKind {
  return typeof value === "string" && VALID_SOCIAL_EVENT_KINDS.includes(value as SocialEventKind);
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function clampRapport(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, value));
}
