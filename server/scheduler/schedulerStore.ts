/**
 * P4 调度器存储：运行时根 scheduler/jobs.json，原子写（tmp + rename），重启恢复。
 * 仅 sidecar 进程内使用；前端经 /void-scheduler/* 端点访问，不直读文件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import { MAX_JOBS, MAX_RUN_RECORDS, nextJobId, nextRunId } from "./schedulerEngine";
import {
  createScheduleError,
  type DeliveryState,
  type RunDelivery,
  type ScheduleJob,
  type SchedulerRunRecord,
  type SchedulerState
} from "./schedulerTypes";

/** 投递边界（PRO-06）：全部有上界，禁止无界增长。 */
export const MAX_PENDING_DELIVERY = 50;
export const MAX_DELIVERY_BATCH = 10;
export const DELIVERY_LEASE_MS = 90_000;
export const DELIVERY_EXPIRE_MS = 60 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 5;

const DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set([
  "pending",
  "delivering",
  "sent",
  "failed",
  "expired",
  "suppressed"
]);

function schedulerDir(): string {
  const fromEnv = process.env.VOID_SCHEDULER_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "scheduler");
}

function jobsFile(): string {
  return join(schedulerDir(), "jobs.json");
}

function emptyState(): SchedulerState {
  return { version: 1, jobs: [], runs: [] };
}

/**
 * 投递记录迁移与校验。
 * 旧格式只有 `delivered: boolean`：true → sent，false/缺失 → pending（会重新投递一次，可接受）。
 */
function sanitizeDelivery(run: Record<string, unknown>): RunDelivery {
  const raw = run.delivery;
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const state = typeof record.state === "string" && DELIVERY_STATES.has(record.state as DeliveryState)
      ? (record.state as DeliveryState)
      : "pending";
    return {
      state,
      attempts: typeof record.attempts === "number" && record.attempts >= 0 ? Math.floor(record.attempts) : 0,
      enqueuedAt: typeof record.enqueuedAt === "number"
        ? record.enqueuedAt
        : (typeof run.startedAt === "number" ? run.startedAt : Date.now()),
      lastAttemptAt: typeof record.lastAttemptAt === "number" ? record.lastAttemptAt : undefined,
      leaseUntil: typeof record.leaseUntil === "number" ? record.leaseUntil : undefined,
      errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined
    };
  }
  const legacyDelivered = run.delivered === true;
  return {
    state: legacyDelivered ? "sent" : "pending",
    attempts: legacyDelivered ? 1 : 0,
    enqueuedAt: typeof run.startedAt === "number" ? run.startedAt : Date.now()
  };
}

/** 只接受 vault: 引用；其余（含明文）一律丢弃且不落盘。 */function readJobVaultRef(job: Record<string, unknown>): string | undefined {
  const candidate = job.modelVaultRef;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("vault:") || trimmed.length > 160) return undefined;
  return trimmed;
}

function sanitizeState(raw: unknown): SchedulerState {
  const state = emptyState();
  if (typeof raw !== "object" || raw === null) {
    return state;
  }
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.jobs)) {
    for (const item of record.jobs.slice(0, MAX_JOBS)) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const job = item as Record<string, unknown>;
      if (typeof job.id !== "string" || typeof job.prompt !== "string") {
        continue;
      }
      state.jobs.push({
        id: job.id,
        name: typeof job.name === "string" ? job.name : job.prompt.slice(0, 40),
        prompt: job.prompt,
        kind: job.kind === "every" ? "every" : job.kind === "cron" ? "cron" : "at",
        atMs: typeof job.atMs === "number" ? job.atMs : undefined,
        everyMs: typeof job.everyMs === "number" ? job.everyMs : undefined,
        expr: typeof job.expr === "string" ? job.expr : undefined,
        tz: typeof job.tz === "string" ? job.tz : undefined,
        anchorMs: typeof job.anchorMs === "number" ? job.anchorMs : undefined,
        allowedToolNames: Array.isArray(job.allowedToolNames)
          ? job.allowedToolNames.filter((x): x is string => typeof x === "string")
          : [],
        timeoutMs: typeof job.timeoutMs === "number" ? job.timeoutMs : 600_000,
        speakOnDeliver: job.speakOnDeliver === true,
        enabled: job.enabled !== false,
        createdAt: typeof job.createdAt === "number" ? job.createdAt : Date.now(),
        // P0-2：jobs.json 永不存明文 Key。历史残留 apiKey/key/secret/token 字段直接丢弃；
        // vault 引用（vault:<alias>）才允许持久化。
        modelVaultRef: readJobVaultRef(job),
        nextRunAtMs: typeof job.nextRunAtMs === "number" ? job.nextRunAtMs : undefined,
        lastRunAtMs: typeof job.lastRunAtMs === "number" ? job.lastRunAtMs : undefined,
        lastStatus: typeof job.lastStatus === "string"
          ? (job.lastStatus as ScheduleJob["lastStatus"])
          : undefined,
        missedCount: typeof job.missedCount === "number" ? job.missedCount : 0,
        failStreak: typeof job.failStreak === "number" ? job.failStreak : 0
      });
    }
  }
  if (Array.isArray(record.runs)) {
    for (const item of record.runs.slice(0, MAX_RUN_RECORDS)) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const run = item as Record<string, unknown>;
      if (typeof run.id !== "string" || typeof run.jobId !== "string") {
        continue;
      }
      state.runs.push({
        id: run.id,
        jobId: run.jobId,
        jobName: typeof run.jobName === "string" ? run.jobName : "",
        startedAt: typeof run.startedAt === "number" ? run.startedAt : Date.now(),
        finishedAt: typeof run.finishedAt === "number" ? run.finishedAt : undefined,
        status: run.status === "running" || run.status === "succeeded" || run.status === "failed"
          || run.status === "timed_out" || run.status === "paused_needs_user" || run.status === "missed"
          ? run.status
          : "failed",
        summary: typeof run.summary === "string" ? run.summary : undefined,
        delivery: sanitizeDelivery(run)
      });
    }
  }
  return state;
}

