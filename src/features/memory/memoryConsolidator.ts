// VOID 记忆系统 —— 固结（MEM-04）
// 职责：对已写入的长期记忆做定期整理，解决"只写不整理"导致的重复、矛盾与过期堆积。
//
// 与实时写入的分工：
// - 实时写入（memoryClassifier / memoryLlmExtractor）：把这一轮用户说的话抽成条目；
// - 固结（本文件）：跨时间合并同槽、消解偏好矛盾、清理已过期条目。
//
// 铁律：
// 1. 只用确定性规则，不调 LLM（固结是维护，不是再抽取，避免二次编造）。
// 2. 健康档案、关系事件、人际关系永不自动删除（误删不可逆，价值远高于噪音）。
// 3. 每次固结前必须存快照；没有快照就不执行（由调用方保证）。

import type { MemoryEntry } from "./memoryTypes";
import {
  extractTopicKey,
  isOpposingPolarity
} from "./memoryConflictResolver";

/** 单次固结的删除上限：批量删除比慢慢累积更难排查，宁可多跑一次。 */
const MAX_REMOVALS_PER_RUN = 50;
/** 单次固结的合并组上限。 */
const MAX_MERGE_GROUPS = 50;

/** 永不自动删除的分区。 */
const PROTECTED_TYPES = new Set<MemoryEntry["memoryType"]>([
  "healthRecord",
  "agentRelationship",
  "relationship"
]);

/** 允许"新偏好覆盖旧偏好"的分区（用户改主意是常态）。 */
const SUPERSEDE_TYPES = new Set<MemoryEntry["memoryType"]>([
  "preference",
  "userProfile"
]);

export type ConsolidationPlan = {
  /** 同槽合并：保留 keepId，删除 dropIds。 */
  merges: Array<{ keepId: string; dropIds: string[]; content: string; confidence: number }>;
  /** 偏好矛盾：保留新，删除旧。 */
  supersedes: Array<{ keepId: string; dropIds: string[] }>;
  /** 已过期（expiresAt 早于 now）且不在保护分区。 */
  expired: string[];
  stats: {
    totalEntries: number;
    mergeGroups: number;
    supersedeGroups: number;
    removedEntries: number;
  };
};

function newestFirst(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

function safeContent(value: string): string {
  return value.trim().slice(0, 200);
}

/**
 * 严格同槽键：分区 + 主体 + 归一化内容。
 *
 * 不能用 memoryConflictResolver 的 slotKey：它在没有话题关键词时统一退回 `_`，
 * 会把「喜欢咖啡」和「住在上海」判成同一事实并合并，等于静默删记忆。
 * 固结只合并"内容确实相同"的重复项。
 */
function exactSlotKey(entry: MemoryEntry): string {
  const normalized = entry.content
    .toLowerCase()
    .replace(/[\s，。、；：！？“”"'（）()【】\[\]…—\-]/g, "");
  return `${entry.memoryType}|${entry.subjectType}|${entry.subjectName}|${normalized}`;
}

/**
 * 生成固结计划（纯函数，不写库）。
 * 顺序：过期清理 → 同槽合并 → 偏好矛盾消解；后一步只处理上一步保留下来的条目。
 */
export function planConsolidation(entries: MemoryEntry[], now: number): ConsolidationPlan {
  const expired = entries
    .filter((entry) => typeof entry.expiresAt === "number" && entry.expiresAt < now)
    .filter((entry) => !PROTECTED_TYPES.has(entry.memoryType))
    .map((entry) => entry.id)
    .slice(0, MAX_REMOVALS_PER_RUN);
  const expiredSet = new Set(expired);

  // 同槽合并：同一分区 + 主体 + 完全相同内容，保留最新。
  const slotGroups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (expiredSet.has(entry.id)) {
      continue;
    }
    // 保护分区不做任何自动删除，重复也留着：健康/关系信息的价值远高于去重收益。
    if (PROTECTED_TYPES.has(entry.memoryType)) {
      continue;
    }
    const key = exactSlotKey(entry);
    const bucket = slotGroups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      slotGroups.set(key, [entry]);
    }
  }

  const merges: ConsolidationPlan["merges"] = [];
  const mergedAway = new Set<string>();
  for (const bucket of slotGroups.values()) {
    if (bucket.length < 2) {
      continue;
    }
    if (merges.length >= MAX_MERGE_GROUPS) {
      break;
    }
    const [keep, ...rest] = newestFirst(bucket);
    // 保护分区只合并不删除：保留最新内容，旧条目仍然删除是重复信息，安全。
    merges.push({
      keepId: keep.id,
      dropIds: rest.map((entry) => entry.id),
      content: safeContent(rest.find((entry) => entry.content.length > keep.content.length)?.content ?? keep.content),
      confidence: Math.max(...bucket.map((entry) => entry.confidence))
    });
    for (const entry of rest) {
      mergedAway.add(entry.id);
    }
  }

  // 偏好/画像矛盾：同主题 + 相反极性，新覆盖旧。
  const topicGroups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (expiredSet.has(entry.id) || mergedAway.has(entry.id)) {
      continue;
    }
    if (!SUPERSEDE_TYPES.has(entry.memoryType)) {
      continue;
    }
    const topicKey = extractTopicKey(entry.content);
    if (!topicKey) {
      continue;
    }
    const key = `${entry.memoryType}|${entry.subjectType}|${entry.subjectName}|${topicKey}`;
    const bucket = topicGroups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      topicGroups.set(key, [entry]);
    }
  }

  const supersedes: ConsolidationPlan["supersedes"] = [];
  const supersededAway = new Set<string>();
  for (const bucket of topicGroups.values()) {
    if (bucket.length < 2 || supersedes.length >= MAX_MERGE_GROUPS) {
      continue;
    }
    const ordered = newestFirst(bucket);
    const newest = ordered[0];
    const olderOpposing = ordered.slice(1).filter((entry) => isOpposingPolarity(newest.content, entry.content));
    if (olderOpposing.length === 0) {
      continue;
    }
    supersedes.push({ keepId: newest.id, dropIds: olderOpposing.map((entry) => entry.id) });
    for (const entry of olderOpposing) {
      supersededAway.add(entry.id);
    }
  }

  const removedEntries = expired.length
    + merges.reduce((sum, group) => sum + group.dropIds.length, 0)
    + supersedes.reduce((sum, group) => sum + group.dropIds.length, 0);

  return {
    merges,
    supersedes,
    expired,
    stats: {
      totalEntries: entries.length,
      mergeGroups: merges.length,
      supersedeGroups: supersedes.length,
      removedEntries
    }
  };
}

export function hasConsolidationWork(plan: ConsolidationPlan): boolean {
  return plan.stats.removedEntries > 0;
}

/** 应用计划时需要删除的 id 全集（去重）。 */
export function collectRemovalIds(plan: ConsolidationPlan): string[] {
  const ids = new Set<string>(plan.expired);
  for (const group of plan.merges) {
    for (const id of group.dropIds) {
      ids.add(id);
    }
  }
  for (const group of plan.supersedes) {
    for (const id of group.dropIds) {
      ids.add(id);
    }
  }
  return [...ids];
}
