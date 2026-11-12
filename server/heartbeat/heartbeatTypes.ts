/**
 * PRO-05 静默巡检（Heartbeat）—— 类型与上界唯一真源。
 *
 * 边界（2026-11-12 用户拍板，不得自行扩大）：
 * - 只读 sidecar 可读事实（日程、调度任务/运行、HEARTBEAT.md）；读不到的一律不查、不猜。
 * - 本轮零 LLM：所有结论来自确定性检查，模型不可用不影响巡检。
 * - 只把问题写成 PRO-06 待投递记录；本模块禁止直接发通知 / TTS / 写安静时段判定。
 *
 * 只有本文件定义数据形状；policy / store / runner / handler / UI 一律从这里引入。
 */

import type { ProactivityLevel } from "../proactivity/proactivityLevelPolicy";

/** config.json / state.json 的当前版本；版本不匹配视为损坏，不猜测迁移。 */
export const HEARTBEAT_CONFIG_VERSION = 1;
export const HEARTBEAT_STATE_VERSION = 1;

/** 巡检节奏由 PRO-02 主动等级决定（平衡=60min/24 轮，积极=30min/48 轮）；这里只保留 tick。 */
export const HEARTBEAT_TICK_MS = 60 * 1000;

/** 清单文件读取上界：8 KB / 100 行 / 32 条有效检查。 */
export const HEARTBEAT_MAX_CHECKLIST_BYTES = 8 * 1024;
export const HEARTBEAT_MAX_CHECKLIST_LINES = 100;
export const HEARTBEAT_MAX_CHECKS = 32;

/** 去重：同一 fingerprint 24h 内不重复提醒；状态最多保留 500 条。 */
export const HEARTBEAT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_MAX_FINGERPRINTS = 500;

/** 单轮输出上界：每类最多 3 条，一轮最多 5 条，汇总正文 ≤190 字。 */
export const HEARTBEAT_MAX_ISSUES_PER_CHECK = 3;
export const HEARTBEAT_MAX_ISSUES_PER_ROUND = 5;
export const HEARTBEAT_MAX_SUMMARY_CHARS = 190;
export const HEARTBEAT_MAX_TITLE_CHARS = 16;

/** 事实窗口：未来 24h 的日程、过去 24h 的运行记录。 */
export const HEARTBEAT_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HEARTBEAT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
/** at 任务超过该宽限仍未触发，判定为卡住。 */
export const HEARTBEAT_STUCK_GRACE_MS = 5 * 60 * 1000;
/** 冲突检查最多扫描的事件数，避免全天事件过多时 O(n²) 放大。 */
export const HEARTBEAT_EVENT_SCAN_LIMIT = 200;

/** 心跳写进调度台账时使用的固定来源标记（origin=agent 由 schedulerTypes 定义）。 */
export const HEARTBEAT_JOB_ID = "heartbeat";
export const HEARTBEAT_JOB_NAME = "静默巡检";

/** 五个确定性检查。清单只能启用/停用这些，不接受自由文本解释。 */
export type HeartbeatCheckId =
  | "calendar-conflict"
  | "calendar-reminder-missing"
  | "scheduler-failed"
  | "delivery-undelivered"
  | "scheduler-job-stuck";

export const HEARTBEAT_CHECK_IDS: readonly HeartbeatCheckId[] = [
  "calendar-conflict",
  "calendar-reminder-missing",
  "scheduler-failed",
  "delivery-undelivered",
  "scheduler-job-stuck"
];

/** 清单里允许的中文别名；与英文 id 等价，解析后统一成 canonical id。 */
export const HEARTBEAT_CHECK_ALIASES: Readonly<Record<string, HeartbeatCheckId>> = {
  "日程冲突": "calendar-conflict",
  "日程提醒未绑定": "calendar-reminder-missing",
  "后台任务失败": "scheduler-failed",
  "投递未送达": "delivery-undelivered",
  "任务卡住": "scheduler-job-stuck"
};

/** 默认清单模板：只在用户开启巡检且文件不存在时写入一次。 */
export const HEARTBEAT_DEFAULT_CHECKLIST = `# VOID 静默巡检清单
# 每行一条检查，以 # 开头是注释；只识别下面 5 个名称。
# 未识别的行不会执行，只在设置里提示。

- calendar-conflict
- calendar-reminder-missing
- scheduler-failed
- delivery-undelivered
- scheduler-job-stuck
`;

