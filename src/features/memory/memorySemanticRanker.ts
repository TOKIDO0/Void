// VOID 记忆语义召回 —— 融合排序纯函数（M4）
// 职责单一：在「已过分区门禁的候选集」内，把全文相关度分与向量相似度分融合，乘衰减后排序。
// 纯函数、无副作用、不读库、不调网络 —— 可代码级自测。
//
// 红线（37 §8.3）：本模块只在传入的 candidates 内排序，绝不新增候选、绝不扩召回范围。
// 分区/敏感/过期门禁全部由 retriever 在调用前算好；语义相似度只影响「排序」，不影响「能否被召回」。

import type { MemoryEntry } from "./memoryTypes";
import type { MemorySearchHit } from "./memorySearchIndex";
import { applyMemoryDecayScore } from "./memoryConflictResolver";
import {
  MEMORY_RECALL_CALIBRATION_ENABLED,
  applySubjectPenalty,
  rebalanceFusedWithConfidence
} from "./memoryRecallScoring";

/** 融合权重：全文分与向量分各占一半。两者都已各自归一到 [0,1]。 */
export const TEXT_SCORE_WEIGHT = 0.5;
export const VECTOR_SCORE_WEIGHT = 0.5;

export type FuseSemanticRankingParams = {
  /** 已过分区/敏感/过期门禁的候选集 */
  candidates: MemoryEntry[];
  /** 查询向量；空数组表示查询侧向量不可用（退化为纯全文分排序） */
  queryVector: number[];
  /** 与 candidates 同序的候选向量；某项为 null 表示该条无向量，向量分记 0 */
  candidateVectors: (number[] | null)[];
  /** Orama 全文命中（可空）；用于计算全文分 */
  textHits: MemorySearchHit[];
  /** 返回条数上限 */
  maxEntries: number;
  /** 现在时间 epoch ms，用于衰减 */
  now: number;
  /** 原始用户查询（用于主体隔离小权重）；不传则不做主体惩罚 */
  query?: string;
  /** 校准总开关，默认取 MEMORY_RECALL_CALIBRATION_ENABLED */
  calibrationEnabled?: boolean;
};

/**
 * 融合排序主入口。
 * fused = (W_TEXT × 归一化全文分 + W_VEC × 余弦相似度) × 分区半衰期衰减
 * 全文分按本批最大值归一到 [0,1]；余弦相似度 clamp 到 [0,1]。
 * 排序降序，同分再按更新时间更近者优先，最后截断。
 */
export function fuseSemanticRanking(params: FuseSemanticRankingParams): MemoryEntry[] {
  const { candidates, queryVector, candidateVectors, textHits, maxEntries, now } = params;
  const calibrationEnabled = params.calibrationEnabled ?? MEMORY_RECALL_CALIBRATION_ENABLED;
  const queryForSubject = params.query ?? "";
  if (candidates.length === 0 || maxEntries <= 0) {
    return [];
  }

  // 全文分：按本批最大分归一化到 [0,1]，未命中条目记 0。
  const textScoreById = new Map<string, number>();
  let maxTextScore = 0;
  for (const hit of textHits) {
    if (typeof hit.score === "number" && hit.score > maxTextScore) {
      maxTextScore = hit.score;
    }
  }
  if (maxTextScore > 0) {
    for (const hit of textHits) {
      const raw = typeof hit.score === "number" && hit.score > 0 ? hit.score : 0;
      textScoreById.set(hit.id, raw / maxTextScore);
    }
  }

  const hasQueryVector = queryVector.length > 0;

  const scored = candidates.map((entry, index) => {
    const textScore = textScoreById.get(entry.id) ?? 0;
    const candidateVector = candidateVectors[index] ?? null;
    const vectorScore =
      hasQueryVector && candidateVector
        ? clampUnit(cosineSimilarity(queryVector, candidateVector))
        : 0;
    const fusedBase = TEXT_SCORE_WEIGHT * textScore + VECTOR_SCORE_WEIGHT * vectorScore;
    // 校准：融合分与置信度再平衡，避免低置信条靠单一语义分霸榜；为 0 时仍回落置信度作底座。
    const balancedBase =
      fusedBase > 0
        ? calibrationEnabled
          ? rebalanceFusedWithConfidence(fusedBase, entry.confidence, true)
          : fusedBase
        : entry.confidence;
    const decayed = applyMemoryDecayScore(entry, now, balancedBase);
    const score = applySubjectPenalty(decayed, entry, queryForSubject, calibrationEnabled);
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  return scored.slice(0, maxEntries).map((item) => item.entry);
}

/** 余弦相似度：向量已 L2 归一时等价于点积；此处仍除模长以稳健处理未归一输入。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const valueA = a[index];
    const valueB = b[index];
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 把相似度夹到 [0,1]：负相关视为不相关。 */
function clampUnit(value: number): number {
  if (value <= 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
}
