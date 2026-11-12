/**
 * PRO-04 安静时段策略 —— 唯一语义 owner。
 *
 * 只回答两个问题：
 * 1. 现在是否处于安静时段；
 * 2. 当前安静时段到几点结束 / 下一次状态翻转在什么时候。
 *
 * 不读写文件、不发 HTTP、不碰 UI。所有时间判断必须经过这里，
 * 禁止投递器、设置页或未来 Heartbeat 各写一份 getHours() 判断。
 */

export const MINUTES_PER_DAY = 24 * 60;

export const DEFAULT_QUIET_HOURS = {
  enabled: true,
  startMinutes: 23 * 60,
  endMinutes: 8 * 60
} as const;

export type QuietHoursConfig = {
  enabled: boolean;
  /** 本地墙钟分钟，0–1439。 */
  startMinutes: number;
  /** 本地墙钟分钟，0–1439；必须与 startMinutes 不同。 */
  endMinutes: number;
};

export type QuietHoursConfigStatus = "ok" | "missing" | "corrupt";

export type QuietHoursEvaluation = {
  enabled: boolean;
  quiet: boolean;
  /** 当前安静窗口结束的绝对毫秒；quiet=false 时为 null。 */
  windowEndsAt: number | null;
  /** 下一次状态翻转的绝对毫秒；enabled=false 时为 null。 */
  nextChangeAt: number | null;
};

export type ProactivityErrorCode = "INVALID_REQUEST";

export type ProactivityError = Error & { proactivityCode: ProactivityErrorCode };

export type QuietHoursConfigParseResult =
  | { ok: true; config: QuietHoursConfig }
  | { ok: false; message: string };

export function createProactivityError(
  code: ProactivityErrorCode,
  message: string
): ProactivityError {
  const error = new Error(message) as ProactivityError;
  error.proactivityCode = code;
  return error;
}

export function getProactivityErrorInfo(error: unknown): { code: string; message: string } {
  if (
    typeof error === "object"
    && error !== null
    && "proactivityCode" in error
    && typeof (error as { proactivityCode?: unknown }).proactivityCode === "string"
  ) {
    const coded = error as ProactivityError;
    return { code: coded.proactivityCode, message: coded.message };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "安静时段内部错误"
  };
}

export function defaultQuietHoursConfig(): QuietHoursConfig {
  return { ...DEFAULT_QUIET_HOURS };
}

export function isValidMinuteOfDay(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value < MINUTES_PER_DAY;
}

export function isValidQuietHoursConfig(config: QuietHoursConfig): boolean {
  return typeof config.enabled === "boolean"
    && isValidMinuteOfDay(config.startMinutes)
    && isValidMinuteOfDay(config.endMinutes)
    && config.startMinutes !== config.endMinutes;
}

/** 供 store 读文件与 HTTP 收 body 共用；只接受结构化整数分钟，不猜字符串。 */
export function parseQuietHoursConfig(raw: unknown): QuietHoursConfigParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "quiet hours 必须是对象" };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return { ok: false, message: "enabled 必须是布尔值" };
  }
  if (!isValidMinuteOfDay(record.startMinutes)) {
    return { ok: false, message: "startMinutes 必须是 0–1439 的整数" };
  }
  if (!isValidMinuteOfDay(record.endMinutes)) {
    return { ok: false, message: "endMinutes 必须是 0–1439 的整数" };
  }
  if (record.startMinutes === record.endMinutes) {
    return { ok: false, message: "开始时间与结束时间不能相同；关闭安静时段请使用开关" };
  }
  return {
    ok: true,
    config: {
      enabled: record.enabled,
      startMinutes: record.startMinutes,
      endMinutes: record.endMinutes
    }
  };
}

function localMinuteOfDay(nowMs: number): number {
  const date = new Date(nowMs);
  return date.getHours() * 60 + date.getMinutes();
}

/** 用本地日期构造器取“某天某分钟”的绝对毫秒，避免把一天当成固定 86400s。 */
function localMinuteMs(nowMs: number, dayOffset: number, minutes: number): number {
  const date = new Date(nowMs);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayOffset,
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0
  ).getTime();
}

/**
 * 纯函数：本地墙钟窗口判定。
 * - 开始分钟含，结束分钟不含；
 * - start > end 表示跨午夜；
 * - start == end 非法，调用方应先 parse/清洗；这里 fail-safe 回退默认窗口。
 */
export function evaluateQuietHours(
  config: QuietHoursConfig,
  nowMs: number
): QuietHoursEvaluation {
  if (!config.enabled) {
    return { enabled: false, quiet: false, windowEndsAt: null, nextChangeAt: null };
  }
  if (!isValidQuietHoursConfig(config)) {
    // 绝不把非法配置解释成“全天可打扰”。
    return evaluateQuietHours(defaultQuietHoursConfig(), nowMs);
  }

  const minute = localMinuteOfDay(nowMs);
  const { startMinutes, endMinutes } = config;
  const todayStart = localMinuteMs(nowMs, 0, startMinutes);
  const todayEnd = localMinuteMs(nowMs, 0, endMinutes);
  const tomorrowStart = localMinuteMs(nowMs, 1, startMinutes);
  const tomorrowEnd = localMinuteMs(nowMs, 1, endMinutes);

  if (startMinutes > endMinutes) {
    if (minute >= startMinutes) {
      return { enabled: true, quiet: true, windowEndsAt: tomorrowEnd, nextChangeAt: tomorrowEnd };
    }
    if (minute < endMinutes) {
      return { enabled: true, quiet: true, windowEndsAt: todayEnd, nextChangeAt: todayEnd };
    }
    return {
      enabled: true,
      quiet: false,
      windowEndsAt: null,
      nextChangeAt: todayStart
    };
  }

  const quiet = minute >= startMinutes && minute < endMinutes;
  if (quiet) {
    return { enabled: true, quiet: true, windowEndsAt: todayEnd, nextChangeAt: todayEnd };
  }
  return {
    enabled: true,
    quiet: false,
    windowEndsAt: null,
    nextChangeAt: minute < startMinutes ? todayStart : tomorrowStart
  };
}
