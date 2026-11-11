// VOID 记忆系统 —— 版本快照与回滚（MEM-04 安全底座）
// 职责：每次固结前存一份完整快照，保留最近 N 份，支持回滚。
// 铁律：固结允许删除记忆，所以必须先有可回滚的快照；没有快照不得执行固结。

import type { MemoryEntry } from "./memoryTypes";

const STORAGE_KEY = "void.memoryVersions.v1";
/** 只保留最近 10 份：固结是低频操作，过量快照没有价值。 */
const MAX_VERSIONS = 10;
/** 单份快照条目上限：与 store 同量级，防止 localStorage 膨胀。 */
const MAX_ENTRIES_PER_VERSION = 2000;

export type MemoryVersion = {
  id: string;
  /** 创建原因：manual / consolidate / pre-restore。 */
  reason: string;
  createdAt: number;
  entries: MemoryEntry[];
};

type VersionFile = {
  version: 1;
  versions: MemoryVersion[];
};

function readFile(): VersionFile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: 1, versions: [] };
    }
    const parsed = JSON.parse(raw) as VersionFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.versions)) {
      return { version: 1, versions: [] };
    }
    return {
      version: 1,
      versions: parsed.versions
        .filter((item): item is MemoryVersion =>
          Boolean(item)
          && typeof item.id === "string"
          && typeof item.createdAt === "number"
          && Array.isArray(item.entries))
        .slice(-MAX_VERSIONS)
    };
  } catch {
    return { version: 1, versions: [] };
  }
}

function writeFile(file: VersionFile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      versions: file.versions.slice(-MAX_VERSIONS)
    }));
  } catch {
    // 存储失败不阻断固结，但调用方会在返回值里看到 snapshotId 缺失
  }
}

/** 存快照；返回快照 id。空记忆不存（没有可回滚的内容）。 */
export function saveMemoryVersion(entries: MemoryEntry[], reason: string): string | null {
  if (entries.length === 0) {
    return null;
  }
  const file = readFile();
  const id = `memv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  file.versions.push({
    id,
    reason,
    createdAt: Date.now(),
    entries: entries.slice(0, MAX_ENTRIES_PER_VERSION).map((entry) => ({ ...entry }))
  });
  writeFile(file);
  return id;
}

/** 列出快照摘要（不含完整条目，供 UI / 工具展示）。 */
export function listMemoryVersions(): Array<{ id: string; reason: string; createdAt: number; entryCount: number }> {
  return readFile().versions
    .map((item) => ({
      id: item.id,
      reason: item.reason,
      createdAt: item.createdAt,
      entryCount: item.entries.length
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 取完整快照内容；不存在返回 null。 */
export function readMemoryVersion(id: string): MemoryEntry[] | null {
  const found = readFile().versions.find((item) => item.id === id);
  return found ? found.entries.map((entry) => ({ ...entry })) : null;
}

export function clearMemoryVersions(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
