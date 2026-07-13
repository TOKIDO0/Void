// Agent 关系情感演化引擎：小时级衰减 + 社会事件施加 + 安全护栏。
// 设计依据：`.md/33_VOID_Agent主体情绪与关系情感系统设计文档.md` §5。
// 不做任务门禁、不写 Prompt 后缀（那是 P2/P3）。

import {
  AGENT_AFFECT_HISTORY_LIMIT,
  type AffectMood,
  type AgentAffectState,
  type SocialEventReading
} from "./agentAffectTypes";

/** 积怨半衰减时间：约 3 小时消一半（33 §12） */
const GRIEVANCE_HALF_LIFE_MS = 3 * 60 * 60 * 1000;
/** mood 强度向 steady 回落的半衰减：约 1.5 小时 */
const MOOD_HALF_LIFE_MS = 1.5 * 60 * 60 * 1000;
/** 事件牵引力门槛：过低置信度只做极弱改动 */
const EVENT_APPLY_MIN_CONFIDENCE = 0.35;
/** 安全场景强制关切强度 */
const SAFETY_CARE_INTENSITY = 0.9;
/** 严重冒犯后的硬拒窗口：短时存在，积怨本身仍按小时衰减。 */
const HARD_REFUSE_WINDOW_MS = 10 * 60 * 1000;

export type EvolveAgentAffectOptions = {
  /** 复用一期用户情绪识别的安全标记，命中则 mood 强制 caring_override */
  safetyCritical?: boolean;
  /** 当前时间，便于调参加速衰减验收 */
  now?: number;
};

/**
 * 由上一关系状态与本轮社会事件，演化新的 AgentAffectState。
 * @param previous 上一持久化状态
 * @param reading 本轮社会事件；null 表示无事件，只走时间衰减
 */
export function evolveAgentAffect(
  previous: AgentAffectState,
  reading: SocialEventReading | null,
  options: EvolveAgentAffectOptions = {}
): AgentAffectState {
  const now = options.now ?? Date.now();

  // 1) 先按小时级时间常数做自然回落
  const decayed = decayAffectState(previous, now);

  // 2) 再施加本轮事件（安全场景仍会先记一笔关系，再被护栏盖住语气）
  const afterEvent = reading ? applySocialEvent(decayed, reading, now) : decayed;
  const afterRefuseWindow = updateRefuseWindow(afterEvent, reading, now);

  // 3) 安全护栏最高：mood 强制关切；积怨不清零，但 P3 本轮强制合作、不消费拒绝倾向。
  if (options.safetyCritical) {
    return appendHistory(
      {
        ...afterRefuseWindow,
        mood: "caring_override",
        intensity: SAFETY_CARE_INTENSITY,
        updatedAt: now
      },
      now
    );
  }

  return appendHistory({ ...afterRefuseWindow, updatedAt: now }, now);
}

/**
 * 时间衰减：grievance 慢消；非 steady mood 强度回落，低强度时回 steady。
 * rapport 不自动漂移，只由事件改变（避免「冷暴力靠等时间自动变铁哥们」）。
 */
function decayAffectState(state: AgentAffectState, now: number): AgentAffectState {
  const activeState = state.refuseCooldownUntil && state.refuseCooldownUntil <= now
    ? { ...state, refuseCooldownUntil: undefined }
    : state;

  if (!activeState.updatedAt) {
    return activeState;
  }

  const elapsed = Math.max(0, now - activeState.updatedAt);
  if (elapsed <= 0) {
    return activeState;
  }

  const grievanceFactor = halfLifeFactor(elapsed, GRIEVANCE_HALF_LIFE_MS);
  const nextGrievance = clampUnit(activeState.grievance * grievanceFactor);

  // caring_override 不靠时间「演变成赌气」，直接退回由 grievance 暗示的底色
  if (activeState.mood === "caring_override") {
    return {
      ...activeState,
      mood: moodFromGrievance(nextGrievance, "steady"),
      intensity: nextGrievance > 0.35 ? Math.min(0.55, nextGrievance) : 0.2,
      grievance: nextGrievance
    };
  }

  if (activeState.mood === "steady") {
    return {
      ...activeState,
      grievance: nextGrievance,
      intensity: 0.2
    };
  }

  const moodFactor = halfLifeFactor(elapsed, MOOD_HALF_LIFE_MS);
  const nextIntensity = clampUnit(activeState.intensity * moodFactor);

  // 高强度反抗态随时间降档：先 defiant → sulky/cold，再回 steady（33：硬刚是短的，积怨才是长的）
  const steppedMood = stepDownMood(activeState.mood, nextIntensity, nextGrievance);

  // 强度过低：主色回 steady；若仍有积怨，可停在 mild sulky/cold 底色
  if (nextIntensity < 0.18) {
    if (nextGrievance >= 0.45) {
      return {
        ...activeState,
        mood: "sulky",
        intensity: Math.min(0.4, nextGrievance),
        grievance: nextGrievance
      };
    }
    if (nextGrievance >= 0.25) {
      return {
        ...activeState,
        mood: "cold",
        intensity: Math.min(0.35, nextGrievance),
        grievance: nextGrievance
      };
    }
    return {
      ...activeState,
      mood: "steady",
      intensity: 0.2,
      grievance: nextGrievance
    };
  }

  return {
    ...activeState,
    mood: steppedMood,
    intensity: nextIntensity,
    grievance: nextGrievance
  };
}

