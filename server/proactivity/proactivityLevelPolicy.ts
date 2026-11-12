/**
 * PRO-02 Proactivity 分级 —— 唯一语义 owner。
 *
 * 等级是「代理主动预算的上限」，不是「覆盖用户开关」：
 * - 单功能开关（例如静默巡检）仍然有效，但不会超过当前等级允许的频率/日上限；
 * - 等级只管「能不能主动、能多频繁」，不管「用哪个通道」（通道归 PRO-01），
 *   也不改安静时段（PRO-04 仍是对所有主动投递的唯一闸门）。
 *
 * 纯函数：不读写文件、不发 HTTP。所有时间判断必须由消费方注入 nowMs。
 */

import { createProactivityError } from "./proactivityPolicy";

export type ProactivityLevel = "restrained" | "balanced" | "attentive";

export const DEFAULT_PROACTIVITY_LEVEL: ProactivityLevel = "balanced";

export const PROACTIVITY_LEVELS: readonly ProactivityLevel[] = [
  "restrained",
  "balanced",
  "attentive"
];

/** 代理主动预算；null 表示该等级下代理主动内容完全停止生成。 */
export type ProactivityBudget = {
  /** 静默巡检自动轮间隔（毫秒）。 */
  heartbeatIntervalMs: number;
  /** 静默巡检自动轮每天上限。 */
  heartbeatDailyCap: number;
};

export const PROACTIVITY_BUDGETS: Readonly<Record<ProactivityLevel, ProactivityBudget | null>> = {
  // 克制：代理主动全关；用户提醒与日程提醒不受影响（它们不经过这里）。
  restrained: null,
  // 平衡（默认）：每小时一轮，每天最多 24 轮。
  balanced: { heartbeatIntervalMs: 60 * 60 * 1000, heartbeatDailyCap: 24 },
  // 积极：每半小时一轮，每天最多 48 轮。
  attentive: { heartbeatIntervalMs: 30 * 60 * 1000, heartbeatDailyCap: 48 }
};

export type ProactivityLevelConfigStatus = "ok" | "missing" | "corrupt";

export type ProactivityLevelStatus = {
  level: ProactivityLevel;
  configStatus: ProactivityLevelConfigStatus;
  budget: ProactivityBudget | null;
  updatedAt: number | null;
  serverNow: number;
};

export type ProactivityLevelParseResult =
  | { ok: true; level: ProactivityLevel }
  | { ok: false; message: string };

export function isProactivityLevel(value: unknown): value is ProactivityLevel {
  return value === "restrained" || value === "balanced" || value === "attentive";
}

/** 只接受三个枚举值；不猜 "medium" / 数字档位 / 空字符串。 */
export function parseProactivityLevel(raw: unknown): ProactivityLevelParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "主动等级必须是对象" };
  }
  const level = (raw as Record<string, unknown>).level;
  if (!isProactivityLevel(level)) {
    return { ok: false, message: "level 必须是 restrained / balanced / attentive 之一" };
  }
  return { ok: true, level };
}

export function resolveProactivityBudget(level: ProactivityLevel): ProactivityBudget | null {
  return PROACTIVITY_BUDGETS[level];
}

export function assertValidProactivityLevel(raw: unknown): ProactivityLevel {
  const parsed = parseProactivityLevel(raw);
  if (!parsed.ok) {
    throw createProactivityError("INVALID_REQUEST", parsed.message);
  }
  return parsed.level;
}
