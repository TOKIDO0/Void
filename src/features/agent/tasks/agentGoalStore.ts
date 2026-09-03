// P2 Goal 跨轮目标（对标 CCB /goal 轻量版）：一句话目标跨轮保持，每轮先对账。
// localStorage 持久（键 void.agentGoal.v1），Node/无 window 时内存回退。

export type AgentGoal = {
  goal: string;
  createdAt: number;
  updatedAt: number;
};

const STORAGE_KEY = "void.agentGoal.v1";
const MAX_GOAL_CHARS = 500;

const memoryFallback = new Map<string, string>();

function webStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    const scoped = globalThis as unknown as {
      window?: { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> };
      localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    };
    if (scoped.window?.localStorage) {
      return scoped.window.localStorage;
    }
    if (scoped.localStorage) {
      return scoped.localStorage;
    }
  } catch {
    // 无存储环境：走内存回退
  }
  return null;
}

/** 取当前目标，无/损坏返回 null，绝不抛错。 */
export function getAgentGoal(): AgentGoal | null {
  let raw: string | null = null;
  const store = webStorage();
  if (store) {
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  } else {
    raw = memoryFallback.get(STORAGE_KEY) ?? null;
  }
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AgentGoal>;
    if (typeof parsed.goal !== "string" || !parsed.goal.trim()) {
      return null;
    }
    return {
      goal: parsed.goal.trim().slice(0, MAX_GOAL_CHARS),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now()
    };
  } catch {
    return null;
  }
}

/** 设定目标（覆盖旧目标），返回落盘后目标。 */
export function setAgentGoal(goal: string): AgentGoal {
  const text = goal.trim();
  if (!text) {
    throw new Error("goal 不能为空");
  }
  if (text.length > MAX_GOAL_CHARS) {
    throw new Error(`goal 不得超过 ${MAX_GOAL_CHARS} 字`);
  }
  const previous = getAgentGoal();
  const now = Date.now();
  const next: AgentGoal = {
    goal: text,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now
  };
  const raw = JSON.stringify(next);
  const store = webStorage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, raw);
      return next;
    } catch {
      // 配额满：回退内存
    }
  }
  memoryFallback.set(STORAGE_KEY, raw);
  return next;
}

/** 清除目标。 */
export function clearAgentGoal(): void {
  const store = webStorage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      // 忽略
    }
  }
  memoryFallback.delete(STORAGE_KEY);
}

export const AGENT_GOAL_LIMITS = { maxGoalChars: MAX_GOAL_CHARS } as const;
