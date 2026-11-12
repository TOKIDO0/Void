/**
 * PRO-05 静默巡检策略 —— 唯一判定 owner（纯函数，不读写文件、不发 HTTP）。
 *
 * 只回答三件事：
 * 1. 清单里哪些检查被启用（未知行只记录、不执行）；
 * 2. 当前事实里哪些问题「可行动」；
 * 3. 哪些问题在 24h 去重窗口内已经提醒过。
 *
 * 不调用 LLM、不推断睡眠/健康/情绪（PRO-03 不在本轮）。
 * 不自己发通知：输出只是结构化 issue，由 runner 写进 PRO-06 队列。
 */

import type { CalendarEvent } from "../calendar/calendarTypes";
import type { ScheduleJob, SchedulerRunRecord } from "../scheduler/schedulerTypes";
import {
  HEARTBEAT_CHECK_ALIASES,
  HEARTBEAT_CHECK_IDS,
  HEARTBEAT_DEDUPE_TTL_MS,
  HEARTBEAT_EVENT_SCAN_LIMIT,
  HEARTBEAT_EVENT_WINDOW_MS,
  HEARTBEAT_JOB_ID,
  HEARTBEAT_MAX_CHECKLIST_LINES,
  HEARTBEAT_MAX_CHECKS,
  HEARTBEAT_MAX_FINGERPRINTS,
  HEARTBEAT_MAX_ISSUES_PER_CHECK,
  HEARTBEAT_MAX_ISSUES_PER_ROUND,
  HEARTBEAT_MAX_SUMMARY_CHARS,
  HEARTBEAT_MAX_TITLE_CHARS,
  HEARTBEAT_RUN_WINDOW_MS,
  HEARTBEAT_STUCK_GRACE_MS,
  type HeartbeatCheckId,
  type HeartbeatChecklistStatus,
  type HeartbeatFingerprintRecord,
  type HeartbeatIssue
} from "./heartbeatTypes";

/** 本地日期键 YYYY-MM-DD（按宿主时区，与用户作息一致）。 */
export function localDayKey(ms: number): string {
  const date = new Date(ms);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 下一次本地 0 点：日上限用尽后的下一次可巡检时间。 */
export function startOfNextLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0).getTime();
}

export type HeartbeatChecklistRaw = {
  path: string;
  exists: boolean;
  text: string;
  tooLarge: boolean;
  unreadable: boolean;
};

function resolveCheckId(token: string): HeartbeatCheckId | null {
  const normalized = token.trim().toLowerCase();
  for (const id of HEARTBEAT_CHECK_IDS) {
    if (normalized === id) {
      return id;
    }
  }
  return HEARTBEAT_CHECK_ALIASES[token.trim()] ?? null;
}

/**
 * 解析清单：只认 5 个固定名称（或中文别名）。
 * 未识别的行进入 unsupported，供设置页提示；绝不猜测执行。
 */
export function parseHeartbeatChecklist(raw: HeartbeatChecklistRaw): HeartbeatChecklistStatus {
  const base: HeartbeatChecklistStatus = {
    path: raw.path,
    status: "ok",
    checks: [],
    unsupported: []
  };
  if (!raw.exists) {
    return { ...base, status: "missing" };
  }
  if (raw.tooLarge) {
    return { ...base, status: "invalid", reason: "TOO_LARGE" };
  }
  if (raw.unreadable) {
    return { ...base, status: "invalid", reason: "UNREADABLE" };
  }

  const lines = raw.text.split(/\r?\n/);
  if (lines.length > HEARTBEAT_MAX_CHECKLIST_LINES) {
    return { ...base, status: "invalid", reason: "TOO_MANY_LINES" };
  }

  const checks: HeartbeatCheckId[] = [];
  const unsupported: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (!trimmed.startsWith("-") && !trimmed.startsWith("*")) {
      unsupported.push(trimmed.slice(0, 40));
      continue;
    }
    const body = trimmed.slice(1).trim();
    const token = body.split(/\s+/)[0] ?? "";
    if (!token) {
      continue;
    }
    const resolved = resolveCheckId(token);
    if (!resolved) {
      unsupported.push(token.slice(0, 40));
      continue;
    }
    if (!checks.includes(resolved)) {
      checks.push(resolved);
    }
  }

  if (checks.length === 0) {
    return { ...base, status: "invalid", unsupported, reason: "NO_VALID_CHECKS" };
  }
  if (checks.length > HEARTBEAT_MAX_CHECKS) {
    return { ...base, status: "invalid", unsupported, reason: "TOO_MANY_CHECKS" };
  }
  return { ...base, status: "ok", checks, unsupported };
}

export type HeartbeatFacts = {
  nowMs: number;
  checks: readonly HeartbeatCheckId[];
  events: CalendarEvent[];
  jobs: ScheduleJob[];
  runs: SchedulerRunRecord[];
};

function clipTitle(title: string): string {
  const trimmed = (title || "").trim() || "未命名";
  return trimmed.length > HEARTBEAT_MAX_TITLE_CHARS
    ? `${trimmed.slice(0, HEARTBEAT_MAX_TITLE_CHARS - 1)}…`
    : trimmed;
}

