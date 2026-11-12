/**
 * BEH-01 行为事件采集 —— 唯一 owner。
 *
 * 职责：把「系统空闲秒数」样本折算成每日分钟桶，并派生任务成功/失败数。
 * 不负责：系统观测（Rust 探针）、协议搬运（前端泵）、展示（设置 UI）。
 *
 * 存储：<runtime>/behavior/daily.json，原子写（tmp + rename），保留 90 天。
 * 原始样本从不落盘，入桶后即丢弃。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import { schedulerStore } from "../scheduler/schedulerStore";
import {
  BEHAVIOR_ACTIVE_IDLE_THRESHOLD_SEC,
  BEHAVIOR_FLUSH_INTERVAL_MS,
  BEHAVIOR_MAX_KEPT_DAYS,
  BEHAVIOR_STATE_VERSION,
  BEHAVIOR_TASK_RUN_SCAN_LIMIT,
  HOURS_PER_DAY,
  dateKeyOf,
  emptyDay,
  emptyState,
  hourOf,
  isDateKey,
  sanitizeCount,
  sanitizeSample,
  type BehaviorDay,
  type BehaviorState
} from "./behaviorTypes";

const DAY_MS = 24 * 60 * 60 * 1000;

export type BehaviorIngestResult = {
  accepted: number;
  rejected: number;
  /** 开关关闭时为 true：样本未被记录，也未推进游标。 */
  disabled: boolean;
};

export type BehaviorStatus = {
  enabled: boolean;
  retentionDays: number;
  today: BehaviorDay | null;
  lastSampleAt: number;
  rejectedSamples: number;
  outOfOrderSamples: number;
  corruptCount: number;
  probeReadFailures: number;
  /** 本次派生任务计数扫描到的 run 记录条数（100 条上限导致的低估可从这里的饱和看出来）。 */
  runsScanned: number;
  fileBytes: number;
};

function behaviorDir(): string {
  const fromEnv = process.env.VOID_BEHAVIOR_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "behavior");
}

function behaviorFile(): string {
  return join(behaviorDir(), "daily.json");
}

function sanitizeDay(raw: unknown, date: string): BehaviorDay | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const day = emptyDay(date);
  if (Array.isArray(record.activeMinutesByHour)) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      // 每小时最多 60 分钟；超额视为脏数据直接夹紧。
      day.activeMinutesByHour[hour] = Math.min(60, sanitizeCount(record.activeMinutesByHour[hour]));
    }
  }
  day.activeMinutes = Math.min(
    HOURS_PER_DAY * 60,
    sanitizeCount(record.activeMinutes) || day.activeMinutesByHour.reduce((sum, value) => sum + value, 0)
  );
  day.firstActiveAt = sanitizeCount(record.firstActiveAt);
  day.lastActiveAt = sanitizeCount(record.lastActiveAt);
  day.taskSucceeded = sanitizeCount(record.taskSucceeded);
  day.taskFailed = sanitizeCount(record.taskFailed);
  day.taskMissed = sanitizeCount(record.taskMissed);
  return day;
}

/** 结构无法辨认（非对象 / 版本不符）由调用方决定是否隔离；这里只做字段级清洗。 */
function sanitizeState(raw: unknown): BehaviorState | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== BEHAVIOR_STATE_VERSION) {
    return null;
  }
  const state = emptyState();
  state.enabled = record.enabled === true;
  state.lastSampleAt = sanitizeCount(record.lastSampleAt);
  state.lastMinuteKey = sanitizeCount(record.lastMinuteKey);
  state.rejectedSamples = sanitizeCount(record.rejectedSamples);
  state.outOfOrderSamples = sanitizeCount(record.outOfOrderSamples);
  state.corruptCount = sanitizeCount(record.corruptCount);
  state.probeReadFailures = sanitizeCount(record.probeReadFailures);
  if (typeof record.days === "object" && record.days !== null && !Array.isArray(record.days)) {
    for (const [date, value] of Object.entries(record.days as Record<string, unknown>)) {
      if (!isDateKey(date)) {
        continue;
      }
      const day = sanitizeDay(value, date);
      if (day) {
        state.days[date] = day;
      }
    }
  }
  return state;
}

