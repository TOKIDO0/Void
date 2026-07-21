// VOID 记忆系统 —— 按意图召回
// 职责单一：根据当前用户问题判出意图，只召回相关分区的有界条数记忆，绝不全量塞 prompt。
// 分区映射对齐 04 号第 4 节召回规则。读库走 memoryStore，不写、不分类、不投影。
// P6：agentRelationship 不进默认映射；仅用户明确谈与 VOID 的关系时额外最多 2 条。

import type { MemoryEntry, MemoryType } from "./memoryTypes";
import { ensureMemorySearchIndexFromStore, listMemories } from "./memoryStore";
import {
  AGENT_RELATIONSHIP_RECALL_LIMIT,
  isExplicitVoidRelationshipTopic,
  selectAgentRelationshipEntries
} from "./agentRelationshipMemory";
import { searchMemoriesInCandidates } from "./memorySearchIndex";
import { applyMemoryDecayScore } from "./memoryConflictResolver";

/** 召回意图：从用户当前问题推断，决定拉哪些分区。 */
export type RetrievalIntent =
  | "health" // 健康咨询
  | "emotion" // 情绪倾诉
  | "task" // 任务整理
  | "professional" // 专业问题
  | "relationship" // 人际关系（用户现实人际，不含 VOID 自身）
  | "general"; // 泛化 / 无强意图

/**
 * 意图 → 目标分区映射（04 号第 4 节）：
 * - 健康：健康档案 + 用户画像
 * - 情绪：情绪状态 + 用户画像（近期相关上下文）
 * - 任务：任务待办 + 长期目标
 * - 专业：专业知识缓存（当前模型检索结果不在本模块）
 * - 人际：人际关系 + 情绪状态（用户现实人际；不含 agentRelationship）
 * - 泛化：用户画像 + 偏好（提供最小人设底座）
 * agentRelationship 永不进入本表，只走显式 VOID 关系话题旁路。
 */
const INTENT_TYPE_MAP: Record<RetrievalIntent, readonly MemoryType[]> = {
  health: ["healthRecord", "userProfile"],
  emotion: ["emotionTrend", "userProfile"],
  task: ["task", "longTermGoal"],
  professional: ["knowledgeCache"],
  relationship: ["relationship", "emotionTrend"],
  general: ["userProfile", "preference"]
};

/** 意图识别关键词表（按判定优先级排列，命中即定意图）。 */
const INTENT_RULES: readonly { intent: RetrievalIntent; keywords: readonly string[] }[] = [
  { intent: "health", keywords: ["病", "身体", "健康", "药", "睡眠", "血压", "血糖", "体检", "医院", "医生"] },
  { intent: "task", keywords: ["提醒", "待办", "安排", "计划", "截止", "deadline", "日程", "要做", "别忘"] },
  { intent: "relationship", keywords: ["朋友", "同事", "家人", "关系", "矛盾", "吵架", "相处", "沟通"] },
  { intent: "emotion", keywords: ["焦虑", "压力", "难过", "情绪", "低落", "崩溃", "烦", "孤独", "累"] },
  { intent: "professional", keywords: ["资料", "原理", "怎么实现", "技术", "研究", "文档", "科普", "为什么"] }
];

/** 单次召回默认返回上限，防止 prompt 膨胀。 */
const DEFAULT_MAX_ENTRIES = 6;

export type RetrieveOptions = {
  /** 返回条数上限，默认 6 */
  maxEntries?: number;
  /** 现在时间 epoch ms，用于过滤过期条目；默认取运行时当前时间 */
  now?: number;
};

/** 召回结果：命中的意图 + 召回条目（已排序、已截断）。 */
export type RetrieveResult = {
  intent: RetrievalIntent;
  entries: MemoryEntry[];
};

/**
 * 按用户当前问题召回相关记忆。
 * 流程：判意图 → 取目标分区 → 过滤（分区匹配 + 未过期）
 *   → 分区内全文相关度排序（Orama；失败则回退置信度/时间）→ 截断。
 * 若用户明确谈与 VOID 的关系，再并入最多 2 条 agentRelationship（不占默认分区配额外膨胀）。
 */
