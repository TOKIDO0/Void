/**
 * BEH-01 行为事件采集 —— 类型与常量唯一真源。
 *
 * 采集边界（2026-11-12 用户拍板，不得自行扩大）：
 * - 只收「系统空闲秒数 + 时间戳」。不收应用名、窗口标题、键盘、鼠标轨迹、屏幕、剪贴板。
 * - 原始样本不落盘：bridge 折算成分钟桶后立即丢弃，磁盘上只有每日聚合。
 * - 默认关闭（enabled=false）；关闭时不采样，也不保留未上送的原始样本。
 *
 * 只有本文件定义数据形状；store / handler / UI 一律从这里引入，不得自建平行结构。
 */

/** 当前数据版本；版本不匹配的旧文件会被隔离而不是猜测迁移。 */
export const BEHAVIOR_STATE_VERSION = 1;

/** 每日聚合保留天数（固定 90，不做用户可调，避免配置膨胀）。 */
export const BEHAVIOR_MAX_KEPT_DAYS = 90;

/** 活跃判定阈值：样本空闲秒数小于该值，记该分钟活跃。 */
export const BEHAVIOR_ACTIVE_IDLE_THRESHOLD_SEC = 120;

/** 单次上报样本上限（60 条 = 1 小时，避免一次灌入大量历史）。 */
export const BEHAVIOR_MAX_SAMPLES_PER_REQUEST = 60;

/** 派生任务计数时扫描的 scheduler run 记录上限（与 MAX_RUN_RECORDS 对齐）。 */
export const BEHAVIOR_TASK_RUN_SCAN_LIMIT = 100;

/** 落盘节流：两次 flush 的最小间隔。 */
export const BEHAVIOR_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** 一天的小时数（分桶数组长度）。 */
export const HOURS_PER_DAY = 24;

/** 一条原始样本：传感器读到的系统空闲时长。 */
export type BehaviorSample = {
  /** 采样时刻 epoch ms */
  tsMs: number;
  /** 采样时系统空闲秒数 */
  idleSec: number;
};

/** 单日聚合（唯一落盘形态）。 */
export type BehaviorDay = {
  date: string;
  /** 24 个桶，每桶 0–60 分钟 */
  activeMinutesByHour: number[];
  activeMinutes: number;
  firstActiveAt: number;
  lastActiveAt: number;
  /** 从 scheduler run 记录只读派生的任务结果计数 */
  taskSucceeded: number;
  taskFailed: number;
  taskMissed: number;
};

export type BehaviorState = {
  version: 1;
  enabled: boolean;
  retentionDays: number;
  /** 最近一次成功入桶的样本时间 */
  lastSampleAt: number;
  /** 幂等游标：floor(tsMs / 60000) */
  lastMinuteKey: number;
  /** 被丢弃的非法样本数（字段缺失/负数等） */
  rejectedSamples: number;
  /** 早于游标被丢弃的乱序样本数 */
  outOfOrderSamples: number;
  /** 损坏文件被隔离的次数（损坏文件本身不承载计数，重建后从 1 起） */
  corruptCount: number;
  /** 探测端本进程内读取系统空闲失败的累计次数（覆盖式上报，不做累加） */
  probeReadFailures: number;
  days: Record<string, BehaviorDay>;
};

/** 本地日期键 YYYY-MM-DD（按宿主时区，与用户作息一致）。 */
export function dateKeyOf(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 本地小时（0–23）。 */
export function hourOf(ms: number): number {
  return new Date(ms).getHours();
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function emptyDay(date: string): BehaviorDay {
  return {
    date,
    activeMinutesByHour: new Array<number>(HOURS_PER_DAY).fill(0),
    activeMinutes: 0,
    firstActiveAt: 0,
    lastActiveAt: 0,
    taskSucceeded: 0,
    taskFailed: 0,
    taskMissed: 0
  };
}

export function emptyState(): BehaviorState {
  return {
    version: BEHAVIOR_STATE_VERSION,
    enabled: false,
    retentionDays: BEHAVIOR_MAX_KEPT_DAYS,
    lastSampleAt: 0,
    lastMinuteKey: 0,
    rejectedSamples: 0,
    outOfOrderSamples: 0,
    corruptCount: 0,
    probeReadFailures: 0,
    days: {}
  };
}

/** 非负整数计数：脏输入归零，不向下游传播 NaN。 */
export function sanitizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 合法样本守卫：非法条目一律丢弃并计数，不做任何猜测性修正。 */
export function sanitizeSample(raw: unknown): BehaviorSample | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const tsMs = typeof record.tsMs === "number" && Number.isFinite(record.tsMs) ? record.tsMs : NaN;
  const idleSec = typeof record.idleSec === "number" && Number.isFinite(record.idleSec) ? record.idleSec : NaN;
  if (!(tsMs > 0) || !(idleSec >= 0)) {
    return null;
  }
  return { tsMs: Math.floor(tsMs), idleSec: Math.floor(idleSec) };
}
