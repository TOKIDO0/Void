/**
 * BEH-02 作息与节奏画像 —— 唯一 owner。
 *
 * 职责：只读 BEH-01 的每日聚合，派生可解释的作息画像；不采集、不落原始事件、不写记忆。
 *
 * 边界（2026-11-12 用户拍板，不得自行改动）：
 * - 只做小时级：BEH-01 只有 activeMinutesByHour，无法还原分钟级专注/休息。
 * - enabled=false → disabled；没有数据或证据不足 → insufficient_data；禁止编造。
 * - 文案 ≤80 字，必须带「仅电脑活跃」，禁止睡眠/健康/专注措辞。
 *
 * 只有本文件定义画像判定语义；store / handler / 前端同步层只做数据搬运与展示。
 */

import { dateKeyOf, isDateKey, type BehaviorDay } from "./behaviorTypes";

/** 画像窗口：近 14 个本地自然日（含今天）。 */
export const BEHAVIOR_PROFILE_WINDOW_DAYS = 14;

/** 有效样本日门槛：activeMinutes > 0 的天数。 */
export const BEHAVIOR_PROFILE_MIN_SAMPLE_DAYS = 3;

/** 累计活跃分钟门槛。 */
export const BEHAVIOR_PROFILE_MIN_ACTIVE_MINUTES = 90;

/** 最近数据最大年龄：超过该天数视为过期，返回 N/A。 */
export const BEHAVIOR_PROFILE_MAX_DATA_AGE_DAYS = 3;

/** 活跃小时阈值：平均每小时活跃 ≥20 分钟才进入活跃块。 */
export const BEHAVIOR_PROFILE_ACTIVE_HOUR_THRESHOLD_MIN = 20;

/** 没有连续活跃块时，单小时窗口的最低平均活跃分钟。 */
export const BEHAVIOR_PROFILE_SINGLE_HOUR_MIN = 30;

/** 低活跃空档的跨度边界：首次/末次平均活跃 ≥10 分钟的小时。 */
export const BEHAVIOR_PROFILE_GAP_ACTIVE_HOUR_MIN = 10;

/** 低活跃空档阈值：平均每小时活跃 <5 分钟视为空档。 */
export const BEHAVIOR_PROFILE_GAP_HOUR_MAX_MIN = 5;

/** 最多输出 2 个活跃块 / 2 个空档。 */
export const BEHAVIOR_PROFILE_MAX_ACTIVE_WINDOWS = 2;
export const BEHAVIOR_PROFILE_MAX_REST_GAPS = 2;

/** 早/晚型判定：有效作息日数量与单日最低活跃分钟。 */
export const BEHAVIOR_PROFILE_CHRONOTYPE_MIN_DAYS = 3;
export const BEHAVIOR_PROFILE_CHRONOTYPE_MIN_DAY_ACTIVE_MINUTES = 30;

/** 早型：首次活跃不晚于 09:00，且上午权重 ≥ 晚间权重 ×1.2。 */
export const BEHAVIOR_PROFILE_EARLY_FIRST_ACTIVE_MINUTE = 9 * 60;
export const BEHAVIOR_PROFILE_MORNING_DOMINANCE_RATIO = 1.2;

/** 晚型：末次活跃 ≥23:00，或晚间权重 ≥ 上午权重 ×1.5。 */
export const BEHAVIOR_PROFILE_LATE_LAST_ACTIVE_MINUTE = 23 * 60;
export const BEHAVIOR_PROFILE_EVENING_DOMINANCE_RATIO = 1.5;

/** 置信度分档。 */
export const BEHAVIOR_PROFILE_HIGH_SAMPLE_DAYS = 10;
export const BEHAVIOR_PROFILE_HIGH_ACTIVE_MINUTES = 1200;
export const BEHAVIOR_PROFILE_MEDIUM_SAMPLE_DAYS = 6;
export const BEHAVIOR_PROFILE_MEDIUM_ACTIVE_MINUTES = 600;

const HOURS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

export type BehaviorChronotype = "early" | "late" | "neutral" | "unknown";

