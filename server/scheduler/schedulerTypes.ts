/**
 * P4 后台调度器：任务与运行记录类型。
 * v1 at（一次）+ every（间隔）；AK 起加 cron（日历表达式）。
 * 无人值守 run 不再二次确认 —— 创建时一次授 scope（工具白名单 + 风险上限 + 超时）。
 */

export type ScheduleKind = "at" | "every" | "cron";

export type ScheduleJob = {
  id: string;
  name: string;
  /** 用户原话/任务指令（创建者写入，执行时作为 user 消息）。 */
  prompt: string;
  kind: ScheduleKind;
  /** at 触发毫秒时间戳。 */
  atMs?: number;
  /** every 间隔毫秒（≥60s）。 */
  everyMs?: number;
  /** cron 表达式（5 段或 6 段，秒可选）。 */
  expr?: string;
  /** cron 时区 IANA 名；缺省宿主时区。 */
  tz?: string;
  /** every 锚点毫秒；缺省为创建时间。 */
  anchorMs?: number;
  /** 允许工具名；缺省用 DEFAULT_UNATTENDED_TOOL_NAMES。 */
  allowedToolNames: string[];
  /** 单次 run 超时毫秒，默认 600000，夹逼 [60000, 3600000]。 */
  timeoutMs: number;
  /** 投递时是否 TTS 播报摘要（AJ 早报 v1；需窗口可见 + 语音开关开，否则只通知）。 */
  speakOnDeliver: boolean;
  enabled: boolean;
  createdAt: number;
  /** 模型 Key 的 vault 引用（vault:<alias>）；jobs.json 永不存明文 Key。 */
  modelVaultRef?: string;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: SchedulerRunStatus;
  /** 一次性任务过期未跑次数（供台账展示）。 */
  missedCount: number;
  /** 连续失败次数（退避/停用依据）。 */
  failStreak: number;
};

export type SchedulerRunStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "paused_needs_user"
  | "missed";

/**
 * 投递状态机（PRO-06）。
 * pending → delivering(租约) → sent / failed；
 * 租约过期回 pending，attempts 超限或入队超时转终态。
 * suppressed = 按条件通知策略主动不打扰（巡检无异常），属终态但不是"送达"。
 */
export type DeliveryState = "pending" | "delivering" | "sent" | "failed" | "expired" | "suppressed";

export type RunDelivery = {
  state: DeliveryState;
  /** 领取次数；用于失败上限判定。 */
  attempts: number;
  /** 入队时间；过期判定基准。 */
  enqueuedAt: number;
  lastAttemptAt?: number;
  /** delivering 租约到期时间，仅 state=delivering 时有意义。 */
  leaseUntil?: number;
  /** 失败原因码：PERMISSION_DENIED / BRIDGE_UNREACHABLE / QUEUE_FULL / UNKNOWN。 */
  errorCode?: string;
};

/** 新建一条待投递记录（runner 建 run 时使用）。 */
export function createRunDelivery(): RunDelivery {
  return { state: "pending", attempts: 0, enqueuedAt: Date.now() };
}

/** 按条件通知策略主动不打扰。 */
export function createSuppressedDelivery(): RunDelivery {
  return { state: "suppressed", attempts: 0, enqueuedAt: Date.now() };
}

export type SchedulerRunRecord = {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | SchedulerRunStatus;
  summary?: string;
  /** 投递状态真源（PRO-06）。 */
  delivery: RunDelivery;
};

export type SchedulerState = {
  version: 1;
  jobs: ScheduleJob[];
  /** 仅保留最近 100 条（有界）。 */
  runs: SchedulerRunRecord[];
};

export type ScheduleCreateInput = {
  name?: string;
  prompt: string;
  kind: ScheduleKind;
  /** at 必填：ISO 时间或毫秒时间戳。 */
  at?: string | number;
  /** every 必填：毫秒或 "10m/1h/1d" 简写。 */
  every?: number | string;
  /** cron 必填：5 段或 6 段表达式（如 "0 8 * * 1-5"）。 */
  expr?: string;
  /** cron 可选时区 IANA 名（如 Asia/Shanghai）；缺省宿主时区。 */
  tz?: string;
  /** B 自然语言时间（如 下周三下午三点 / 每天早上8点 / 每隔10分钟）；与 at/every/expr 二选一。 */
  when?: string;
  /** every 可选锚点（ISO 或毫秒时间戳）：缺省为创建时间。每日 8 点类用 every 24h + 锚明日 8 点。 */
  anchor?: string | number;
  /** 投递播报开关（可选，默认 false）。 */
  speakOnDeliver?: boolean;
  allowedToolNames?: string[];
  timeoutMs?: number;
};

/** 无人值守默认工具域：只读探针 + 检索 + 截图 + 已验证的后台投递读侧；写盘/外发一律走 fail-closed。 */
export const DEFAULT_UNATTENDED_TOOL_NAMES = [
  "desktop.listWindows",
  "desktop.inspectWindowControls",
  "desktop.screenshot",
  "desktop.getSystemInfo",
  "file.listDirectory",
  "file.readText",
  "file.searchText",
  "file.inspectPath",
  "web.search",
  "web.fetch",
  "browser.search",
  "browser.extract"
] as const;

export function createScheduleError(
  code: "INVALID_REQUEST" | "NOT_FOUND" | "JOB_LIMIT" | "NEEDS_UNLOCK" | "INTERNAL_ERROR",
  message: string
): Error & { scheduleCode: string } {
  const error = new Error(message) as Error & { scheduleCode: string };
  error.scheduleCode = code;
  return error;
}

export function getScheduleErrorInfo(error: unknown): { code: string; message: string } {
  if (
    typeof error === "object"
    && error !== null
    && "scheduleCode" in error
    && typeof (error as { scheduleCode?: unknown }).scheduleCode === "string"
  ) {
    const coded = error as Error & { scheduleCode: string };
    return { code: coded.scheduleCode, message: coded.message };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "调度器内部错误" };
}
