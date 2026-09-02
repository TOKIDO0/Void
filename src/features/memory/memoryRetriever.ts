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
import { isSemanticSearchEnabled } from "./memorySemanticConfig";
import { embedMemoryTexts } from "./memoryEmbeddingClient";
import { fuseSemanticRanking } from "./memorySemanticRanker";
import {
  MEMORY_RECALL_CALIBRATION_ENABLED,
  applySubjectPenalty,
  rebalanceTextWithConfidence
} from "./memoryRecallScoring";

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

/** 语义召回的候选数硬上限：超过则本轮直接走全文，避免一次编码过多文本拖慢发消息。 */
const SEMANTIC_CANDIDATE_LIMIT = 512;

/**
 * 语义增强召回（M4）。仅当用户开启「本地语义检索」时启用。
 * 流程：判意图 → 取候选（同分区/未过期门禁，与同步版完全一致）
 *   → bridge 本地编码 query 与候选 → 全文分 + 向量分融合排序 → 截断。
 * 任一前置不满足或向量不可用（bridge 未起 / 超时 / 首次模型加载中）→ 无缝降级到同步全文版，
 * 保证「关或失败」时行为与 M3 一字不差。分区门禁在编码之前算好，语义相似度绝不扩召回范围。
 */
export async function retrieveMemoriesAsync(
  query: string,
  options: RetrieveOptions = {},
  signal?: AbortSignal
): Promise<RetrieveResult> {
  // 开关关 = 完全等价 M3：不加载模型、不下载权重、无隐私外发。
  if (!isSemanticSearchEnabled()) {
    return retrieveMemories(query, options);
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now();
  const allEntries = listMemories();
  ensureMemorySearchIndexFromStore();

  const intent = detectIntent(query);
  const targetTypes = INTENT_TYPE_MAP[intent];
  const candidates = allEntries
    .filter((entry) => targetTypes.includes(entry.memoryType))
    .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now);

  const normalizedQuery = query.trim();
  // 无候选 / 空查询 / 候选过多 → 交回同步全文（也覆盖了 fuse 的空集短路）。
  if (candidates.length === 0 || !normalizedQuery || candidates.length > SEMANTIC_CANDIDATE_LIMIT) {
    return retrieveMemories(query, options);
  }

  // 并行编码查询与候选内容；任一失败即整轮降级。
  const [queryVectors, candidateVectors] = await Promise.all([
    embedMemoryTexts([normalizedQuery], { isQuery: true, signal }),
    embedMemoryTexts(candidates.map((entry) => entry.content), { isQuery: false, signal })
  ]);

  const embeddingUnavailable =
    !queryVectors ||
    queryVectors.length === 0 ||
    !candidateVectors ||
    candidateVectors.length !== candidates.length;
  if (embeddingUnavailable) {
    return retrieveMemories(query, options);
  }

  const textHits = searchMemoriesInCandidates(
    normalizedQuery,
    candidates.map((entry) => entry.id),
    Math.max(maxEntries * 3, 12)
  );

  const baseEntries = fuseSemanticRanking({
    candidates,
    queryVector: queryVectors[0],
    candidateVectors,
    textHits,
    maxEntries,
    now,
    query: normalizedQuery
  });

  // 关系旁路与同步版一致：仅显式谈 VOID 关系时额外并入，最多 2 条。
  const relationshipEntries = isExplicitVoidRelationshipTopic(query)
    ? selectAgentRelationshipEntries(allEntries, {
        maxEntries: AGENT_RELATIONSHIP_RECALL_LIMIT,
        now
      })
    : [];
  const merged = mergeUniqueEntries(baseEntries, relationshipEntries);

  return { intent, entries: merged };
}

/**
 * 在已过分区门禁的候选集内排序（校准版）：
 * 1) 全文索引命中：归一化全文分 × 置信度再平衡 × 时间衰减 × 主体隔离小权重，再截断
 * 2) 无命中/索引失败 → 回退「衰减后置信度 + 主体隔离 + 更新时间」
 * 衰减只影响排序，不物理删除；校准可开关，关闭时与旧版一字不差。
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
    // 归一化全文分到 [0,1]，再与置信度再平衡
    let maxScore = 0;
    for (const hit of hits) {
      if (typeof hit.score === "number" && hit.score > maxScore) maxScore = hit.score;
    }
    const scored: { entry: MemoryEntry; score: number }[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const entry = byId.get(hit.id);
      if (!entry || seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      const raw = typeof hit.score === "number" && hit.score > 0 ? hit.score : 0;
      const normalized = maxScore > 0 ? raw / maxScore : 0;
      // 再平衡：归一化全文分与置信度加权；为 0 时回落置信度作底座
      const base =
        normalized > 0
          ? MEMORY_RECALL_CALIBRATION_ENABLED
            ? rebalanceTextWithConfidence(normalized, entry.confidence, true)
            : normalized
          : entry.confidence;
      const decayed = applyMemoryDecayScore(entry, now, base);
      const score = applySubjectPenalty(decayed, entry, query, MEMORY_RECALL_CALIBRATION_ENABLED);
      scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);

    const ranked = scored.map((item) => item.entry);
    // 全文命中不足时，用衰减后置信度×主体隔离补足
    if (ranked.length < maxEntries) {
      const fallback = [...candidates].sort((a, b) => compareByDecayRelevanceWithSubject(a, b, now, query));
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

  return [...candidates].sort((a, b) => compareByDecayRelevanceWithSubject(a, b, now, query)).slice(0, maxEntries);
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

/** 带主体隔离的回退排序：普通问询时 relative 条目小幅压分，避免误召亲属健康。 */
function compareByDecayRelevanceWithSubject(a: MemoryEntry, b: MemoryEntry, now: number, query: string): number {
  const scoreA = applySubjectPenalty(applyMemoryDecayScore(a, now), a, query, MEMORY_RECALL_CALIBRATION_ENABLED);
  const scoreB = applySubjectPenalty(applyMemoryDecayScore(b, now), b, query, MEMORY_RECALL_CALIBRATION_ENABLED);
  if (scoreB !== scoreA) {
    return scoreB - scoreA;
  }
  return b.updatedAt - a.updatedAt;
}