export type BehaviorActiveWindow = {
  /** 起始小时（含），0–23 */
  startHour: number;
  /** 结束小时（不含），1–24；09–12 表示 9、10、11 三个小时 */
  endHourExclusive: number;
  /** 该时段平均每天活跃分钟数（按有效样本日平均） */
  avgMinutesPerDay: number;
};

export type BehaviorRestGap = {
  /** 起始小时（含） */
  startHour: number;
  /** 结束小时（不含） */
  endHourExclusive: number;
};

export type BehaviorProfileMemoryDraft = {
  memoryType: "preference";
  subjectType: "self";
  subjectName: string;
  content: string;
  confidence: number;
  source: "behaviorProfile";
};

export type BehaviorProfile = {
  /** ok=可写画像；insufficient_data=数据不足/过期；disabled=观察关闭 */
  status: "ok" | "insufficient_data" | "disabled";
  enabled: boolean;
  /** 非 ok 时的结构化原因；ok 时为空串 */
  reason: string;
  windowDays: 14;
  /** 最新有效数据日期 YYYY-MM-DD；无数据为 null */
  dataThrough: string | null;
  evidence: {
    /** activeMinutes > 0 的天数 */
    sampleDays: number;
    /** 窗口内累计活跃分钟数 */
    totalActiveMinutes: number;
    /** 有效作息日的首次活跃时间中位数（当天 0 点起的分钟数） */
    firstActiveMedianMinute: number | null;
    /** 有效作息日的末次活跃时间中位数 */
    lastActiveMedianMinute: number | null;
  };
  chronotype: BehaviorChronotype;
  activeWindows: BehaviorActiveWindow[];
  restGaps: BehaviorRestGap[];
  /** 0–1；仅在 status="ok" 时有意义 */
  confidence: number;
  /** status="ok" 时非 null；其它状态必须为 null */
  memoryDraft: BehaviorProfileMemoryDraft | null;
  /** 确定性签名：同输入同签名；用于观测与幂等排查 */
  signature: string;
  /** 本次派生时间，仅观测用，不参与签名 */
  generatedAt: number;
};

/** BEH-02 的只读输入：BEH-01 开关 + 每日聚合。 */
export type BehaviorProfileSource = {
  enabled: boolean;
  days: BehaviorDay[];
};

/**
 * 从 BEH-01 每日聚合派生作息画像。
 * 纯函数：不读文件、不写文件、不发网络、不读当前时间（nowMs 显式传入）。
 */
