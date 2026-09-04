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
  type ScheduleJob,
  type SchedulerRunRecord,
  type SchedulerState
} from "./schedulerTypes";

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
        kind: job.kind === "every" ? "every" : "at",
        atMs: typeof job.atMs === "number" ? job.atMs : undefined,
        everyMs: typeof job.everyMs === "number" ? job.everyMs : undefined,
        anchorMs: typeof job.anchorMs === "number" ? job.anchorMs : undefined,
        allowedToolNames: Array.isArray(job.allowedToolNames)
          ? job.allowedToolNames.filter((x): x is string => typeof x === "string")
          : [],
        timeoutMs: typeof job.timeoutMs === "number" ? job.timeoutMs : 600_000,
        enabled: job.enabled !== false,
        createdAt: typeof job.createdAt === "number" ? job.createdAt : Date.now(),
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
        delivered: run.delivered === true
      });
    }
  }
  return state;
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
    const job: ScheduleJob = { ...draft, allowedToolNames: [...draft.allowedToolNames], id: nextJobId(), createdAt: now };
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
    state.jobs[index] = { ...job, allowedToolNames: [...job.allowedToolNames] };
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

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.state = null;
  }
}

export const schedulerStore = new SchedulerStore();