/** 写入前剥离任何明文秘密字段；仅保留合法 vault: 引用。 */
function stripJobSecrets<T extends Record<string, unknown>>(job: T): T {
  const cleaned = { ...job } as Record<string, unknown>;
  for (const field of ["apiKey", "key", "secret", "token", "api_secret", "accessKey"]) {
    if (field in cleaned) delete cleaned[field];
  }
  const ref = cleaned.modelVaultRef;
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (!trimmed.startsWith("vault:") || trimmed.length > 160) {
      delete cleaned.modelVaultRef;
    } else {
      cleaned.modelVaultRef = trimmed;
    }
  }
  return cleaned as T;
}

class SchedulerStore {
  private state: SchedulerState | null = null;

  private ensureLoaded(): SchedulerState {
    if (this.state) {
      return this.state;
    }
    try {
      mkdirSync(schedulerDir(), { recursive: true });
      const file = jobsFile();
      if (!existsSync(file)) {
        this.state = emptyState();
        return this.state;
      }
      this.state = sanitizeState(JSON.parse(readFileSync(file, "utf8")));
      return this.state;
    } catch {
      this.state = emptyState();
      return this.state;
    }
  }

  private flush(): void {
    const state = this.ensureLoaded();
    state.runs = state.runs.slice(-MAX_RUN_RECORDS);
    const file = jobsFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
  }

  listJobs(): ScheduleJob[] {
    return this.ensureLoaded().jobs.map((job) => ({ ...job, allowedToolNames: [...job.allowedToolNames] }));
  }

  getJob(id: string): ScheduleJob | null {
    const found = this.ensureLoaded().jobs.find((job) => job.id === id);
    return found ? { ...found, allowedToolNames: [...found.allowedToolNames] } : null;
  }

  insertJob(draft: Omit<ScheduleJob, "id" | "createdAt" | "nextRunAtMs"> & { nextRunAtMs?: number }): ScheduleJob {
    const state = this.ensureLoaded();
    if (state.jobs.length >= MAX_JOBS) {
      throw createScheduleError("JOB_LIMIT", `调度任务已达上限 ${MAX_JOBS} 个，先删除不用再建`);
    }
    const now = Date.now();
    const job: ScheduleJob = {
      ...stripJobSecrets(draft),
      allowedToolNames: [...draft.allowedToolNames],
      id: nextJobId(),
      createdAt: now
    };
    state.jobs.push(job);
    this.flush();
    return { ...job, allowedToolNames: [...job.allowedToolNames] };
  }

  updateJob(job: ScheduleJob): void {
    const state = this.ensureLoaded();
    const index = state.jobs.findIndex((item) => item.id === job.id);
    if (index < 0) {
      throw createScheduleError("NOT_FOUND", `任务不存在：${job.id}`);
    }
    state.jobs[index] = {
      ...stripJobSecrets(job),
      allowedToolNames: [...job.allowedToolNames]
    };
    this.flush();
  }

  removeJob(id: string): boolean {
    const state = this.ensureLoaded();
    const index = state.jobs.findIndex((item) => item.id === id);
    if (index < 0) {
      return false;
    }
    state.jobs.splice(index, 1);
    this.flush();
    return true;
  }

  appendRun(run: Omit<SchedulerRunRecord, "id">): SchedulerRunRecord {
    const state = this.ensureLoaded();
    const record: SchedulerRunRecord = { ...run, id: nextRunId() };
    if (record.delivery.state === "pending") {
      this.enqueueDelivery(record, record.delivery.enqueuedAt);
    }
    state.runs.push(record);
    state.runs = state.runs.slice(-MAX_RUN_RECORDS);
    this.flush();
    return { ...record };
  }

