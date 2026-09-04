/**
 * P4 调度器引擎：纯函数（可单测）。计时/执行/落盘在 runner/store。
 * 定时器臂按 OpenClaw 教训：最大重臂 60s，防休眠漂移。
 */

import {
  DEFAULT_UNATTENDED_TOOL_NAMES,
  createScheduleError,
  type ScheduleCreateInput,
  type ScheduleJob,
  type SchedulerRunStatus
} from "./schedulerTypes";

export const MIN_EVERY_MS = 60_000;
export const MAX_EVERY_MS = 30 * 24 * 3600_000;
export const MAX_JOBS = 50;
export const MAX_RUN_RECORDS = 100;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const MIN_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 3600_000;
/** 一次性任务过期宽限：宽限内启动即跑一次，超限记 missed 不补跑。 */
export const AT_GRACE_MS = 5 * 60_000;
export const MAX_TIMER_DELAY_MS = 60_000;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_NAME_CHARS = 80;

let jobSequence = 0;
let runSequence = 0;

export function nextJobId(): string {
  jobSequence += 1;
  return `job_${Date.now().toString(36)}_${jobSequence}`;
}

export function nextRunId(): string {
  runSequence += 1;
  return `run_${Date.now().toString(36)}_${runSequence}`;
}

function parseDurationMs(raw: number | string): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.floor(raw) : null;
  }
  const text = raw.trim().toLowerCase();
  const match = text.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3600_000 : 24 * 3600_000;
  return value * factor;
}

function parseAtMs(raw: string | number): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.floor(raw) : null;
  }
  const text = raw.trim();
  const asNumber = Number(text);
  if (text !== "" && Number.isFinite(asNumber)) {
    return Math.floor(asNumber);
  }
  const asDate = Date.parse(text);
  return Number.isFinite(asDate) ? asDate : null;
}

/** 校验创建输入并归一化为待存 job（不含 id/createdAt/nextRunAtMs，由 store 补）。 */
export function validateCreateInput(raw: ScheduleCreateInput, nowMs: number): Omit<ScheduleJob, "id" | "createdAt" | "nextRunAtMs"> {
  const prompt = (raw.prompt ?? "").trim();
  if (!prompt) {
    throw createScheduleError("INVALID_REQUEST", "prompt 不能为空");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw createScheduleError("INVALID_REQUEST", `prompt 不得超过 ${MAX_PROMPT_CHARS} 字`);
  }
  const name = (raw.name ?? "").trim().slice(0, MAX_NAME_CHARS) || prompt.slice(0, 40);
  const timeoutMs = raw.timeoutMs === undefined
    ? DEFAULT_TIMEOUT_MS
    : Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw.timeoutMs)));
  if (raw.timeoutMs !== undefined && !Number.isFinite(raw.timeoutMs)) {
    throw createScheduleError("INVALID_REQUEST", "timeoutMs 非法");
  }
  const allowedToolNames = raw.allowedToolNames === undefined
    ? [...DEFAULT_UNATTENDED_TOOL_NAMES]
    : raw.allowedToolNames.map((item) => String(item).trim()).filter(Boolean);
  if (allowedToolNames.length === 0) {
    throw createScheduleError("INVALID_REQUEST", "allowedToolNames 不能为空");
  }
  if (allowedToolNames.some((item) => item.length > 80)) {
    throw createScheduleError("INVALID_REQUEST", "工具名过长");
  }

  if (raw.kind === "at") {
    if (raw.at === undefined) {
      throw createScheduleError("INVALID_REQUEST", "at 任务必须给 at 时间");
    }
    const atMs = parseAtMs(raw.at);
    if (atMs === null) {
      throw createScheduleError("INVALID_REQUEST", "at 时间无法解析（ISO 或毫秒时间戳）");
    }
    if (atMs <= nowMs) {
      throw createScheduleError("INVALID_REQUEST", "at 时间必须在未来");
    }
    return { name, prompt, kind: "at", atMs, allowedToolNames, timeoutMs, speakOnDeliver: raw.speakOnDeliver === true, enabled: true, missedCount: 0, failStreak: 0 };
  }
  if (raw.kind === "every") {
    if (raw.every === undefined) {
      throw createScheduleError("INVALID_REQUEST", "every 任务必须给 every 间隔");
    }
    const everyMs = parseDurationMs(raw.every);
    if (everyMs === null || everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) {
      throw createScheduleError("INVALID_REQUEST", `every 间隔非法（60s～30d，支持 10m/1h/1d 简写）`);
    }
    let anchorMs = nowMs;
    if (raw.anchor !== undefined) {
      const parsedAnchor = parseAtMs(raw.anchor);
      if (parsedAnchor === null) {
        throw createScheduleError("INVALID_REQUEST", "anchor 无法解析（ISO 或毫秒时间戳）");
      }
      anchorMs = parsedAnchor;
    }
    return { name, prompt, kind: "every", everyMs, anchorMs, allowedToolNames, timeoutMs, speakOnDeliver: raw.speakOnDeliver === true, enabled: true, missedCount: 0, failStreak: 0 };
  }
  throw createScheduleError("INVALID_REQUEST", `未知调度种类（仅 at/every）：${String((raw as { kind?: unknown }).kind)}`);
}

