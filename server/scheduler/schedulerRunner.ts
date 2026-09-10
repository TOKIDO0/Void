/**
 * P4b 调度器运行器（sidecar 进程内）：计时臂 + 隔离执行 + 熔断/重试落账。
 * 设计要点（S1 结论）：Node 进程不受 WebView-hide 节流影响，计时与执行都在 sidecar；
 * 前端仅做创建（L2 授 scope）、解锁 Key、台账展示。Key 只存内存，重启需前端回填。
 */

import { runAgentToolLoop } from "../../src/features/agent/loop/agentToolLoop";
import { getTool } from "../../src/features/agent/tools/toolRegistry";
import { appendToolAudit } from "../audit/toolAuditLog";
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
/** P0-2：随内存 Key 一并记录的 vault 引用（仅引用串，可审计、不含秘密）。 */
let modelKeyVaultRef: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = 0;
let schedulerStarted = false;
const pending: string[] = [];
const manualOnce = new Set<string>();
/** 手动触发预建的 run 记录：jobId → runId，执行侧复用，保证单记录归属。 */
const manualRecords = new Map<string, string>();
let draining = false;
/** P1 可取消：运行中 run 的 AbortController（runId → controller）。 */
const runningControllers = new Map<string, AbortController>();
/** runId → jobId 反查（取消与审计用）。 */
const runningJobByRun = new Map<string, string>();

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
    modelKeyVaultRef = null;
    return;
  }
  const provider = (config.provider ?? "").trim();
  const modelName = (config.modelName ?? "").trim();
  // P0-2 vault 链路：允许前端传 vault: 引用代替明文 apiKey；
  // sidecar 读不到 Stronghold，引用仅做审计标记，执行仍需当次内存 Key。
  const maybeVaultRef = (config as { modelVaultRef?: unknown }).modelVaultRef;
  const vaultRef = typeof maybeVaultRef === "string" && maybeVaultRef.trim().startsWith("vault:")
    ? maybeVaultRef.trim().slice(0, 160)
    : null;
  const apiKey = (config.apiKey ?? "").trim();
  if (!provider || !modelName || (!apiKey && !vaultRef)) {
    throw createScheduleError("INVALID_REQUEST", "unlock 需要 provider/modelName，以及 apiKey 或 modelVaultRef(vault:引用) 之一");
  }
  if (!apiKey && vaultRef) {
    // 仅引用无当次明文： sidecar 无法自行 resolve，要求前端先 resolve 再 unlock。
    throw createScheduleError("NEEDS_UNLOCK", "仅收到 vault 引用，sidecar 无法直读 Stronghold；请前端 resolve 后携带当次 Key 解锁（引用已记录备查）");
  }
  modelKeyVaultRef = vaultRef;
  modelKey = { ...config, provider, apiKey, modelName };
}

export function getSchedulerModelVaultRef(): string | null {
  return modelKeyVaultRef;
}

export function hasSchedulerModelKey(): boolean {
  return modelKey !== null;
}

export function schedulerRunningCount(): number {
  return running;
}

/**
 * C 条件通知：无异常巡检首行回 NO_NOTIFY → 成功但免投递（台账仍可见）。
 * 判定只看首行精确匹配，避免正文偶发 boujie 误杀。
 */
export function shouldSkipNotify(content: string): boolean {
  const firstLine = (content ?? "").split(/\r?\n/, 1)[0]?.trim();
  return firstLine === "NO_NOTIFY";
}

function stripNotifyMarker(summary: string): string {
  const lines = summary.split(/\r?\n/);
  if (lines.length > 1 && lines[0]?.trim() === "NO_NOTIFY") {
    return lines.slice(1).join("\n").trim();
  }
  return summary;
}

/**
 * P4 补丁（早报）：创建时 L2 确认前移 —— scope 内静态 L2 放行，动态抬升照样拒绝。
 * 原理：confirmer 被调用 ⟺ 需要确认 ⟺ 静态 L2+ 或动态抬升；静态 L0/L1 本来 auto 不会到这。
 * 因此：静态风险恰为 L2 且在 scope 内 → 放行；其余（含动态抬升的 L0 工具、L3、scope 外）→ 拒绝。
 */
export function shouldPreApprove(toolName: string, scope: readonly string[]): boolean {
  if (!scope.includes(toolName)) {
    return false;
  }
  return getTool(toolName)?.riskLevel === "L2";
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
  // A2 启动播报：过期 missed 落 run 记录（未投递），前端投递轮询即播报"错过摘要"。
  for (const id of sweep.missed) {
    const job = jobs.find((item) => item.id === id);
    schedulerStore.appendRun({
      jobId: id,
      jobName: job?.name ?? "",
      startedAt: now,
      finishedAt: now,
      status: "missed",
      summary: "过期未执行（应用未运行），已停用留查。",
      delivered: false
    });
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
  // P1：停机时中断运行中任务，避免孤儿执行。
  for (const controller of runningControllers.values()) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }
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
  appendToolAudit({
    at: Date.now(),
    module: "scheduler",
    action: `scheduler.manualRun:${job.id}`,
    decision: "ask-allow",
    reason: `手动触发（run ${record.id}）`
  });
  return record;
}

/**
 * P1 可取消：取消运行中或排队中的 run。
 * - 运行中：abort 对应 controller，执行侧以 timed_out 落账（取消语义，summary 注记用户取消）；
 * - 排队中：从 pending 队列摘除并直接落 failed（用户取消）；
 * - 已终态：返回 { cancelled: false }。
 */