export function retrieveMemories(query: string, options: RetrieveOptions = {}): RetrieveResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now();
  const allEntries = listMemories();
  // 冷启动时把 localStorage 全量灌进全文索引（条目量小，可接受）
  ensureMemorySearchIndexFromStore();

  const intent = detectIntent(query);
  const targetTypes = INTENT_TYPE_MAP[intent];

  // 默认召回绝不包含 agentRelationship，避免普通闲聊/人际/任务把 VOID 关系档案塞进 prompt。
  const candidates = allEntries
    .filter((entry) => targetTypes.includes(entry.memoryType))
    .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);

  const baseEntries = rankCandidatesByQuery(query, candidates, maxEntries);

  const relationshipEntries = isExplicitVoidRelationshipTopic(query)
    ? selectAgentRelationshipEntries(allEntries, {
        maxEntries: AGENT_RELATIONSHIP_RECALL_LIMIT,
        now
      })
    : [];

  // 先放默认分区，再追加关系档案；按 id 去重，总量仍受 maxEntries + 关系上限约束。
  const merged = mergeUniqueEntries(baseEntries, relationshipEntries);

  return { intent, entries: merged };
}

/**
 * 在已过分区门禁的候选集内排序：
 * 1) 全文索引命中：Orama 分 × 时间衰减，再截断
 * 2) 无命中/索引失败 → 回退「衰减后置信度 + 更新时间」
 * 衰减只影响排序，不物理删除。
 */
function rankCandidatesByQuery(
  query: string,
  candidates: MemoryEntry[],
  maxEntries: number
): MemoryEntry[] {
  if (candidates.length === 0) {
    return [];
  }

  const now = Date.now();
  const byId = new Map(candidates.map((entry) => [entry.id, entry]));
  // 多取一些命中，再按衰减分重排，避免只取 topN 时旧条霸榜
  const hits = searchMemoriesInCandidates(
    query,
    candidates.map((entry) => entry.id),
    Math.max(maxEntries * 3, 12)
  );

  if (hits.length > 0) {
    const scored: { entry: MemoryEntry; score: number }[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const entry = byId.get(hit.id);
      if (!entry || seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      // Orama score 为正相关度；再乘分区半衰期衰减
      const base = typeof hit.score === "number" && hit.score > 0 ? hit.score : entry.confidence;
      scored.push({
        entry,
        score: applyMemoryDecayScore(entry, now, base)
      });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);

    const ranked = scored.map((item) => item.entry);
    // 全文命中不足时，用衰减后置信度补足，避免相关度分把高置信底座挤没
    if (ranked.length < maxEntries) {
      const fallback = [...candidates].sort((a, b) => compareByDecayRelevance(a, b, now));
      for (const entry of fallback) {
        if (seen.has(entry.id)) {
          continue;
        }
        ranked.push(entry);
        seen.add(entry.id);
        if (ranked.length >= maxEntries) {
          break;
        }
      }
    }
    return ranked.slice(0, maxEntries);
  }

  return [...candidates].sort((a, b) => compareByDecayRelevance(a, b, now)).slice(0, maxEntries);
}

/** 保序合并并按 id 去重：base 在前，extra 追加。 */
function mergeUniqueEntries(base: MemoryEntry[], extra: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set(base.map((entry) => entry.id));
  const merged = [...base];
  for (const entry of extra) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/** 从用户问题推断召回意图，无强特征则归 general。 */
export function detectIntent(query: string): RetrievalIntent {
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((keyword) => query.includes(keyword))) {
      return rule.intent;
    }
  }
  return "general";
}

/**
 * 回退排序：衰减后置信度优先，其次更新时间更近者优先。
 * 旧偏好会慢慢让位，但不会被自动删除。
 */
function compareByDecayRelevance(a: MemoryEntry, b: MemoryEntry, now: number): number {
  const scoreA = applyMemoryDecayScore(a, now);
  const scoreB = applyMemoryDecayScore(b, now);
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }
  return b.updatedAt - a.updatedAt;
}
