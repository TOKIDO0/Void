// VOID 记忆系统 —— 存储后端抽象（P1-b SQLite 搬家）
// 职责：隔离「存哪、怎么存」，上层 memoryStore 只调本模块，不直触 localStorage/SQLite。
// 现状：Web 与 Tauri WebView 的 localStorage 均可用且已验证稳定；SQLite 为 P1-b 目标，
// 本模块先以 localStorage 为唯一实现，完成接口抽象与迁移入口占位，保证现有 tsc/smoke 零回归。
// 后续接 tauri-plugin-sql 时，只需在本文件新增 sqlite 后端并在 isTauri() 分支切换，无需改动 memoryStore 上层逻辑。

import type { MemoryEntry } from "./memoryTypes";
import { isMemoryType, isSubjectType, isSensitivity } from "./memoryTypes";

/** 磁盘信封：带版本，便于 SQLite 建表后做结构迁移。 */
export type MemoryEnvelope = {
  version: 1;
  entries: MemoryEntry[];
};

/** 存储键：与历史 void.memory.v1 保持兼容，首启迁移时作为源读取。 */
export const MEMORY_STORAGE_KEY = "void.memory.v1";

/** SQLite 目标库名与表名（P1-b 落地时启用）。 */
export const SQLITE_DB_NAME = "void.db";
export const SQLITE_TABLE_NAME = "memories";

/** 后端类型：便于观测与自验。 */
export type MemoryStorageBackendKind = "localStorage" | "sqlite";

/** 是否运行在 Tauri WebView 内。 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

/** 当前生效的后端：现阶段固定 localStorage，SQLite 接线后按 isTauriRuntime() 切换。 */
export function currentStorageKind(): MemoryStorageBackendKind {
  return "localStorage";
}

/** 从 localStorage 读取并做脏数据隔离，返回合法条目。 */
export function loadFromLocalStorage(): MemoryEntry[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  const raw = window.localStorage.getItem(MEMORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rawEntries = extractRawEntries(parsed);
    return rawEntries.map(sanitizeEntry).filter((e): e is MemoryEntry => e !== null);
  } catch {
    return [];
  }
}

/** 写盘到 localStorage：信封序列化。 */
export function saveToLocalStorage(entries: MemoryEntry[]): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  const envelope: MemoryEnvelope = { version: 1, entries };
  window.localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(envelope));
}

/** 清空 localStorage 记忆键。 */
export function clearLocalStorage(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.removeItem(MEMORY_STORAGE_KEY);
}

/** SQLite 建表 SQL（P1-b 启用时由 tauri-plugin-sql 执行）。 */
export function sqliteCreateTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAME} (
    id TEXT PRIMARY KEY,
    memoryType TEXT NOT NULL,
    subjectType TEXT NOT NULL,
    subjectName TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence REAL NOT NULL,
    source TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    expiresAt INTEGER
  )`;
}

/**
 * 首启迁移：若在 Tauri 内且 SQLite 表为空，则把 localStorage 现有条目搬过去。
 * 调用方应在应用启动后择机调用一次；失败静默（回退 localStorage），不影响主流程。
 * 当前为占位实现，待内存现场验证后再切 currentStorageKind() 为 sqlite。
 */
export async function tryMigrateLocalStorageToSqlite(): Promise<{ migrated: number; skipped: boolean; error?: string }> {
  if (!isTauriRuntime()) return { migrated: 0, skipped: true };
  const entries = loadFromLocalStorage();
  if (entries.length === 0) return { migrated: 0, skipped: true };
  try {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    // @tauri-apps/plugin-sql 2.x 需先在 tauri.conf 声明 plugin，运行时 Database.load
    const db = await (Database as unknown as { load: (url: string) => Promise<unknown> }).load(`sqlite:${SQLITE_DB_NAME}`);
    const exec = (db as { execute: (sql: string, params?: unknown[]) => Promise<unknown> }).execute;
    await exec.call(db, sqliteCreateTableSql());
    const select = (db as { select: <T>(sql: string) => Promise<T[]> }).select;
    const rows = await select.call(db, `SELECT COUNT(*) as cnt FROM ${SQLITE_TABLE_NAME}`);
    const count = (rows as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    if (count > 0) return { migrated: 0, skipped: true };
    let migrated = 0;
    for (const entry of entries) {
      await exec.call(db, `INSERT INTO ${SQLITE_TABLE_NAME} VALUES (?,?,?,?,?,?,?,?,?,?,?)`, toSqliteParams(entry));
      migrated += 1;
    }
    return { migrated, skipped: false };
  } catch (error) {
    return { migrated: 0, skipped: true, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 把 MemoryEntry 转为 SQLite 行参数（顺序与建表一致）。 */
export function toSqliteParams(entry: MemoryEntry): unknown[] {
  return [
    entry.id,
    entry.memoryType,
    entry.subjectType,
    entry.subjectName,
    entry.content,
    entry.confidence,
    entry.source,
    entry.sensitivity,
    entry.createdAt,
    entry.updatedAt,
    entry.expiresAt ?? null
  ];
}

/** 从 SQLite 行还原 MemoryEntry（需经 sanitize 校验）。 */
export function fromSqliteRow(row: Record<string, unknown>): MemoryEntry | null {
  return sanitizeEntry(row);
}

// ---------------------------------------------------------------------------
// 内部：与 memoryStore 共享的校验与解析逻辑，唯一真源在本文件，避免两处漂移。
// ---------------------------------------------------------------------------

function extractRawEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as MemoryEnvelope).entries)) {
    return (parsed as MemoryEnvelope).entries;
  }
  return [];
}

export function sanitizeEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (!isMemoryType(raw.memoryType)) return null;
  if (!isSubjectType(raw.subjectType)) return null;
  if (!isSensitivity(raw.sensitivity)) return null;
  if (typeof raw.subjectName !== "string") return null;
  if (typeof raw.content !== "string" || !raw.content.trim()) return null;
  if (typeof raw.source !== "string") return null;
  if (typeof raw.confidence !== "number" || Number.isNaN(raw.confidence)) return null;
  if (typeof raw.createdAt !== "number" || typeof raw.updatedAt !== "number") return null;
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
  if (typeof raw.expiresAt === "number" && !Number.isNaN(raw.expiresAt)) entry.expiresAt = raw.expiresAt;
  return entry;
}
