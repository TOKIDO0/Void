// VOID 记忆系统 —— 固结执行器（MEM-04）
// 职责：读库 → 生成计划 → 存快照 → 应用。纯逻辑在 memoryConsolidator，本文件只做接线。
//
// 顺序不可调换：必须先存快照再删除；快照失败则整轮放弃（宁可不整理，也不能无法回滚）。

import { listMemories, removeMemory, upsertMemory, clearMemories } from "./memoryStore";
import {
  collectRemovalIds,
  hasConsolidationWork,
  planConsolidation,
  type ConsolidationPlan
} from "./memoryConsolidator";
import { readMemoryVersion, saveMemoryVersion } from "./memoryVersionStore";

export type ConsolidationResult = {
  applied: boolean;
  dryRun: boolean;
  snapshotId: string | null;
  plan: ConsolidationPlan;
  /** 实际删除条数（dryRun 时为 0）。 */
  removed: number;
  /** 实际更新条数（同槽合并时提升置信度/补全内容）。 */
  updated: number;
};

export type ConsolidateOptions = {
  dryRun?: boolean;
  reason?: string;
};

export type RestoreResult = {
  restored: boolean;
  /** 回滚前自动存的快照（便于"撤销这次回滚"）。 */
  safetySnapshotId: string | null;
  entryCount: number;
};

/**
 * 回滚到指定快照。
 * 回滚本身也是破坏性操作：先把当前状态存一份，避免"回滚后才发现选错版本"。
 */
export function restoreMemoryVersionSnapshot(versionId: string): RestoreResult {
  const target = readMemoryVersion(versionId);
  if (!target) {
    return { restored: false, safetySnapshotId: null, entryCount: 0 };
  }
  const current = listMemories();
  const safetySnapshotId = saveMemoryVersion(current, "pre-restore");
  clearMemories();
  for (const entry of target) {
    upsertMemory(entry);
  }
  return { restored: true, safetySnapshotId, entryCount: target.length };
}

export function runMemoryConsolidation(options: ConsolidateOptions = {}): ConsolidationResult {
  const now = Date.now();
  const entries = listMemories();
  const plan = planConsolidation(entries, now);

  if (!hasConsolidationWork(plan)) {
    return {
      applied: false,
      dryRun: options.dryRun === true,
      snapshotId: null,
      plan,
      removed: 0,
      updated: 0
    };
  }

  if (options.dryRun) {
    return {
      applied: false,
      dryRun: true,
      snapshotId: null,
      plan,
      removed: 0,
      updated: 0
    };
  }

  // 安全门：快照是删除的前提。存不下就不动库。
  const snapshotId = saveMemoryVersion(entries, options.reason ?? "consolidate");
  if (!snapshotId) {
    return {
      applied: false,
      dryRun: false,
      snapshotId: null,
      plan,
      removed: 0,
      updated: 0
    };
  }

  let updated = 0;
  for (const group of plan.merges) {
    const keep = entries.find((entry) => entry.id === group.keepId);
    if (!keep) {
      continue;
    }
    upsertMemory({
      ...keep,
      content: group.content,
      confidence: group.confidence,
      updatedAt: now
    });
    updated += 1;
  }

  let removed = 0;
  for (const id of collectRemovalIds(plan)) {
    if (removeMemory(id)) {
      removed += 1;
    }
  }

  return {
    applied: true,
    dryRun: false,
    snapshotId,
    plan,
    removed,
    updated
  };
}