function runStatusText(status: SchedulerRunRecord["status"]): string {
  switch (status) {
    case "failed":
      return "失败";
    case "timed_out":
      return "超时";
    case "paused_needs_user":
      return "需要你处理";
    default:
      return "异常";
  }
}

/**
 * 日程冲突：未来 24h 内两个进行中的日程时间重叠。
 * 全天事件不参与（否则任何全天事件都会和当天所有日程“冲突”，变成噪音）。
 */
function checkCalendarConflicts(nowMs: number, events: CalendarEvent[]): HeartbeatIssue[] {
  const windowEnd = nowMs + HEARTBEAT_EVENT_WINDOW_MS;
  const candidates = events
    .filter((event) => event.status === "planned"
      && !event.allDay
      && event.endAt > nowMs
      && event.startAt < windowEnd)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, HEARTBEAT_EVENT_SCAN_LIMIT);

  const issues: HeartbeatIssue[] = [];
  for (let outer = 0; outer < candidates.length && issues.length < HEARTBEAT_MAX_ISSUES_PER_CHECK; outer += 1) {
    for (let inner = outer + 1; inner < candidates.length && issues.length < HEARTBEAT_MAX_ISSUES_PER_CHECK; inner += 1) {
      const a = candidates[outer];
      const b = candidates[inner];
      if (a.startAt >= b.endAt || b.startAt >= a.endAt) {
        continue;
      }
      const [first, second] = a.id < b.id ? [a, b] : [b, a];
      issues.push({
        check: "calendar-conflict",
        fingerprint: `calendar-conflict:${first.id}+${second.id}`,
        text: `日程冲突：《${clipTitle(a.title)}》与《${clipTitle(b.title)}》`
      });
    }
  }
  return issues;
}

/**
 * 日程提醒未绑定：未来 24h 内、提醒时间还没到，但 reminderJobId 缺失或对应 job 不存在。
 * 提醒时间已过的日程不报：at job 成功后会自删，无法区分“已提醒”与“从未绑定”，
 * 报了就是假告警（本模块宁可漏报也不编造）。
 */
function checkReminderMissing(nowMs: number, events: CalendarEvent[], jobs: ScheduleJob[]): HeartbeatIssue[] {
  const windowEnd = nowMs + HEARTBEAT_EVENT_WINDOW_MS;
  const jobIds = new Set(jobs.map((job) => job.id));
  const issues: HeartbeatIssue[] = [];
  for (const event of events) {
    if (issues.length >= HEARTBEAT_MAX_ISSUES_PER_CHECK) {
      break;
    }
    if (event.status !== "planned" || event.allDay || event.startAt <= nowMs || event.startAt >= windowEnd) {
      continue;
    }
    if (event.remindMinutesBefore < 0) {
      continue;
    }
    const reminderAt = event.startAt - event.remindMinutesBefore * 60_000;
    if (reminderAt <= nowMs) {
      continue;
    }
    if (event.reminderJobId && jobIds.has(event.reminderJobId)) {
      continue;
    }
    issues.push({
      check: "calendar-reminder-missing",
      fingerprint: `reminder-missing:${event.id}`,
      text: `日程《${clipTitle(event.title)}》没有提醒`
    });
  }
  return issues;
}

function checkSchedulerFailed(nowMs: number, runs: SchedulerRunRecord[]): HeartbeatIssue[] {
  const windowStart = nowMs - HEARTBEAT_RUN_WINDOW_MS;
  const issues: HeartbeatIssue[] = [];
  for (const run of runs) {
    if (issues.length >= HEARTBEAT_MAX_ISSUES_PER_CHECK) {
      break;
    }
    if (run.jobId === HEARTBEAT_JOB_ID || typeof run.finishedAt !== "number") {
      continue;
    }
    if (run.finishedAt < windowStart || run.finishedAt > nowMs) {
      continue;
    }
    if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "paused_needs_user") {
      continue;
    }
    issues.push({
      check: "scheduler-failed",
      fingerprint: `scheduler-failed:${run.id}`,
      text: `任务《${clipTitle(run.jobName)}》${runStatusText(run.status)}`
    });
  }
  return issues;
}

/** 投递未送达：failed/expired 且入队时间在 24h 内。排除心跳自己的记录，避免自我循环。 */
function checkDeliveryUndelivered(nowMs: number, runs: SchedulerRunRecord[]): HeartbeatIssue[] {
  const windowStart = nowMs - HEARTBEAT_RUN_WINDOW_MS;
  const issues: HeartbeatIssue[] = [];
  for (const run of runs) {
    if (issues.length >= HEARTBEAT_MAX_ISSUES_PER_CHECK) {
      break;
    }
    if (run.jobId === HEARTBEAT_JOB_ID) {
      continue;
    }
    const delivery = run.delivery;
    if (delivery.state !== "failed" && delivery.state !== "expired") {
      continue;
    }
    if (delivery.enqueuedAt < windowStart || delivery.enqueuedAt > nowMs) {
      continue;
    }
    issues.push({
      check: "delivery-undelivered",
      fingerprint: `delivery-undelivered:${run.id}`,
      text: delivery.state === "expired"
        ? `《${clipTitle(run.jobName)}》通知已过期未送达`
        : `《${clipTitle(run.jobName)}》通知未送达`
    });
  }
  return issues;
}

