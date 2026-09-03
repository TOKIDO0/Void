// P2 Todo 落盘：本轮任务短期记忆（对标 Claude TodoWrite）。
// localStorage 持久（键 void.agentTodos.v1），Node/无 window 时内存回退，零副作用。

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export type AgentTodoItem = {
  id: string;
  content: string;
  status: AgentTodoStatus;
};

const STORAGE_KEY = "void.agentTodos.v1";
const MAX_TODOS = 20;
const MAX_CONTENT_CHARS = 200;

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

function readRaw(): string | null {
  const store = webStorage();
  if (store) {
    try {
      return store.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
  return memoryFallback.get(STORAGE_KEY) ?? null;
}

function writeRaw(value: string): void {
  const store = webStorage();
  if (store) {
    try {
      store.setItem(STORAGE_KEY, value);
      return;
    } catch {
      // 配额满等：回退内存，保证本轮可用
    }
  }
  memoryFallback.set(STORAGE_KEY, value);
}

function sanitizeItem(
  raw: unknown,
  index: number
): AgentTodoItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as { id?: unknown; content?: unknown; status?: unknown };
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content || content.length > MAX_CONTENT_CHARS) {
    return null;
  }
  const status: AgentTodoStatus =
    record.status === "in_progress" || record.status === "completed" ? record.status : "pending";
  const id = typeof record.id === "string" && record.id.trim()
    ? record.id.trim().slice(0, 40)
    : `t${index + 1}`;
  return { id, content, status };
}

/** 列出当前 Todo，不存在/损坏回空集，绝不抛错。 */
export function listAgentTodos(): AgentTodoItem[] {
  const raw = readRaw();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item, index) => sanitizeItem(item, index))
      .filter((item): item is AgentTodoItem => Boolean(item))
      .slice(0, MAX_TODOS);
  } catch {
    return [];
  }
}

/** 全量替换 Todo（Claude TodoWrite 语义），返回落盘后列表。 */
export function setAgentTodos(
  items: Array<{ content: string; status?: AgentTodoStatus; id?: string }>
): AgentTodoItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TODOS) {
    throw new Error(`todos 须为 1-${MAX_TODOS} 条`);
  }
  const clean: AgentTodoItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = sanitizeItem(items[index], index);
    if (!item) {
      throw new Error(`第 ${index + 1} 条 content 非法（1-${MAX_CONTENT_CHARS} 字）`);
    }
    clean.push(item);
  }
  // id 去重：重复 id 后者加后缀
  const seen = new Set<string>();
  for (const item of clean) {
    let id = item.id;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${item.id}-${suffix}`;
      suffix += 1;
    }
    seen.add(id);
    item.id = id;
  }
  writeRaw(JSON.stringify(clean));
  return clean;
}

/** 清空本轮 Todo。 */
export function clearAgentTodos(): void {
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

export const AGENT_TODO_LIMITS = {
  maxTodos: MAX_TODOS,
  maxContentChars: MAX_CONTENT_CHARS
} as const;
