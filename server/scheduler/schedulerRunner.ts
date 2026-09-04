/**
 * P4b 调度器运行器（sidecar 进程内）：计时臂 + 隔离执行 + 熔断/重试落账。
 * 设计要点（S1 结论）：Node 进程不受 WebView-hide 节流影响，计时与执行都在 sidecar；
 * 前端仅做创建（L2 授 scope）、解锁 Key、台账展示。Key 只存内存，重启需前端回填。
 */

import { runAgentToolLoop } from "../../src/features/agent/loop/agentToolLoop";
import type { ModelConfig } from "../../src/features/settings/modelConfig";
import {
  AT_GRACE_MS,
  MAX_RUN_RECORDS,
  MAX_TIMER_DELAY_MS,
  computeNextRunAtMs,
  applyStartupSweep,
  settleRun
} from "./schedulerEngine";
import { schedulerStore } from "./schedulerStore";
import {
  createScheduleError,
  type ScheduleJob,
  type SchedulerRunRecord,
  type SchedulerRunStatus
} from "./schedulerTypes";

export const MAX_CONCURRENT_RUNS = 2;
const RETRY_BACKOFFS_MS = [30_000, 120_000, 600_000];
const MAX_AT_RETRIES = 3;
const TRANSIENT_PATTERN = /rate.?limit|overloaded|timeout|timed out|network|econn|eai_again|socket|429|502|503|504/i;

let modelKey: ModelConfig | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let schedulerStarted = false;
const pending: string[] = [];
const manualOnce = new Set<string>();
/** 手动触发预建的 run 记录：jobId → runId，执行侧复用，保证单记录归属。 */
const manualRecords = new Map<string, string>();
let draining = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMessage(message: string): boolean {
  return TRANSIENT_PATTERN.test(message);
}

/** 前端回填模型 Key（仅内存持有，绝不落盘；响应不回显）。 */
export function setSchedulerModelKey(config: ModelConfig | null): void {
  if (config === null) {
    modelKey = null;
    return;
  }
  const provider = (config.provider ?? "").trim();
  const apiKey = (config.apiKey ?? "").trim();
  const modelName = (config.modelName ?? "").trim();
  if (!provider || !apiKey || !modelName) {
    throw createScheduleError("INVALID_REQUEST", "unlock 需要 provider/apiKey/modelName");
  }
  modelKey = { ...config, provider, apiKey, modelName };
}

export function hasSchedulerModelKey(): boolean {
  return modelKey !== null;
}

export function schedulerRunningCount(): number {
  return running;
}

export function startScheduler(): { dueNow: string[]; missed: string[] } {
  schedulerStarted = true;
  const now = Date.now();
  const jobs = schedulerStore.listJobs();
  const sweep = applyStartupSweep(jobs, now);
  for (const job of jobs) {
    schedulerStore.updateJob(job);
  }
  for (const id of sweep.dueNow) {
    enqueue(id);
  }
  armTimer();
  return sweep;
}

export function stopScheduler(): void {
  schedulerStarted = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending.length = 0;
}

/** CRUD 后重臂计时器。 */
export function notifySchedulerChanged(): void {
  if (schedulerStarted) {
    armTimer();
  }
}

/** 手动触发一次（显式用户动作：停用任务也可跑；202 返回 runId，不等完成）。 */
export function requestManualRun(id: string): SchedulerRunRecord {
  const job = schedulerStore.getJob(id);
  if (!job) {
    throw createScheduleError("NOT_FOUND", `任务不存在：${id}`);
  }
  const now = Date.now();
  const record = schedulerStore.appendRun({
    jobId: job.id,
    jobName: job.name,
    startedAt: now,
    status: "running",
    delivered: false
  });
  manualOnce.add(id);
  manualRecords.set(id, record.id);
  enqueue(id);
  return record;
}

function armTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!schedulerStarted) {
    return;
  }
  const now = Date.now();
  let nearest: number | undefined;
  for (const job of schedulerStore.listJobs()) {
    if (!job.enabled || job.nextRunAtMs === undefined) {
      continue;
    }
    if (nearest === undefined || job.nextRunAtMs < nearest) {
      nearest = job.nextRunAtMs;
    }
  }
  if (nearest === undefined) {
    return;
  }
  const delay = Math.min(Math.max(nearest - now, 0), MAX_TIMER_DELAY_MS);
  timer = setTimeout(onTimerFired, delay);
}

function onTimerFired(): void {
  timer = null;
  if (!schedulerStarted) {
    return;
  }
  const now = Date.now();
  const due = schedulerStore.listJobs().filter(
    (job) => job.enabled && job.nextRunAtMs !== undefined && (job.nextRunAtMs as number) <= now
  );
  for (const job of due) {
    if (job.kind === "every") {
      // 先推进下次，避免执行期间重复触发。
      job.nextRunAtMs = computeNextRunAtMs(job, job.createdAt, now + 1000);
    } else {
      job.nextRunAtMs = undefined;
    }
    schedulerStore.updateJob(job);
    enqueue(job.id);
  }
  armTimer();
}