export function cancelSchedulerRun(runId: string): { cancelled: boolean; runId: string; status?: string } {
  const id = runId.trim();
  if (!id) {
    throw createScheduleError("INVALID_REQUEST", "runId 不能为空");
  }
  const controller = runningControllers.get(id);
  if (controller) {
    controller.abort();
    appendToolAudit({
      at: Date.now(),
      module: "scheduler",
      action: `scheduler.cancel:${id}`,
      decision: "ask-allow",
      reason: "用户取消运行中任务"
    });
    return { cancelled: true, runId: id, status: "cancelling" };
  }
  const stored = schedulerStore.listRuns(MAX_RUN_RECORDS).find((item) => item.id === id);
  if (stored && stored.status === "running") {
    // 已出队但 controller 尚未注册的极窄窗口：直接落账为取消。
    schedulerStore.updateRun({
      ...stored,
      status: "failed",
      finishedAt: Date.now(),
      summary: "用户取消（排队中未执行）",
      delivered: false
    });
    appendToolAudit({
      at: Date.now(),
      module: "scheduler",
      action: `scheduler.cancel:${id}`,
      decision: "ask-allow",
      reason: "用户取消排队中任务"
    });
    return { cancelled: true, runId: id, status: "failed" };
  }
  return { cancelled: false, runId: id, status: stored?.status };
}

/** P1 可取消：按 job 取消其运行中 run（无运行中则摘除排队），返回实际取消数。 */
export function cancelSchedulerJobRuns(jobId: string): { cancelled: number; jobId: string } {
  const id = jobId.trim();
  if (!id) {
    throw createScheduleError("INVALID_REQUEST", "jobId 不能为空");
  }
  let cancelled = 0;
  for (const [runId, jid] of [...runningJobByRun]) {
    if (jid === id && runningControllers.has(runId)) {
      cancelSchedulerRun(runId);
      cancelled += 1;
    }
  }
  const pendingIndex = pending.indexOf(id);
  if (pendingIndex >= 0) {
    pending.splice(pendingIndex, 1);
    cancelled += 1;
  }
  return { cancelled, jobId: id };
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
  runningControllers.set(record.id, controller);
  runningJobByRun.set(record.id, job.id);
  let confirmationBlocks = 0;
  try {
    const result = await runAgentToolLoop({
      messages: [{ role: "user", content: job.prompt }],
      modelConfig: { ...key },
      allowedToolNames: [...job.allowedToolNames],
      // 无人值守 fail-closed + 创建时授 scope：scope 内静态 L2 放行，其余自动拒绝并计数。
      requestConfirmation: async (request) => {
        if (shouldPreApprove(request.toolName, job.allowedToolNames)) {
          return {
            requestId: request.id,
            approved: true,
            decidedAt: Date.now(),
            note: "创建时 L2 已授 scope，静态风险内放行"
          };
        }
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
    } else if (shouldSkipNotify(result.content)) {
      // C 条件通知：无异常免打扰 —— 成功落账但直接记已投递，不进通知。
      const clean = stripNotifyMarker(result.content).slice(0, 500);
      finishRun(job, record, "succeeded", clean || "巡检无异常（免打扰）。");
      markRunDelivered(record.id);
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
    runningControllers.delete(record.id);
    runningJobByRun.delete(record.id);
  }
}

function markRunDelivered(runId: string): void {
  const stored = schedulerStore.listRuns(MAX_RUN_RECORDS).find((item) => item.id === runId);
  if (stored) {
    schedulerStore.updateRun({ ...stored, delivered: true });
  }
}

function finishRun(job: ScheduleJob, record: SchedulerRunRecord, status: SchedulerRunStatus, summary: string): void {
  const now = Date.now();
  const fresh = schedulerStore.getJob(job.id);
  // D 失败升级：at 失败即停用须处理；every 连败第 3 次强标记（transition 那次，不刷屏）。
  let finalSummary = summary;
  if (status === "failed" || status === "timed_out") {
    const streakBefore = fresh?.failStreak ?? 0;
    const atWillRetry = !!fresh
      && fresh.kind === "at"
      && status === "failed"
      && streakBefore + 1 <= MAX_AT_RETRIES
      && isTransientMessage(summary);
    if (!fresh || (fresh.kind === "at" && !atWillRetry)) {
      finalSummary = `【已停用，需处理】${summary}`;
    } else if (fresh.kind === "every" && streakBefore === 2) {
      finalSummary = `【连续失败3次，请检查任务配置】${summary}`;
    }
  }
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
  schedulerStore.updateRun({ ...record, status, finishedAt: now, summary: finalSummary, delivered: false });
  // P1 可审计：每次落账记一条（终态可查，不含 prompt/正文，只记结论）。
  appendToolAudit({
    at: now,
    module: "scheduler",
    action: `scheduler.run:${job.id}`,
    decision: status === "succeeded" ? "allow" : "error",
    reason: `${status}（run ${record.id}）`,
    errorCode: status === "succeeded" ? undefined : status.toUpperCase()
  });
  notifySchedulerChanged();
}

export const SCHEDULER_RUNNER_LIMITS = {
  maxConcurrentRuns: MAX_CONCURRENT_RUNS,
  maxTimerDelayMs: MAX_TIMER_DELAY_MS,
  atGraceMs: AT_GRACE_MS
} as const;
