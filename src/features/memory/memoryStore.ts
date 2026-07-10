// VOID 记忆系统 —— 本地存储读写
// 职责单一：只负责记忆条目的持久化读写与脏数据隔离，不做分类 / 召回 / 策略判断。
// 存储载体：localStorage，键 void.memory.v1（带版本号，Tauri 期可平滑迁 SQLite）。
// 数据保存在本地、不上传服务器（04 号第 3 节前提）。

import type { MemoryEntry } from "./memoryTypes";
import { isMemoryType, isSubjectType, isSensitivity } from "./memoryTypes";

/** 存储键：v1 版本号预留迁移空间，结构不兼容升级时改版本号并写迁移。 */
const MEMORY_STORAGE_KEY = "void.memory.v1";

/** 磁盘上的信封结构：外层带版本，便于后续迁移判定。 */
type MemoryEnvelope = {
  version: 1;
  entries: MemoryEntry[];
};

/**
 * 读取全部记忆条目。
 * 无数据 / JSON 损坏 / 结构非法 → 一律回落空集，绝不抛错崩溃。
 * 逐条做字段校验，丢弃脏条目，只返回合法条目。
 */
export function listMemories(): MemoryEntry[] {
  const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const rawEntries = extractRawEntries(parsed);
    return rawEntries.map(sanitizeEntry).filter((entry): entry is MemoryEntry => entry !== null);
  } catch {
    return [];
  }
}

/** 按 id 取单条，不存在返回 null。 */
export function getMemoryById(id: string): MemoryEntry | null {
  return listMemories().find((entry) => entry.id === id) ?? null;
}

/**
 * 新增或更新一条记忆（按 id 判定）。
 * - 已存在同 id：合并更新并刷新 updatedAt，createdAt 保持不变。
 * - 不存在：追加。
 * 写入前对条目做一次校验，非法条目直接抛错交调用方处理，返回落库后的最终条目。
 */
export function upsertMemory(entry: MemoryEntry): MemoryEntry {
  const clean = sanitizeEntry(entry);
  if (!clean) {
    throw new Error("upsertMemory: 记忆条目字段非法，拒绝写入");
  }

  const entries = listMemories();
  const existingIndex = entries.findIndex((item) => item.id === clean.id);

  if (existingIndex >= 0) {
    const merged: MemoryEntry = {
      ...entries[existingIndex],
      ...clean,
      createdAt: entries[existingIndex].createdAt,
      updatedAt: clean.updatedAt
    };
    entries[existingIndex] = merged;
    persist(entries);
    return merged;
  }

  entries.push(clean);
  persist(entries);
  return clean;
}

/** 删除单条记忆，返回是否命中删除。 */
export function removeMemory(id: string): boolean {
  const entries = listMemories();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) {
    return false;
  }
  persist(next);
  return true;
}

/** 清空全部记忆。 */
export function clearMemories(): void {
  window.localStorage.removeItem(MEMORY_STORAGE_KEY);
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 写盘：统一封装信封并序列化。 */
function persist(entries: MemoryEntry[]): void {
  const envelope: MemoryEnvelope = { version: 1, entries };
  window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(envelope));
}

/** 从解析后的原始值里取出条目数组，兼容信封结构与裸数组两种形态。 */
function extractRawEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as MemoryEnvelope).entries)) {
    return (parsed as MemoryEnvelope).entries;
  }
  return [];
}

/**
 * 逐字段校验并规整单条记忆。任一必填字段缺失或类型不符 → 返回 null（丢弃该条）。
 * 这是脏数据的唯一入口关卡，保证内存中流转的条目一定合法。
 */
function sanitizeEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.id !== "string" || !raw.id.trim()) {
    return null;
  }
  if (!isMemoryType(raw.memoryType)) {
    return null;
  }
  if (!isSubjectType(raw.subjectType)) {
    return null;
  }
  if (!isSensitivity(raw.sensitivity)) {
    return null;
  }
  if (typeof raw.subjectName !== "string") {
    return null;
  }
  if (typeof raw.content !== "string" || !raw.content.trim()) {
    return null;
  }
  if (typeof raw.source !== "string") {
    return null;
  }
  if (typeof raw.confidence !== "number" || Number.isNaN(raw.confidence)) {
    return null;
  }
  if (typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number") {
    return null;
  }

  const entry: MemoryEntry = {
    id: raw.id,
    memoryType: raw.memoryType,
    subjectType: raw.subjectType,
    subjectName: raw.subjectName,
    content: raw.content,
    confidence: Math.min(Math.max(raw.confidence, 0), 1),
    source: raw.source,
    sensitivity: raw.sensitivity,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };

  if (typeof raw.expiresAt === "number" && !Number.isNaN(raw.expiresAt)) {
    entry.expiresAt = raw.expiresAt;
  }

  return entry;
}
