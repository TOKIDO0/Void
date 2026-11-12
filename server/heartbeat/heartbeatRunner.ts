/**
 * PRO-05 静默巡检运行器（sidecar 进程内）。
 *
 * 职责只有四件事：计时、日上限、收集 sidecar 可读事实、把结构化问题写进 PRO-06 队列。
 * 不做安静时段判断（由 schedulerStore.claimPendingDelivery 消费 PRO-04）、不发通知、
 * 不调 LLM。所有「是否该打扰」的最终裁决仍在 PRO-06 + PRO-04。
 */

import { calendarStore } from "../calendar/calendarStore";
import { MAX_RUN_RECORDS } from "../scheduler/schedulerEngine";
import { schedulerStore } from "../scheduler/schedulerStore";
import {
  computeNextHeartbeatRunAt,
  evaluateHeartbeatIssues,
  filterFreshIssues,
  formatIssueSummary,
  localDayKey,
  parseHeartbeatChecklist,
  pruneFingerprints
} from "./heartbeatPolicy";
import { heartbeatStore } from "./heartbeatStore";
import {
  HEARTBEAT_EVENT_WINDOW_MS,
  HEARTBEAT_JOB_ID,
  HEARTBEAT_JOB_NAME,
  HEARTBEAT_MAX_ISSUES_PER_ROUND,
  HEARTBEAT_TICK_MS,
  type HeartbeatRoundResult,
  type HeartbeatSkipReason,
  type HeartbeatState,
  type HeartbeatStatus
} from "./heartbeatTypes";
import { resolveProactivityBudget, type ProactivityBudget } from "../proactivity/proactivityLevelPolicy";
import { proactivityLevelStore } from "../proactivity/proactivityLevelStore";

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function skipped(nowMs: number, reason: HeartbeatSkipReason): HeartbeatRoundResult {
  return {
    at: nowMs,
    outcome: "SKIPPED",
    skippedReason: reason,
    issuesFound: 0,
    notified: 0,
    suppressed: 0
  };
}

/** PRO-02：当前等级允许的代理主动预算；null = 克制档，主动内容停止生成。 */
function currentBudget(): ProactivityBudget | null {
  const { level } = proactivityLevelStore.getLevel();
  return resolveProactivityBudget(level);
}

function collectFacts(nowMs: number): { events: ReturnType<typeof calendarStore.listEvents>; jobs: ReturnType<typeof schedulerStore.listJobs>; runs: ReturnType<typeof schedulerStore.listRuns> } {
  return {
    events: calendarStore.listEvents(nowMs, nowMs + HEARTBEAT_EVENT_WINDOW_MS),
    jobs: schedulerStore.listJobs(),
    runs: schedulerStore.listRuns(MAX_RUN_RECORDS)
  };
}

/** 落账：自动轮推进游标与日计数；手动轮只更新结果与去重指纹，不打乱节奏。 */
function finishRound(
  state: HeartbeatState,
  result: HeartbeatRoundResult,
  options: { nowMs: number; manual: boolean }
): HeartbeatRoundResult {
  state.lastResult = result;
  if (!options.manual) {
    const dayKey = localDayKey(options.nowMs);
    state.roundsToday = (state.lastRunDayKey === dayKey ? state.roundsToday : 0) + 1;
    state.lastRunDayKey = dayKey;
    state.lastRunAt = options.nowMs;
  }
  heartbeatStore.saveState(state);
  return result;
}

/**
 * 执行一轮巡检。同步实现：所有事实都来自本地 JSON，便于 smoke 注入固定时间。
 * 手动轮（UI「立即巡检一次」）仍走去重与同一投递闸门，不绕过安静时段。
 */