class BehaviorStore {
  private state: BehaviorState | null = null;
  private lastFlushAt = 0;
  private lastFlushDayKey = "";
  private lastRunsScanned = 0;

  private ensureLoaded(): BehaviorState {
    if (this.state) {
      return this.state;
    }
    mkdirSync(behaviorDir(), { recursive: true });
    const file = behaviorFile();
    if (!existsSync(file)) {
      this.state = emptyState();
      return this.state;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return this.quarantineCorrupt("JSON 解析失败");
    }
    const sanitized = sanitizeState(parsed);
    if (!sanitized) {
      return this.quarantineCorrupt("结构或版本不匹配");
    }
    this.state = sanitized;
    return this.state;
  }

  /**
   * 损坏文件改名隔离后从空状态起。
   * 不猜测修复：猜出来的作息比没有作息更糟（会变成编造的用户画像）。
   */
  private quarantineCorrupt(reason: string): BehaviorState {
    const file = behaviorFile();
    try {
      renameSync(file, join(behaviorDir(), `daily.corrupt-${Date.now()}.json`));
    } catch {
      // 改名失败也不能阻塞启动：内存里从空状态继续，下次 flush 会覆盖。
    }
    const state = emptyState();
    state.corruptCount = 1;
    this.state = state;
    console.warn(`[void-behavior] daily.json 已隔离（${reason}），从空状态继续`);
    return state;
  }

  private prune(state: BehaviorState, nowMs: number): void {
    const cutoff = nowMs - BEHAVIOR_MAX_KEPT_DAYS * DAY_MS;
    for (const date of Object.keys(state.days)) {
      const dayMs = new Date(`${date}T00:00:00`).getTime();
      if (Number.isFinite(dayMs) && dayMs < cutoff) {
        delete state.days[date];
      }
    }
    // 双保险：按日期键排序后仍超上限时删最旧（时钟异常导致的重复区间）。
    const remaining = Object.keys(state.days).sort();
    while (remaining.length > BEHAVIOR_MAX_KEPT_DAYS) {
      const oldest = remaining.shift();
      if (oldest) {
        delete state.days[oldest];
      }
    }
  }

  private flush(nowMs = Date.now()): void {
    const state = this.ensureLoaded();
    this.prune(state, nowMs);
    const file = behaviorFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
  }

  private maybeFlush(nowMs: number): void {
    const dayKey = dateKeyOf(nowMs);
    const dayChanged = dayKey !== this.lastFlushDayKey;
    if (!dayChanged && nowMs - this.lastFlushAt < BEHAVIOR_FLUSH_INTERVAL_MS) {
      return;
    }
    this.flush(nowMs);
    this.lastFlushAt = nowMs;
    this.lastFlushDayKey = dayKey;
  }

  /**
   * 从 scheduler run 记录只读派生当天的任务结果。
   * 覆盖式重算（不是累加），因此重复调用与重放都不会放大计数。
   */
  private refreshTaskCounts(nowMs: number): void {
    const state = this.ensureLoaded();
    const today = dateKeyOf(nowMs);
    const runs = schedulerStore.listRuns(BEHAVIOR_TASK_RUN_SCAN_LIMIT);
    this.lastRunsScanned = runs.length;
    let succeeded = 0;
    let failed = 0;
    let missed = 0;
    for (const run of runs) {
      // PRO-05 心跳巡检是代理主动产物，不是用户任务；计入会污染作息画像的任务完成率。
      if (run.origin === "agent") {
        continue;
      }
      if (typeof run.finishedAt !== "number" || dateKeyOf(run.finishedAt) !== today) {
        continue;
      }
      if (run.status === "succeeded") {
        succeeded += 1;
      } else if (run.status === "missed") {
        missed += 1;
      } else if (run.status === "failed" || run.status === "timed_out" || run.status === "paused_needs_user") {
        failed += 1;
      }
    }
    if (succeeded + failed + missed === 0) {
      return;
    }
    const day = state.days[today] ?? (state.days[today] = emptyDay(today));
    day.taskSucceeded = succeeded;
    day.taskFailed = failed;
    day.taskMissed = missed;
  }

