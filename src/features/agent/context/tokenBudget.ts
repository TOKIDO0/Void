// VOID 上下文 token 预算（M2）
// 职责：估算文本 token，并给 system / 记忆 / 摘要 / 近窗历史分配输入预算。
// 使用轻量 tokenx；失败时按字符近似，保证对话主路径不崩。

import { estimateTokenCount } from "tokenx";

export type TokenBudgetPlan = {
  totalInputBudget: number;
  systemTokens: number;
  memoryTokens: number;
  systemReserve: number;
  memoryReserve: number;
  summaryReserve: number;
  historyBudget: number;
};

/** 输入侧软上限：未按模型精确窗口表时的保守默认。 */
const DEFAULT_TOTAL_INPUT_BUDGET = 8000;
/** 工作摘要预留占比（相对总预算）。 */
const SUMMARY_RESERVE_RATIO = 0.12;
/** 长期记忆投影预留下限/上限（token）。 */
const MEMORY_RESERVE_MIN = 200;
const MEMORY_RESERVE_MAX = 900;
/** 系统提示预留额外安全垫。 */
const SYSTEM_PADDING = 80;

/**
 * 估算文本 token 数。
 * tokenx 异常时退回「约 1 token ≈ 2 字符」的粗算，避免阻断请求。
 */
export function estimateTokens(text: string): number {
  const value = text ?? "";
  if (!value) {
    return 0;
  }

  try {
    const counted = estimateTokenCount(value);
    if (typeof counted === "number" && Number.isFinite(counted) && counted >= 0) {
      return Math.max(1, Math.ceil(counted));
    }
  } catch {
    // fall through
  }

  return Math.max(1, Math.ceil(value.length / 2));
}

/**
 * 根据 system / 记忆正文规划各桶预算。
 * - system 与 memory 优先保障（按实占 + 安全垫）
 * - summary 固定比例预留
 * - 剩余全部给近窗历史原文
 */
export function planTokenBudget(options: {
  totalInputBudget?: number;
  systemText: string;
  memoryText: string;
}): TokenBudgetPlan {
  const totalInputBudget = Math.max(
    1000,
    options.totalInputBudget ?? DEFAULT_TOTAL_INPUT_BUDGET
  );

  const systemTokens = estimateTokens(options.systemText);
  const memoryTokens = options.memoryText.trim()
    ? estimateTokens(options.memoryText)
    : 0;

  const systemReserve = systemTokens + SYSTEM_PADDING;
  const memoryReserve = options.memoryText.trim()
    ? Math.min(
      MEMORY_RESERVE_MAX,
      Math.max(MEMORY_RESERVE_MIN, memoryTokens + 40)
    )
    : 0;

  const summaryReserve = Math.floor(totalInputBudget * SUMMARY_RESERVE_RATIO);
  const used =
    systemReserve + memoryReserve + summaryReserve;
  const historyBudget = Math.max(400, totalInputBudget - used);

  return {
    totalInputBudget,
    systemTokens,
    memoryTokens,
    systemReserve,
    memoryReserve,
    summaryReserve,
    historyBudget
  };
}