export function deriveBehaviorProfile(
  source: BehaviorProfileSource,
  nowMs = Date.now()
): BehaviorProfile {
  const profile: BehaviorProfile = {
    status: "insufficient_data",
    enabled: source.enabled === true,
    reason: "",
    windowDays: BEHAVIOR_PROFILE_WINDOW_DAYS,
    dataThrough: null,
    evidence: {
      sampleDays: 0,
      totalActiveMinutes: 0,
      firstActiveMedianMinute: null,
      lastActiveMedianMinute: null
    },
    chronotype: "unknown",
    activeWindows: [],
    restGaps: [],
    confidence: 0,
    memoryDraft: null,
    signature: "",
    generatedAt: nowMs
  };

  if (!profile.enabled) {
    profile.status = "disabled";
    profile.reason = "行为观察已关闭";
    profile.signature = signatureOf(profile);
    return profile;
  }

  const windowStart = localDayKey(nowMs, -(BEHAVIOR_PROFILE_WINDOW_DAYS - 1));
  const windowEnd = localDayKey(nowMs, 0);
  const daysByDate = new Map<string, BehaviorDay>();
  for (const day of source.days) {
    if (!isDateKey(day.date) || day.date < windowStart || day.date > windowEnd) {
      continue;
    }
    daysByDate.set(day.date, day);
  }

  const samples = [...daysByDate.values()]
    .map((day) => {
      const hourly = hourlyMinutes(day);
      return {
        day,
        hourly,
        activeMinutes: hourly.reduce((sum, value) => sum + value, 0)
      };
    })
    .filter((item) => item.activeMinutes > 0)
    .sort((a, b) => a.day.date.localeCompare(b.day.date));

  const sampleDays = samples.length;
  const totalActiveMinutes = samples.reduce((sum, item) => sum + item.activeMinutes, 0);
  const dataThrough = sampleDays > 0 ? samples[sampleDays - 1].day.date : null;

  profile.dataThrough = dataThrough;
  profile.evidence.sampleDays = sampleDays;
  profile.evidence.totalActiveMinutes = totalActiveMinutes;

  if (sampleDays === 0) {
    profile.status = "insufficient_data";
    profile.reason = "行为数据为空";
    profile.signature = signatureOf(profile);
    return profile;
  }

  if (
    sampleDays < BEHAVIOR_PROFILE_MIN_SAMPLE_DAYS
    || totalActiveMinutes < BEHAVIOR_PROFILE_MIN_ACTIVE_MINUTES
  ) {
    profile.status = "insufficient_data";
    profile.reason = `有效样本不足（至少 ${BEHAVIOR_PROFILE_MIN_SAMPLE_DAYS} 天、累计 ${BEHAVIOR_PROFILE_MIN_ACTIVE_MINUTES} 分钟）`;
    profile.signature = signatureOf(profile);
    return profile;
  }

  const freshnessCutoff = localDayKey(nowMs, -(BEHAVIOR_PROFILE_MAX_DATA_AGE_DAYS - 1));
  if (!dataThrough || dataThrough < freshnessCutoff) {
    profile.status = "insufficient_data";
    profile.reason = `近期无采样（最近数据早于 ${BEHAVIOR_PROFILE_MAX_DATA_AGE_DAYS} 天前）`;
    profile.signature = signatureOf(profile);
    return profile;
  }

  profile.status = "ok";
  profile.reason = "";

  const averageByHour = new Array<number>(HOURS_PER_DAY).fill(0);
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    averageByHour[hour] = samples.reduce((sum, item) => sum + item.hourly[hour], 0) / sampleDays;
  }

  const rhythmDays = samples.filter(
    (item) =>
      item.activeMinutes >= BEHAVIOR_PROFILE_CHRONOTYPE_MIN_DAY_ACTIVE_MINUTES
      && item.day.firstActiveAt > 0
      && item.day.lastActiveAt > 0
  );
  const firstMedian = median(rhythmDays.map((item) => minuteOfDay(item.day.firstActiveAt)));
  const lastMedian = median(rhythmDays.map((item) => minuteOfDay(item.day.lastActiveAt)));

  profile.evidence.firstActiveMedianMinute = firstMedian;
  profile.evidence.lastActiveMedianMinute = lastMedian;
  profile.chronotype = classifyChronotype(averageByHour, firstMedian, lastMedian, rhythmDays.length);
  profile.activeWindows = detectActiveWindows(averageByHour);
  profile.restGaps = detectRestGaps(averageByHour, profile.activeWindows);
  profile.confidence = confidenceFor(sampleDays, totalActiveMinutes);

  const content = buildMemoryContent({
    chronotype: profile.chronotype,
    activeWindows: profile.activeWindows,
    restGaps: profile.restGaps,
    sampleDays,
    confidence: profile.confidence,
    dataThrough
  });
  profile.memoryDraft = {
    memoryType: "preference",
    subjectType: "self",
    subjectName: "用户本人",
    content,
    confidence: profile.confidence,
    source: "behaviorProfile"
  };
  profile.signature = signatureOf(profile);
  return profile;
}

// ---------------------------------------------------------------------------
// 内部纯函数
// ---------------------------------------------------------------------------

function localDayKey(nowMs: number, offsetDays: number): string {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return dateKeyOf(date.getTime());
}

/** 把单日小时桶清洗成 24 个 0–60 的数值；脏值归零，不猜测。 */
function hourlyMinutes(day: BehaviorDay): number[] {
  const raw = Array.isArray(day.activeMinutesByHour) ? day.activeMinutesByHour : [];
  return Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
    const value = raw[hour];
    return typeof value === "number" && Number.isFinite(value)
      ? Math.min(60, Math.max(0, value))
      : 0;
  });
}

function minuteOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function sumRange(values: number[], start: number, endInclusive: number): number {
  let total = 0;
  for (let index = start; index <= endInclusive; index += 1) {
    if (index >= 0 && index < values.length) {
      total += values[index];
    }
  }
  return total;
}

function classifyChronotype(
  averageByHour: number[],
  firstMedian: number | null,
  lastMedian: number | null,
  rhythmDayCount: number
): BehaviorChronotype {
  if (
    rhythmDayCount < BEHAVIOR_PROFILE_CHRONOTYPE_MIN_DAYS
    || firstMedian === null
    || lastMedian === null
  ) {
    return "unknown";
  }
  const morningWeight = sumRange(averageByHour, 5, 11);
  const eveningWeight = sumRange(averageByHour, 17, 23);

  // 晚结束是比早开始更强的晚型信号；先判晚，避免“早开始 + 晚结束”被误判为早型。
  if (lastMedian >= BEHAVIOR_PROFILE_LATE_LAST_ACTIVE_MINUTE) {
    return "late";
  }
  if (
    firstMedian <= BEHAVIOR_PROFILE_EARLY_FIRST_ACTIVE_MINUTE
    && morningWeight >= eveningWeight * BEHAVIOR_PROFILE_MORNING_DOMINANCE_RATIO
  ) {
    return "early";
  }
  if (eveningWeight >= morningWeight * BEHAVIOR_PROFILE_EVENING_DOMINANCE_RATIO) {
    return "late";
  }
  return "neutral";
}

type HourRun = {
  startHour: number;
  endHourExclusive: number;
  totalMinutes: number;
};

function detectActiveWindows(averageByHour: number[]): BehaviorActiveWindow[] {
  const runs: HourRun[] = [];
  let runStart = -1;
  for (let hour = 0; hour <= HOURS_PER_DAY; hour += 1) {
    const active = hour < HOURS_PER_DAY
      && averageByHour[hour] >= BEHAVIOR_PROFILE_ACTIVE_HOUR_THRESHOLD_MIN;
    if (active && runStart < 0) {
      runStart = hour;
    }
    if (!active && runStart >= 0) {
      runs.push({
        startHour: runStart,
        endHourExclusive: hour,
        totalMinutes: sumRange(averageByHour, runStart, hour - 1)
      });
      runStart = -1;
    }
  }

  let candidates = runs.filter((run) => run.endHourExclusive - run.startHour >= 2);
  if (candidates.length === 0) {
    candidates = averageByHour
      .map((minutes, hour) => ({
        startHour: hour,
        endHourExclusive: hour + 1,
        totalMinutes: minutes
      }))
      .filter((run) => run.totalMinutes >= BEHAVIOR_PROFILE_SINGLE_HOUR_MIN)
      .sort((a, b) => b.totalMinutes - a.totalMinutes)
      .slice(0, BEHAVIOR_PROFILE_MAX_ACTIVE_WINDOWS);
  }

  return candidates
    .sort((a, b) => b.totalMinutes - a.totalMinutes || a.startHour - b.startHour)
    .slice(0, BEHAVIOR_PROFILE_MAX_ACTIVE_WINDOWS)
    .sort((a, b) => a.startHour - b.startHour)
    .map((run) => ({
      startHour: run.startHour,
      endHourExclusive: run.endHourExclusive,
      avgMinutesPerDay: round1(run.totalMinutes)
    }));
}