function enqueue(id: string): void {
  if (!pending.includes(id)) {
    pending.push(id);
  }
  void drain();
}

async function drain(): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    while (pending.length > 0) {
      while (running >= MAX_CONCURRENT_RUNS) {
        await sleep(1000);
      }
      const id = pending.shift();
      if (!id) {
        break;
      }
      running += 1;
      void runJobById(id).finally(() => {
        running -= 1;
      });
    }
  } finally {
    draining = false;
  }
}

async function runJobById(id: string): Promise<void> {
  const job = schedulerStore.getJob(id);
  const manual = manualOnce.has(id);
  const reuseRunId = manual ? manualRecords.get(id) : undefined;
  manualOnce.delete(id);
  manualRecords.delete(id);
  if (!job || (!job.enabled && !manual)) {
    return;
  }
  const key = modelKey;
  const now = Date.now();
  // 单记录归属：手动预建优先复用，否则新建；各分支只更新这一条。
  let record = reuseRunId
    ? schedulerStore.listRuns(MAX_RUN_RECORDS).find((item) => item.id === reuseRunId)
    : undefined;
  if (!record) {
    record = schedulerStore.appendRun({
      jobId: job.id,
      jobName: job.name,
      startedAt: now,
      status: "running",
      delivered: false
    });
  }
  if (!key) {
    schedulerStore.updateRun({
      ...record,
      status: "paused_needs_user",
      finishedAt: Date.now(),
      summary: "sidecar 未解锁模型 Key（重启后需前端回填），任务未执行。"
    });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.timeoutMs);
  let confirmationBlocks = 0;
  try {
    const result = await runAgentToolLoop({
      messages: [{ role: "user", content: job.prompt }],
      modelConfig: { ...key },
      allowedToolNames: [...job.allowedToolNames],
      // 无人值守 fail-closed：任何确认请求自动拒绝并计数，终态记 paused_needs_user。
      requestConfirmation: async (request) => {
        confirmationBlocks += 1;
        return {
          requestId: request.id,
          approved: false,
          decidedAt: Date.now(),
          note: "无人值守自动拒绝：需用户在台账中处理"
        };
      },
      onProgress: () => {},
      signal: controller.signal,
      maxRounds: 8,
      maxToolInvocations: 12
    });
    if (controller.signal.aborted) {
      finishRun(job, record, "timed_out", `单次执行超 ${Math.round(job.timeoutMs / 60000)} 分钟上限`);
    } else if (confirmationBlocks > 0) {
      finishRun(job, record, "paused_needs_user", `${result.content.slice(0, 300)}（另有 ${confirmationBlocks} 项需确认被自动拒绝）`);
    } else if (result.outcome === "failed") {
      finishRun(job, record, "failed", result.content.slice(0, 500));
    } else {
      finishRun(job, record, "succeeded", result.content.slice(0, 500));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      finishRun(job, record, "timed_out", `单次执行超 ${Math.round(job.timeoutMs / 60000)} 分钟上限`);
    } else {
      finishRun(job, record, "failed", message.slice(0, 500));
    }
  } finally {
    clearTimeout(timeout);
  }
}

function finishRun(job: ScheduleJob, record: SchedulerRunRecord, status: SchedulerRunStatus, summary: string): void {
  const now = Date.now();
  const fresh = schedulerStore.getJob(job.id);
  if (fresh) {
    const settled = settleRun(fresh, fresh.createdAt, status, now);
    // at 瞬态失败 3 次内退避重试一次（不补跑风暴，由计时器单点触发）。
    if (
      !settled.deleteJob
      && status === "failed"
      && fresh.kind === "at"
      && fresh.failStreak <= MAX_AT_RETRIES
      && isTransientMessage(summary)
    ) {
      fresh.enabled = true;
      fresh.nextRunAtMs = now + RETRY_BACKOFFS_MS[Math.min(fresh.failStreak - 1, RETRY_BACKOFFS_MS.length - 1)];
      schedulerStore.updateJob(fresh);
    } else if (settled.deleteJob) {
      schedulerStore.removeJob(fresh.id);
    } else {
      schedulerStore.updateJob(fresh);
    }
  }
  schedulerStore.updateRun({ ...record, status, finishedAt: now, summary, delivered: false });
  notifySchedulerChanged();
}

export const SCHEDULER_RUNNER_LIMITS = {
  maxConcurrentRuns: MAX_CONCURRENT_RUNS,
  maxTimerDelayMs: MAX_TIMER_DELAY_MS,
  atGraceMs: AT_GRACE_MS
} as const;