  updateRun(record: SchedulerRunRecord): void {
    const state = this.ensureLoaded();
    const index = state.runs.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      state.runs[index] = { ...record };
      this.flush();
    }
  }

  listRuns(limit = 20): SchedulerRunRecord[] {
    return this.ensureLoaded().runs.slice(-Math.max(1, Math.min(limit, MAX_RUN_RECORDS))).map((run) => ({ ...run }));
  }

  /** 入队一条待投递记录；积压超上限时直接落 failed，不静默丢弃。 */
  private enqueueDelivery(record: SchedulerRunRecord, now: number): void {
    const pendingCount = this.ensureLoaded().runs
      .filter((run) => run.delivery.state === "pending" || run.delivery.state === "delivering")
      .length;
    if (pendingCount >= MAX_PENDING_DELIVERY) {
      record.delivery = {
        state: "failed",
        attempts: 0,
        enqueuedAt: now,
        errorCode: "QUEUE_FULL"
      };
    }
  }

  /**
   * 原子领取待投递记录（PRO-06）。
   * 先回收过期租约与超时待投递，再把 pending 置为 delivering 并写租约，
   * 保证同一记录同一时刻只被一个客户端通知。
   */
  claimPendingDelivery(limit = MAX_DELIVERY_BATCH): SchedulerRunRecord[] {
    const state = this.ensureLoaded();
    const now = Date.now();
    const capped = Math.max(1, Math.min(Math.floor(limit) || MAX_DELIVERY_BATCH, MAX_DELIVERY_BATCH));
    let changed = false;

    for (const run of state.runs) {
      const delivery = run.delivery;
      if (delivery.state === "delivering") {
        if (!delivery.leaseUntil || delivery.leaseUntil <= now) {
          // 租约过期：客户端可能已崩溃，回到 pending 等下次领取。
          delivery.state = delivery.attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending";
          delivery.leaseUntil = undefined;
          if (delivery.state === "failed") {
            delivery.errorCode = delivery.errorCode ?? "LEASE_EXPIRED";
          }
          changed = true;
        }
        continue;
      }
      if (delivery.state === "pending") {
        if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
          delivery.state = "failed";
          delivery.errorCode = delivery.errorCode ?? "DELIVERY_ATTEMPTS_EXCEEDED";
          changed = true;
          continue;
        }
        if (now - delivery.enqueuedAt > DELIVERY_EXPIRE_MS) {
          delivery.state = "expired";
          changed = true;
        }
      }
    }

    // 最旧优先：提醒的价值随时间衰减，也避免新记录把旧记录顶死。
    const candidates = state.runs
      .filter((run) => run.delivery.state === "pending" && run.status !== "running")
      .sort((a, b) => a.delivery.enqueuedAt - b.delivery.enqueuedAt)
      .slice(0, capped);

    for (const run of candidates) {
      run.delivery.state = "delivering";
      run.delivery.attempts += 1;
      run.delivery.lastAttemptAt = now;
      run.delivery.leaseUntil = now + DELIVERY_LEASE_MS;
      changed = true;
    }

    if (changed) {
      this.flush();
    }
    return candidates.map((run) => ({ ...run, delivery: { ...run.delivery } }));
  }

  /**
   * 按结果落投递状态（幂等）。
   * 只有 delivering 记录接受结果；重复上报不改变终态。
   */
  recordDeliveryResults(
    results: Array<{ runId: string; result: "sent" | "failed"; errorCode?: string }>
  ): number {
    const state = this.ensureLoaded();
    let changed = 0;
    for (const item of results) {
      const run = state.runs.find((candidate) => candidate.id === item.runId);
      if (!run || run.delivery.state !== "delivering") {
        continue;
      }
      run.delivery.state = item.result === "sent" ? "sent" : "failed";
      run.delivery.leaseUntil = undefined;
      run.delivery.errorCode = item.errorCode;
      changed += 1;
    }
    if (changed > 0) {
      this.flush();
    }
    return changed;
  }

  /** 按条件通知策略主动不打扰（终态，不算送达）。 */
  suppressDelivery(runId: string): void {
    const state = this.ensureLoaded();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      return;
    }
    run.delivery = {
      state: "suppressed",
      attempts: run.delivery.attempts,
      enqueuedAt: run.delivery.enqueuedAt
    };
    this.flush();
  }

  /** 待投递/失败/过期计数（托盘未读与台账使用）。 */
  countUndelivered(): number {
    return this.ensureLoaded().runs
      .filter((run) => run.delivery.state === "pending" || run.delivery.state === "delivering" || run.delivery.state === "failed")
      .length;
  }

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.state = null;
  }
}

export const schedulerStore = new SchedulerStore();