function checkJobStuck(nowMs: number, jobs: ScheduleJob[]): HeartbeatIssue[] {
  const issues: HeartbeatIssue[] = [];
  for (const job of jobs) {
    if (issues.length >= HEARTBEAT_MAX_ISSUES_PER_CHECK) {
      break;
    }
    if (!job.enabled || job.kind !== "at" || typeof job.nextRunAtMs !== "number") {
      continue;
    }
    if (job.nextRunAtMs >= nowMs - HEARTBEAT_STUCK_GRACE_MS) {
      continue;
    }
    issues.push({
      check: "scheduler-job-stuck",
      fingerprint: `job-stuck:${job.id}`,
      text: `任务《${clipTitle(job.name)}》已过期未执行`
    });
  }
  return issues;
}

/** 按清单启用顺序执行检查；结果顺序稳定，便于单轮截断时不饥饿。 */
export function evaluateHeartbeatIssues(facts: HeartbeatFacts): HeartbeatIssue[] {
  const enabled = new Set(facts.checks);
  const issues: HeartbeatIssue[] = [];
  if (enabled.has("calendar-conflict")) {
    issues.push(...checkCalendarConflicts(facts.nowMs, facts.events));
  }
  if (enabled.has("calendar-reminder-missing")) {
    issues.push(...checkReminderMissing(facts.nowMs, facts.events, facts.jobs));
  }
  if (enabled.has("scheduler-failed")) {
    issues.push(...checkSchedulerFailed(facts.nowMs, facts.runs));
  }
  if (enabled.has("delivery-undelivered")) {
    issues.push(...checkDeliveryUndelivered(facts.nowMs, facts.runs));
  }
  if (enabled.has("scheduler-job-stuck")) {
    issues.push(...checkJobStuck(facts.nowMs, facts.jobs));
  }
  return issues;
}

/** 24h 去重：窗口内已提醒过的问题进入 suppressed，不重复打扰。 */
export function filterFreshIssues(
  issues: HeartbeatIssue[],
  records: HeartbeatFingerprintRecord[],
  nowMs: number
): { fresh: HeartbeatIssue[]; suppressed: number } {
  const notifiedAt = new Map(records.map((record) => [record.key, record.lastNotifiedAt]));
  const fresh: HeartbeatIssue[] = [];
  let suppressed = 0;
  for (const issue of issues) {
    const lastNotifiedAt = notifiedAt.get(issue.fingerprint);
    if (lastNotifiedAt === undefined) {
      fresh.push(issue);
      continue;
    }
    // 时钟回拨时 lastNotifiedAt > now，保守视为刚提醒过，不重复。
    if (nowMs - lastNotifiedAt < HEARTBEAT_DEDUPE_TTL_MS) {
      suppressed += 1;
      continue;
    }
    fresh.push(issue);
  }
  return { fresh, suppressed };
}

/** 单轮汇总文案：≤190 字，超出截断并保留省略号。 */
export function formatIssueSummary(issues: HeartbeatIssue[]): string {
  const selected = issues.slice(0, HEARTBEAT_MAX_ISSUES_PER_ROUND);
  const summary = `静默巡检：${selected.map((issue) => issue.text).join("；")}`;
  return summary.length > HEARTBEAT_MAX_SUMMARY_CHARS
    ? `${summary.slice(0, HEARTBEAT_MAX_SUMMARY_CHARS - 1)}…`
    : summary;
}

/** 清理过期 fingerprint，并保证上界 500（按最近提醒时间淘汰最旧）。 */
export function pruneFingerprints(
  records: HeartbeatFingerprintRecord[],
  nowMs: number
): HeartbeatFingerprintRecord[] {
  const kept = records.filter((record) => nowMs - record.lastNotifiedAt <= HEARTBEAT_DEDUPE_TTL_MS);
  if (kept.length <= HEARTBEAT_MAX_FINGERPRINTS) {
    return kept;
  }
  return kept
    .slice()
    .sort((a, b) => a.lastNotifiedAt - b.lastNotifiedAt)
    .slice(-HEARTBEAT_MAX_FINGERPRINTS);
}

/** 下一次自动巡检时间：日上限用尽则等次日 0 点；interval/cap 由 PRO-02 等级给出。 */
export function computeNextHeartbeatRunAt(
  lastRunAt: number | null,
  roundsToday: number,
  nowMs: number,
  intervalMs: number,
  dailyCap: number
): number | null {
  if (roundsToday >= dailyCap) {
    return startOfNextLocalDay(nowMs);
  }
  if (lastRunAt === null) {
    return nowMs;
  }
  return Math.max(nowMs, lastRunAt + intervalMs);
}