/** 一条结构化问题；fingerprint 只由检查名与实体 id 组成，不含时间与文案。 */
export type HeartbeatIssue = {
  fingerprint: string;
  check: HeartbeatCheckId;
  text: string;
};

export type HeartbeatFingerprintRecord = {
  key: string;
  firstSeenAt: number;
  lastNotifiedAt: number;
  lastCheck: string;
};

/** 单轮结果：必须能回答“这轮为什么没打扰”。 */
export type HeartbeatOutcome =
  | "NO_ISSUES"
  | "NOTIFIED"
  | "SUPPRESSED_DUPLICATE"
  | "SUPPRESSED_STATE_CORRUPT"
  | "SKIPPED"
  | "ENQUEUE_FAILED";

export type HeartbeatSkipReason =
  | "DISABLED"
  | "NO_CHECKLIST"
  | "INVALID_CHECKLIST"
  | "DAILY_CAP"
  | "LEVEL_RESTRAINED";

export type HeartbeatRoundResult = {
  at: number;
  outcome: HeartbeatOutcome;
  skippedReason?: HeartbeatSkipReason;
  /** 本轮确定性检查命中数（去重前）。 */
  issuesFound: number;
  /** 实际写入投递队列的问题数。 */
  notified: number;
  /** 被 24h TTL 抑制的问题数。 */
  suppressed: number;
  summary?: string;
  errorCode?: string;
};

export type HeartbeatChecklistInvalidReason =
  | "TOO_LARGE"
  | "UNREADABLE"
  | "TOO_MANY_LINES"
  | "TOO_MANY_CHECKS"
  | "NO_VALID_CHECKS";

export type HeartbeatChecklistStatus = {
  path: string;
  status: "ok" | "missing" | "invalid";
  checks: HeartbeatCheckId[];
  /** 未识别的行原样保留，供设置页提示；绝不猜测执行。 */
  unsupported: string[];
  reason?: HeartbeatChecklistInvalidReason;
};

export type HeartbeatConfigStatus = "ok" | "missing" | "corrupt";
export type HeartbeatStateStatus = "ok" | "missing" | "corrupt";

export type HeartbeatConfig = {
  enabled: boolean;
  updatedAt: number | null;
};

export type HeartbeatState = {
  version: typeof HEARTBEAT_STATE_VERSION;
  lastRunAt: number | null;
  /** 本地日期键 YYYY-MM-DD；跨天时重置 roundsToday。 */
  lastRunDayKey: string | null;
  roundsToday: number;
  fingerprints: HeartbeatFingerprintRecord[];
  lastResult: HeartbeatRoundResult | null;
};

export type HeartbeatStatus = {
  enabled: boolean;
  configStatus: HeartbeatConfigStatus;
  checklist: HeartbeatChecklistStatus;
  stateStatus: HeartbeatStateStatus;
  /** 当前 PRO-02 主动等级；等级是预算上限，不覆盖本功能开关。 */
  level: ProactivityLevel;
  /** 等级为「克制」时代理主动被暂停（即使本功能开关为开）。 */
  levelRestrained: boolean;
  lastRunAt: number | null;
  /** 下一次自动巡检时间；已到期时为当前时刻。 */
  nextRunAt: number | null;
  roundsToday: number;
  /** 当前等级下的自动轮每日上限；等级为克制时为 0。 */
  dailyCap: number;
  lastResult: HeartbeatRoundResult | null;
  serverNow: number;
};

export function emptyHeartbeatState(): HeartbeatState {
  return {
    version: HEARTBEAT_STATE_VERSION,
    lastRunAt: null,
    lastRunDayKey: null,
    roundsToday: 0,
    fingerprints: [],
    lastResult: null
  };
}

export type HeartbeatErrorCode = "INVALID_REQUEST";

export function createHeartbeatError(code: HeartbeatErrorCode, message: string): Error & { heartbeatCode: string } {
  const error = new Error(message) as Error & { heartbeatCode: string };
  error.heartbeatCode = code;
  return error;
}

export function getHeartbeatErrorInfo(error: unknown): { code: string; message: string } {
  if (
    typeof error === "object"
    && error !== null
    && "heartbeatCode" in error
    && typeof (error as { heartbeatCode?: unknown }).heartbeatCode === "string"
  ) {
    const coded = error as Error & { heartbeatCode: string };
    return { code: coded.heartbeatCode, message: coded.message };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "静默巡检内部错误"
  };
}