  private fileBytes(): number {
    try {
      return statSync(behaviorFile()).size;
    } catch {
      return 0;
    }
  }

  /** 入桶：分钟键去重 + 跨天按本地日期分桶 + 活动分钟计数。 */
  ingest(rawSamples: unknown[], probeReadFailures: unknown, nowMs = Date.now()): BehaviorIngestResult {
    const state = this.ensureLoaded();
    if (!state.enabled) {
      return { accepted: 0, rejected: 0, disabled: true };
    }
    if (typeof probeReadFailures === "number" && Number.isFinite(probeReadFailures) && probeReadFailures >= 0) {
      state.probeReadFailures = Math.floor(probeReadFailures);
    }
    let accepted = 0;
    let rejected = 0;
    let dirty = false;
    for (const raw of rawSamples) {
      const sample = sanitizeSample(raw);
      if (!sample) {
        state.rejectedSamples += 1;
        rejected += 1;
        dirty = true;
        continue;
      }
      const minuteKey = Math.floor(sample.tsMs / 60_000);
      if (minuteKey <= state.lastMinuteKey) {
        if (minuteKey < state.lastMinuteKey) {
          state.outOfOrderSamples += 1;
          dirty = true;
        }
        continue;
      }
      state.lastMinuteKey = minuteKey;
      state.lastSampleAt = Math.max(state.lastSampleAt, sample.tsMs);
      if (sample.idleSec < BEHAVIOR_ACTIVE_IDLE_THRESHOLD_SEC) {
        const date = dateKeyOf(sample.tsMs);
        const day = state.days[date] ?? (state.days[date] = emptyDay(date));
        const hour = hourOf(sample.tsMs);
        if (day.activeMinutesByHour[hour] < 60) {
          day.activeMinutesByHour[hour] += 1;
          day.activeMinutes += 1;
        }
        if (day.firstActiveAt === 0 || sample.tsMs < day.firstActiveAt) {
          day.firstActiveAt = sample.tsMs;
        }
        if (sample.tsMs > day.lastActiveAt) {
          day.lastActiveAt = sample.tsMs;
        }
      }
      accepted += 1;
      dirty = true;
    }
    if (dirty) {
      this.maybeFlush(nowMs);
    }
    return { accepted, rejected, disabled: false };
  }

  setEnabled(enabled: boolean): boolean {
    const state = this.ensureLoaded();
    state.enabled = enabled;
    this.flush();
    this.lastFlushAt = Date.now();
    this.lastFlushDayKey = dateKeyOf(this.lastFlushAt);
    return state.enabled;
  }

  /**
   * BEH-02 只读快照：开关 + 每日聚合副本。
   * 不刷新任务计数、不写盘、不暴露内部引用；画像判定不在本文件。
   */
  readProfileSource(): { enabled: boolean; days: BehaviorDay[] } {
    const state = this.ensureLoaded();
    return {
      enabled: state.enabled,
      days: Object.values(state.days).map((day) => ({
        ...day,
        activeMinutesByHour: [...day.activeMinutesByHour]
      }))
    };
  }

  getStatus(nowMs = Date.now()): BehaviorStatus {
    const state = this.ensureLoaded();
    this.refreshTaskCounts(nowMs);
    return {
      enabled: state.enabled,
      retentionDays: state.retentionDays,
      today: state.days[dateKeyOf(nowMs)] ?? null,
      lastSampleAt: state.lastSampleAt,
      rejectedSamples: state.rejectedSamples,
      outOfOrderSamples: state.outOfOrderSamples,
      corruptCount: state.corruptCount,
      probeReadFailures: state.probeReadFailures,
      runsScanned: this.lastRunsScanned,
      fileBytes: this.fileBytes()
    };
  }

  /** 测试/隔离专用：重置内存态（不删文件；隔离目录由调用方保证）。 */
  resetMemory(): void {
    this.state = null;
    this.lastFlushAt = 0;
    this.lastFlushDayKey = "";
    this.lastRunsScanned = 0;
  }
}

export const behaviorStore = new BehaviorStore();