/** 严重冲突开启短拒窗口；道歉/修复立即关闭，避免已经和好仍被旧窗口锁住。 */
function updateRefuseWindow(
  state: AgentAffectState,
  reading: SocialEventReading | null,
  now: number
): AgentAffectState {
  if (
    reading
    && (reading.kind === "apology" || reading.kind === "soft_repair")
  ) {
    return { ...state, refuseCooldownUntil: undefined };
  }

  const severeConflict =
    reading
    && (reading.kind === "insult" || reading.kind === "mock" || reading.kind === "dismiss")
    && state.mood === "defiant"
    && state.grievance >= 0.7
    && state.intensity >= 0.65;
  if (!severeConflict) {
    return state;
  }

  return {
    ...state,
    refuseCooldownUntil: Math.max(
      state.refuseCooldownUntil ?? 0,
      now + HARD_REFUSE_WINDOW_MS
    )
  };
}

/**
 * 时间推进时的 mood 降档：避免 defiant 挂满数小时；积怨仍由 grievance 慢变量保留。
 */
function stepDownMood(mood: AffectMood, intensity: number, grievance: number): AffectMood {
  if (mood === "defiant" && intensity < 0.4) {
    return grievance >= 0.35 ? "sulky" : "cold";
  }
  if (mood === "wounded" && intensity < 0.35) {
    return grievance >= 0.3 ? "sulky" : "cold";
  }
  if ((mood === "playful" || mood === "warm") && intensity < 0.22) {
    return "steady";
  }
  return mood;
}

/**
 * 按 33 §5.2 方向表施加事件；改动量 = 基础幅度 × intensity × confidence。
 */