function detectRestGaps(
  averageByHour: number[],
  activeWindows: BehaviorActiveWindow[]
): BehaviorRestGap[] {
  if (activeWindows.length < 2) {
    return [];
  }
  const activeHours = averageByHour
    .map((minutes, hour) => ({ hour, minutes }))
    .filter((item) => item.minutes >= BEHAVIOR_PROFILE_GAP_ACTIVE_HOUR_MIN);
  if (activeHours.length < 2) {
    return [];
  }

  const firstHour = activeHours[0].hour;
  const lastHour = activeHours[activeHours.length - 1].hour;
  const gaps: BehaviorRestGap[] = [];
  let gapStart = -1;
  for (let hour = firstHour + 1; hour < lastHour; hour += 1) {
    const low = averageByHour[hour] < BEHAVIOR_PROFILE_GAP_HOUR_MAX_MIN;
    if (low && gapStart < 0) {
      gapStart = hour;
    }
    if (!low && gapStart >= 0) {
      gaps.push({ startHour: gapStart, endHourExclusive: hour });
      gapStart = -1;
    }
  }
  if (gapStart >= 0) {
    gaps.push({ startHour: gapStart, endHourExclusive: lastHour });
  }

  return gaps
    .sort(
      (a, b) =>
        (b.endHourExclusive - b.startHour) - (a.endHourExclusive - a.startHour)
        || a.startHour - b.startHour
    )
    .slice(0, BEHAVIOR_PROFILE_MAX_REST_GAPS)
    .sort((a, b) => a.startHour - b.startHour);
}

function confidenceFor(sampleDays: number, totalActiveMinutes: number): number {
  if (
    sampleDays >= BEHAVIOR_PROFILE_HIGH_SAMPLE_DAYS
    && totalActiveMinutes >= BEHAVIOR_PROFILE_HIGH_ACTIVE_MINUTES
  ) {
    return 0.8;
  }
  if (
    sampleDays >= BEHAVIOR_PROFILE_MEDIUM_SAMPLE_DAYS
    && totalActiveMinutes >= BEHAVIOR_PROFILE_MEDIUM_ACTIVE_MINUTES
  ) {
    return 0.65;
  }
  if (
    sampleDays >= BEHAVIOR_PROFILE_MIN_SAMPLE_DAYS
    && totalActiveMinutes >= BEHAVIOR_PROFILE_MIN_ACTIVE_MINUTES
  ) {
    return 0.5;
  }
  return 0;
}

function formatHour(hour: number): string {
  return `${hour}`.padStart(2, "0");
}

function buildMemoryContent(args: {
  chronotype: BehaviorChronotype;
  activeWindows: BehaviorActiveWindow[];
  restGaps: BehaviorRestGap[];
  sampleDays: number;
  confidence: number;
  dataThrough: string;
}): string {
  const tendency = args.chronotype === "early"
    ? "设备活跃偏早"
    : args.chronotype === "late"
      ? "设备活跃偏晚"
      : args.chronotype === "neutral"
        ? "设备活跃居中"
        : "设备活跃时段";
  const windows = args.activeWindows.length > 0
    ? `主要 ${args.activeWindows
      .map((window) => `${formatHour(window.startHour)}–${formatHour(window.endHourExclusive)}`)
      .join("、")} 点`
    : "活跃时段较分散";
  const gaps = args.restGaps.length > 0
    ? `；${args.restGaps
      .map((gap) => `${formatHour(gap.startHour)}–${formatHour(gap.endHourExclusive)}`)
      .join("、")} 点常低活跃`
    : "";
  const confidenceLabel = args.confidence >= 0.8
    ? "高"
    : args.confidence >= 0.65
      ? "中等"
      : "较低";
  return `${tendency}：${windows}${gaps}。近${BEHAVIOR_PROFILE_WINDOW_DAYS}天${args.sampleDays}天样本·${confidenceLabel}置信度（至${args.dataThrough.slice(5)}，仅电脑活跃）`;
}

function signatureOf(profile: BehaviorProfile): string {
  const payload = {
    status: profile.status,
    enabled: profile.enabled,
    reason: profile.reason,
    dataThrough: profile.dataThrough,
    sampleDays: profile.evidence.sampleDays,
    chronotype: profile.chronotype,
    activeWindows: profile.activeWindows,
    restGaps: profile.restGaps,
    confidence: profile.confidence,
    content: profile.memoryDraft?.content ?? ""
  };
  return fnv1a(JSON.stringify(payload));
}

/** FNV-1a 32 位；只做确定性签名，不做安全哈希。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