export function runHeartbeatRound(options: { manual?: boolean; nowMs?: number } = {}): HeartbeatRoundResult {
  const nowMs = options.nowMs ?? Date.now();
  const manual = options.manual === true;

  const { config } = heartbeatStore.readConfig();
  if (!config.enabled) {
    return skipped(nowMs, "DISABLED");
  }

  // PRO-02：等级是上限。克制档直接停止生成，不改任何投递状态。
  const budget = currentBudget();
  if (!budget) {
    return skipped(nowMs, "LEVEL_RESTRAINED");
  }

  const checklist = parseHeartbeatChecklist(heartbeatStore.readChecklistFile());
  if (checklist.status === "missing") {
    return skipped(nowMs, "NO_CHECKLIST");
  }
  if (checklist.status !== "ok") {
    return skipped(nowMs, "INVALID_CHECKLIST");
  }

  const state = heartbeatStore.loadState();
  const dayKey = localDayKey(nowMs);
  const roundsToday = state.lastRunDayKey === dayKey ? state.roundsToday : 0;
  if (!manual && roundsToday >= budget.heartbeatDailyCap) {
    return skipped(nowMs, "DAILY_CAP");
  }

  state.fingerprints = pruneFingerprints(state.fingerprints, nowMs);

  // 状态文件刚被隔离重建：宁可少打扰一轮，也不在丢失去重记录时重复轰炸。
  if (heartbeatStore.getStateStatus() === "corrupt") {
    return finishRound(state, {
      at: nowMs,
      outcome: "SUPPRESSED_STATE_CORRUPT",
      issuesFound: 0,
      notified: 0,
      suppressed: 0
    }, { nowMs, manual });
  }

  const facts = collectFacts(nowMs);
  const issues = evaluateHeartbeatIssues({
    nowMs,
    checks: checklist.checks,
    events: facts.events,
    jobs: facts.jobs,
    runs: facts.runs
  });
  const { fresh, suppressed } = filterFreshIssues(issues, state.fingerprints, nowMs);

  if (fresh.length === 0) {
    return finishRound(state, {
      at: nowMs,
      outcome: issues.length > 0 ? "SUPPRESSED_DUPLICATE" : "NO_ISSUES",
      issuesFound: issues.length,
      notified: 0,
      suppressed
    }, { nowMs, manual });
  }

  const selected = fresh.slice(0, HEARTBEAT_MAX_ISSUES_PER_ROUND);
  const summary = formatIssueSummary(selected);

  let errorCode: string | undefined;
  try {
    const record = schedulerStore.appendRun({
      jobId: HEARTBEAT_JOB_ID,
      jobName: HEARTBEAT_JOB_NAME,
      startedAt: nowMs,
      finishedAt: nowMs,
      status: "succeeded",
      summary,
      origin: "agent",
      // PRO-01：代理主动永不播报；这里显式写 false，便于台账排查。
      speakOnDeliver: false,
      delivery: { state: "pending", attempts: 0, enqueuedAt: nowMs }
    });
    // appendRun 在队列满时会把记录降级为 failed/QUEUE_FULL：如实上报，不假成功。
    if (record.delivery.state !== "pending") {
      errorCode = record.delivery.errorCode ?? "ENQUEUE_REJECTED";
    }
  } catch (error) {
    errorCode = error instanceof Error ? error.message.slice(0, 40) : "ENQUEUE_FAILED";
  }

  if (errorCode) {
    // 不记 fingerprint：下一轮仍会重新发现并重试入队。
    return finishRound(state, {
      at: nowMs,
      outcome: "ENQUEUE_FAILED",
      issuesFound: issues.length,
      notified: 0,
      suppressed,
      summary,
      errorCode
    }, { nowMs, manual });
  }

  for (const issue of selected) {
    const existing = state.fingerprints.find((record) => record.key === issue.fingerprint);
    if (existing) {
      existing.lastNotifiedAt = nowMs;
      existing.lastCheck = issue.text;
    } else {
      state.fingerprints.push({
        key: issue.fingerprint,
        firstSeenAt: nowMs,
        lastNotifiedAt: nowMs,
        lastCheck: issue.text
      });
    }
  }
  state.fingerprints = pruneFingerprints(state.fingerprints, nowMs);

  return finishRound(state, {
    at: nowMs,
    outcome: "NOTIFIED",
    issuesFound: issues.length,
    notified: selected.length,
    suppressed,
    summary
  }, { nowMs, manual });
}