/** 计算下次触发毫秒；undefined 表示不再触发（过期 at）。 */
export function computeNextRunAtMs(job: Pick<ScheduleJob, "kind" | "atMs" | "everyMs" | "anchorMs" | "createdAt">, createdAt: number, nowMs: number): number | undefined {
  if (job.kind === "at") {
    const atMs = job.atMs ?? 0;
    return atMs > nowMs ? atMs : undefined;
  }
  const everyMs = Math.max(1, Math.floor(job.everyMs ?? 0));
  if (!(everyMs > 0)) {
    return undefined;
  }
  const anchor = Math.max(0, Math.floor(job.anchorMs ?? createdAt));
  if (nowMs < anchor) {
    return anchor;
  }
  const steps = Math.max(1, Math.floor((nowMs - anchor + everyMs) / everyMs));
  return anchor + steps * everyMs;
}

/**
 * 启动扫尾：返回本轮应立即跑一次的 job id；过期 at 按宽限记 missed（停用留查，不补跑）。
 * every 永不补跑，直接按 now 重算下次。
 */
export function applyStartupSweep(
  jobs: ScheduleJob[],
  nowMs: number
): { dueNow: string[]; missed: string[] } {
  const dueNow: string[] = [];
  const missed: string[] = [];
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    if (job.kind === "at") {
      const atMs = job.atMs ?? 0;
      if (atMs > nowMs) {
        job.nextRunAtMs = atMs;
        continue;
      }
      if (nowMs - atMs <= AT_GRACE_MS) {
        job.nextRunAtMs = nowMs;
        dueNow.push(job.id);
      } else {
        job.enabled = false;
        job.missedCount += 1;
        job.nextRunAtMs = undefined;
        missed.push(job.id);
      }
      continue;
    }
    job.nextRunAtMs = computeNextRunAtMs(job, job.createdAt, nowMs);
  }
  return { dueNow, missed };
}

/** run 终态落账：at 成功即删（调用方执行删除），其余更新 lastRun/failStreak/next。 */
export function settleRun(
  job: ScheduleJob,
  createdAt: number,
  status: SchedulerRunStatus,
  nowMs: number
): { deleteJob: boolean } {
  job.lastRunAtMs = nowMs;
  job.lastStatus = status;
  if (status === "succeeded") {
    job.failStreak = 0;
    if (job.kind === "at") {
      return { deleteJob: true };
    }
  } else if (status === "failed" || status === "timed_out") {
    job.failStreak += 1;
  }
  job.nextRunAtMs = job.kind === "at" ? undefined : computeNextRunAtMs(job, createdAt, nowMs);
  if (job.kind === "at" && status !== "succeeded") {
    job.enabled = false;
  }
  return { deleteJob: false };
}
