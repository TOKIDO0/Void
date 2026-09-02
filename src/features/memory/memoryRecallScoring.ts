// VOID 记忆召回校准 —— 置信度×衰减再平衡 + 主体隔离小权重（纯函数、可开关、零新依赖）
// 职责单一：提供召回排序前的纯分数校准，不读库、不写库、不触网络。
// 红线：只影响排序分，不扩召回范围、不改分区门禁、不改敏感/过期过滤；关闭时行为与旧版一字不差。
// 目标：普通问询（如“我血压有点高”）误召亲属健康条目的概率下降；高置信+新鲜条更稳居前排。

import type { MemoryEntry } from "./memoryTypes";

// ---------------------------------------------------------------------------
// 开关与常量（可开关、集中一处便于审计）
// ---------------------------------------------------------------------------

/** 总开关：false 时全部校准短路，回归旧版置信度×衰减直乘行为。 */
export const MEMORY_RECALL_CALIBRATION_ENABLED = true;

/**
 * 融合分与置信度的再平衡权重：balancedBase = FUSED_WEIGHT*fused + (1-FUSED_WEIGHT)*confidence
 * 取 0.62 使语义/全文仍占主导，但低置信条目不会靠单一语义分霸榜。
 */
export const FUSED_CONFIDENCE_BLEND_WEIGHT = 0.62;

/** 全文召回分支同理：归一化全文分与置信度再平衡权重（与融合分支一致，便于统一解释）。 */
export const TEXT_CONFIDENCE_BLEND_WEIGHT = 0.62;

/** 主体隔离小权重：普通问询（无亲属线索）时，relative 条目的排序分乘该系数。 */
export const SUBJECT_ISOLATION_PENALTY = 0.62;

// 亲属线索：命中任一即视作“用户在谈亲属”，此时不对 relative 施加惩罚。
const RELATIVE_CUE_PATTERN =
  /(母亲|妈妈|妈|父亲|爸爸|爸|爷爷|奶奶|外公|外婆|哥哥|姐姐|弟弟|妹妹|儿子|女儿|老婆|老公|妻子|丈夫|家人|亲戚|亲属|我妈|我爸|我哥|我姐|我弟|我妹)/;

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 查询是否包含亲属线索（用于决定是否对 relative 条目施加隔离惩罚）。 */
export function isRelativeQuery(query: string): boolean {
  return RELATIVE_CUE_PATTERN.test(query.trim());
}

/**
 * 主体隔离惩罚系数：仅对 subjectType=relative 且查询无亲属线索时的小幅压分。
 * 非 relative 条目一律 1.0；关闭校准时也一律 1.0。
 */
export function subjectIsolationFactor(entry: Pick<MemoryEntry, "subjectType">, query: string, enabled = MEMORY_RECALL_CALIBRATION_ENABLED): number {
  if (!enabled) return 1;
  if (entry.subjectType !== "relative") return 1;
  if (isRelativeQuery(query)) return 1;
  return SUBJECT_ISOLATION_PENALTY;
}

/**
 * 融合分与置信度再平衡：把向量/全文融合分与条目置信度做加权混 blend。
 * fused 已归一到 [0,1]，confidence 亦 0-1。
 * 关闭校准时原样返回 fused（由调用方决定回落到 confidence 的旧逻辑）。
 */
export function rebalanceFusedWithConfidence(
  fusedBase: number,
  confidence: number,
  enabled = MEMORY_RECALL_CALIBRATION_ENABLED
): number {
  if (!enabled) return fusedBase;
  const clampedFused = Math.max(0, Math.min(1, fusedBase));
  const clampedConf = Math.max(0, Math.min(1, confidence));
  return FUSED_CONFIDENCE_BLEND_WEIGHT * clampedFused + (1 - FUSED_CONFIDENCE_BLEND_WEIGHT) * clampedConf;
}

/**
 * 全文分与置信度再平衡（rankCandidatesByQuery 分支）：归一化全文分与置信度混 blend。
 */
export function rebalanceTextWithConfidence(
  normalizedTextScore: number,
  confidence: number,
  enabled = MEMORY_RECALL_CALIBRATION_ENABLED
): number {
  if (!enabled) return normalizedTextScore;
  const clampedText = Math.max(0, Math.min(1, normalizedTextScore));
  const clampedConf = Math.max(0, Math.min(1, confidence));
  return TEXT_CONFIDENCE_BLEND_WEIGHT * clampedText + (1 - TEXT_CONFIDENCE_BLEND_WEIGHT) * clampedConf;
}

/**
 * 对单条 decay 后分数施加主体隔离惩罚（乘法）。
 * 纯函数：不改 entry，只算系数。
 */
export function applySubjectPenalty(scoreAfterDecay: number, entry: Pick<MemoryEntry, "subjectType">, query: string, enabled = MEMORY_RECALL_CALIBRATION_ENABLED): number {
  return scoreAfterDecay * subjectIsolationFactor(entry, query, enabled);
}
