/**
 * P1 文件快照 checkpoint（mutation 前自动快照 + 可恢复）。
 *
 * owner：server/file/fileCheckpointManager.ts。
 * - 快照区：<runtime-root>/checkpoints/<checkpointId>/<relPath>；
 * - 有界：至多保留 50 个 checkpoint，超限删最旧；单文件 ≤5MB 才快照；
 * - 不存在/不可读源文件：记 { absent: true }，恢复时删除目标（还原“新建前”状态）；
 * - 审计：创建/恢复均写 toolAuditLog（module=file）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { appendToolAudit } from "../audit/toolAuditLog";
import { resolveRuntimeRoot } from "./fileRuntimePaths";

const MAX_CHECKPOINTS = 50;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export type FileCheckpoint = {
  id: string;
  createdAt: number;
  paths: string[];
  note?: string;
};

function checkpointsDir(): string {
  const fromEnv = process.env.VOID_CHECKPOINTS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveRuntimeRoot(), "checkpoints");
}

function nextCheckpointId(): string {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function listCheckpointIds(): string[] {
  const dir = checkpointsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("cp_"))
    .map((entry) => entry.name)
    .sort();
}

function pruneOldest(): void {
  const ids = listCheckpointIds();
  while (ids.length >= MAX_CHECKPOINTS) {
    const oldest = ids.shift();
    if (!oldest) break;
    try {
      rmSync(join(checkpointsDir(), oldest), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function manifestPath(id: string): string {
  return join(checkpointsDir(), id, "checkpoint.json");
}

/** mutation 前调用：对目标路径做快照，返回 checkpoint id。 */
export function createCheckpoint(absolutePaths: string[], note?: string): FileCheckpoint {
  mkdirSync(checkpointsDir(), { recursive: true });
  pruneOldest();
  const id = nextCheckpointId();
  const dir = join(checkpointsDir(), id);
  mkdirSync(dir, { recursive: true });
  const stored: string[] = [];
  for (const absolutePath of absolutePaths.slice(0, 20)) {
    try {
      const resolved = resolve(absolutePath);
      const rel = relative(resolve(resolved, ".."), resolved);
      const safeRel = rel.replace(/[/\\]/g, "__").slice(0, 120) || "file";
      if (existsSync(resolved) && statSync(resolved).isFile()) {
        if (statSync(resolved).size <= MAX_SNAPSHOT_BYTES) {
          copyFileSync(resolved, join(dir, safeRel));
          stored.push(absolutePath);
        }
      } else {
        writeFileSync(join(dir, `${safeRel}.absent`), "", "utf8");
        stored.push(absolutePath);
      }
    } catch {
      // 单文件失败不影响其余
    }
  }
  const manifest: FileCheckpoint = {
    id,
    createdAt: Date.now(),
    paths: stored,
    note: typeof note === "string" ? note.slice(0, 200) : undefined
  };
  writeFileSync(manifestPath(id), JSON.stringify(manifest, null, 2), "utf8");
  appendToolAudit({
    at: Date.now(),
    module: "file",
    action: "file.checkpoint.create",
    decision: "allow",
    reason: note ?? `${stored.length} 个路径快照`
  });
  return manifest;
}

export function listCheckpoints(): FileCheckpoint[] {
  const result: FileCheckpoint[] = [];
  for (const id of listCheckpointIds().slice(-MAX_CHECKPOINTS)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath(id), "utf8")) as FileCheckpoint;
      result.push(manifest);
    } catch {
      // ignore
    }
  }
  return result;
}

/** 恢复快照：absent 标记的删除目标，其余拷回。返回实际恢复数。 */
export function restoreCheckpoint(id: string): { restored: number; id: string } {
  const clean = id.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean || clean !== id.trim()) {
    throw new Error("非法 checkpoint id");
  }
  const manifest = JSON.parse(readFileSync(manifestPath(clean), "utf8")) as FileCheckpoint;
  let restored = 0;
  for (const absolutePath of manifest.paths.slice(0, 20)) {
    try {
      const resolved = resolve(absolutePath);
      const rel = relative(resolve(resolved, ".."), resolved);
      const safeRel = rel.replace(/[/\\]/g, "__").slice(0, 120) || "file";
      const absentMarker = join(checkpointsDir(), clean, `${safeRel}.absent`);
      if (existsSync(absentMarker)) {
        try {
          rmSync(resolved, { force: true });
          restored += 1;
        } catch {
          // ignore
        }
        continue;
      }
      const snapshot = join(checkpointsDir(), clean, safeRel);
      if (!existsSync(snapshot)) continue;
      mkdirSync(dirname(resolved), { recursive: true });
      copyFileSync(snapshot, resolved);
      restored += 1;
    } catch {
      // ignore
    }
  }
  appendToolAudit({
    at: Date.now(),
    module: "file",
    action: "file.checkpoint.restore",
    decision: "ask-allow",
    reason: `恢复 ${restored} 个路径（checkpoint ${clean}）`
  });
  return { restored, id: clean };
}