function applySocialEvent(
  state: AgentAffectState,
  reading: SocialEventReading,
  now: number
): AgentAffectState {
  const weight = reading.intensity * Math.max(reading.confidence, 0);
  if (reading.confidence < EVENT_APPLY_MIN_CONFIDENCE && reading.kind !== "insult") {
    // 低置信：除明确辱骂外，不大幅改状态
    return {
      ...state,
      lastEventKind: reading.kind,
      lastEventAt: now
    };
  }

  let grievance = state.grievance;
  let rapport = state.rapport;
  let mood: AffectMood = state.mood;
  let intensity = state.intensity;

  switch (reading.kind) {
    case "insult": {
      grievance = clampUnit(grievance + 0.55 * weight);
      // 明确辱骂至少抬一截积怨，避免「骂了但几乎没感觉」
      if (reading.confidence >= 0.45) {
        grievance = Math.max(grievance, 0.28);
      }
      rapport = clampRapport(rapport - 0.22 * weight);
      mood = grievance >= 0.45 || weight >= 0.4 || reading.intensity >= 0.45 ? "defiant" : "wounded";
      intensity = clampUnit(Math.max(intensity, 0.5 + 0.35 * weight));
      break;
    }
    case "mock": {
      grievance = clampUnit(grievance + 0.28 * weight);
      rapport = clampRapport(rapport - 0.16 * weight);
      mood = weight >= 0.55 || grievance >= 0.5 ? "defiant" : "sulky";
      intensity = clampUnit(Math.max(intensity, 0.4 + 0.35 * weight));
      break;
    }
    case "dismiss": {
      grievance = clampUnit(grievance + 0.22 * weight);
      rapport = clampRapport(rapport - 0.18 * weight);
      mood = weight >= 0.5 ? "cold" : "sulky";
      intensity = clampUnit(Math.max(intensity, 0.35 + 0.3 * weight));
      break;
    }
    case "tease": {
      // 轻调戏：playful；重/在已有积怨上：转向 sulky
      if (weight >= 0.55 || grievance >= 0.4) {
        grievance = clampUnit(grievance + 0.12 * weight);
        rapport = clampRapport(rapport - 0.06 * weight);
        mood = grievance >= 0.55 ? "defiant" : "sulky";
        intensity = clampUnit(Math.max(intensity, 0.35 + 0.25 * weight));
      } else {
        grievance = clampUnit(grievance + 0.03 * weight);
        rapport = clampRapport(rapport + 0.04 * weight);
        mood = "playful";
        intensity = clampUnit(Math.max(0.35, 0.3 + 0.3 * weight));
      }
      break;
    }
    case "order_only": {
      // 单次使唤：微摩擦，禁止拉满 defiant
      grievance = clampUnit(grievance + 0.06 * weight);
      rapport = clampRapport(rapport - 0.04 * weight);
      if (state.mood === "steady" || state.mood === "warm" || state.mood === "playful") {
        mood = "sulky";
        intensity = clampUnit(Math.max(intensity, 0.25 + 0.2 * weight));
      }
      break;
    }
    case "interrupt_spam":
    case "ignore_cold": {
      // P1 识别器不产出；若未来接入，按轻负向处理
      grievance = clampUnit(grievance + 0.1 * weight);
      rapport = clampRapport(rapport - 0.08 * weight);
      mood = "sulky";
      intensity = clampUnit(Math.max(intensity, 0.3 + 0.2 * weight));
      break;
    }
    case "praise":
    case "thanks": {
      grievance = clampUnit(grievance - 0.18 * weight);
      rapport = clampRapport(rapport + 0.16 * weight);
      mood = pickRecoverMood(grievance, "warm");
      intensity = clampUnit(0.3 + 0.25 * weight);
      break;
    }
    case "apology": {
      // 加速消气，但不秒变舔狗
      grievance = clampUnit(grievance - 0.32 * weight);
      rapport = clampRapport(rapport + 0.14 * weight);
      mood = pickRecoverMood(grievance, grievance <= 0.2 ? "steady" : "sulky");
      intensity = clampUnit(grievance > 0.25 ? 0.35 : 0.25);
      break;
    }
    case "soft_repair": {
      grievance = clampUnit(grievance - 0.2 * weight);
      rapport = clampRapport(rapport + 0.12 * weight);
      mood = pickRecoverMood(grievance, "warm");
      intensity = clampUnit(0.28 + 0.2 * weight);
      break;
    }
    default: {
      break;
    }
  }

  return {
    ...state,
    mood,
    intensity,
    grievance,
    rapport,
    lastEventKind: reading.kind,
    lastEventAt: now
  };
}

/** 修复类事件后：按残余积怨选 mood，保留一点嘴硬惯性 */
function pickRecoverMood(grievance: number, preferred: AffectMood): AffectMood {
  if (grievance >= 0.55) {
    return "sulky";
  }
  if (grievance >= 0.35) {
    return preferred === "warm" ? "cold" : "sulky";
  }
  return preferred;
}

function moodFromGrievance(grievance: number, fallback: AffectMood): AffectMood {
  if (grievance >= 0.55) {
    return "sulky";
  }
  if (grievance >= 0.3) {
    return "cold";
  }
  return fallback;
}

function halfLifeFactor(elapsedMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) {
    return 0;
  }
  // factor = 0.5 ^ (elapsed / halfLife)
  return Math.pow(0.5, elapsedMs / halfLifeMs);
}

function appendHistory(state: AgentAffectState, now: number): AgentAffectState {
  return {
    ...state,
    history: [
      ...state.history,
      {
        mood: state.mood,
        intensity: state.intensity,
        grievance: state.grievance,
        rapport: state.rapport,
        at: now
      }
    ].slice(-AGENT_AFFECT_HISTORY_LIMIT)
  };
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