/** 只读状态：设置页与排查共用的唯一视图。 */
export function getHeartbeatStatus(nowMs = Date.now()): HeartbeatStatus {
  const { config, status: configStatus } = heartbeatStore.readConfig();
  const checklist = parseHeartbeatChecklist(heartbeatStore.readChecklistFile());
  const state = heartbeatStore.loadState();
  const dayKey = localDayKey(nowMs);
  const roundsToday = state.lastRunDayKey === dayKey ? state.roundsToday : 0;
  const { level } = proactivityLevelStore.getLevel();
  const budget = resolveProactivityBudget(level);

  return {
    enabled: config.enabled,
    configStatus,
    checklist,
    stateStatus: heartbeatStore.getStateStatus(),
    level,
    levelRestrained: budget === null,
    lastRunAt: state.lastRunAt,
    nextRunAt: config.enabled && checklist.status === "ok" && budget
      ? computeNextHeartbeatRunAt(
        state.lastRunAt,
        roundsToday,
        nowMs,
        budget.heartbeatIntervalMs,
        budget.heartbeatDailyCap
      )
      : null,
    roundsToday,
    dailyCap: budget?.heartbeatDailyCap ?? 0,
    lastResult: state.lastResult,
    serverNow: nowMs
  };
}

/** 保存开关；开启且清单缺失时由 store 写入一次性模板。 */
export function setHeartbeatEnabled(
  enabled: boolean,
  nowMs = Date.now()
): { status: HeartbeatStatus; createdChecklist: boolean } {
  const { createdChecklist } = heartbeatStore.setEnabled(enabled);
  return { status: getHeartbeatStatus(nowMs), createdChecklist };
}

function armHeartbeatTick(delayMs: number): void {
  if (!started) {
    return;
  }
  timer = setTimeout(() => {
    timer = null;
    try {
      runDueRound();
    } catch (error) {
      console.error("[void-heartbeat] 巡检 tick 失败", error);
    }
    armHeartbeatTick(HEARTBEAT_TICK_MS);
  }, delayMs);
  // 不因为这个计时器阻止进程退出；sidecar 生命周期由 Tauri 管理。
  (timer as { unref?: () => void }).unref?.();
}

/**
 * 到期判断（可单测）：不做补跑风暴。
 * 启动时若已过期最多立即跑一轮；时间回拨（now < lastRunAt）也按“到期”处理一次，避免永远不跑。
 */
export function shouldRunHeartbeatNow(nowMs = Date.now()): boolean {
  const { config } = heartbeatStore.readConfig();
  if (!config.enabled) {
    return false;
  }
  const budget = currentBudget();
  if (!budget) {
    return false;
  }
  const checklist = parseHeartbeatChecklist(heartbeatStore.readChecklistFile());
  if (checklist.status !== "ok") {
    return false;
  }
  const state = heartbeatStore.loadState();
  const dayKey = localDayKey(nowMs);
  const roundsToday = state.lastRunDayKey === dayKey ? state.roundsToday : 0;
  if (roundsToday >= budget.heartbeatDailyCap) {
    return false;
  }
  if (state.lastRunAt === null) {
    return true;
  }
  if (nowMs < state.lastRunAt) {
    return true;
  }
  return nowMs - state.lastRunAt >= budget.heartbeatIntervalMs;
}

function runDueRound(): void {
  const nowMs = Date.now();
  if (!shouldRunHeartbeatNow(nowMs)) {
    return;
  }
  runHeartbeatRound({ nowMs });
}

export function startHeartbeat(): void {
  if (started) {
    return;
  }
  started = true;
  armHeartbeatTick(0);
}

export function stopHeartbeat(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
