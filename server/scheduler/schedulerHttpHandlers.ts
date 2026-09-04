/**
 * P4b 调度器 HTTP 路由：/void-scheduler/*（回环 + token，与其它 sidecar 模块同契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 * 注意：unlock 只收模型 Key 进内存，不落盘、不回显。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import type { ModelConfig } from "../../src/features/settings/modelConfig";
import { computeNextRunAtMs, validateCreateInput } from "./schedulerEngine";
import {
  hasSchedulerModelKey,
  notifySchedulerChanged,
  requestManualRun,
  schedulerRunningCount,
  setSchedulerModelKey
} from "./schedulerRunner";
import { schedulerStore } from "./schedulerStore";
import { getScheduleErrorInfo, type ScheduleCreateInput } from "./schedulerTypes";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function withSchedulerHandler<T>(
  response: ServerResponse,
  work: () => Promise<T> | T
): Promise<void> {
  try {
    const data = await work();
    sendJson(response, 200, { ok: true, data });
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message }
      });
      return;
    }
    if (isInvalidJsonBody(error)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: (error as Error).message }
      });
      return;
    }
    const info = getScheduleErrorInfo(error);
    const status = info.code === "NOT_FOUND" ? 404 : info.code === "JOB_LIMIT" || info.code === "NEEDS_UNLOCK" ? 409 : 400;
    sendJson(response, status, { ok: false, error: info });
  }
}

function summarizeJob(job: {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  missedCount: number;
  failStreak: number;
  atMs?: number;
  everyMs?: number;
}): Record<string, unknown> {
  return { ...job };
}

export async function handleSchedulerHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-scheduler")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-scheduler/status") {
    await withSchedulerHandler(response, () => {
      const jobs = schedulerStore.listJobs();
      return {
        unlocked: hasSchedulerModelKey(),
        running: schedulerRunningCount(),
        jobCount: jobs.length,
        enabledCount: jobs.filter((job) => job.enabled).length
      };
    });
    return true;
  }

  if (request.method === "GET" && pathname === "/void-scheduler/jobs") {
    await withSchedulerHandler(response, () => schedulerStore.listJobs().map(summarizeJob));
    return true;
  }

  if (request.method === "GET" && pathname === "/void-scheduler/runs") {
    await withSchedulerHandler(response, () => {
      const query = (request.url ?? "").split("?")[1] ?? "";
      const limit = Math.max(1, Math.min(Number(new URLSearchParams(query).get("limit") ?? 20) || 20, 100));
      return schedulerStore.listRuns(limit);
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-scheduler/jobs/create") {
    await withSchedulerHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const now = Date.now();
      const draft = validateCreateInput(
        {
          name: typeof body.name === "string" ? body.name : undefined,
          prompt: typeof body.prompt === "string" ? body.prompt : "",
          kind: body.kind as ScheduleCreateInput["kind"],
          at: (typeof body.at === "string" || typeof body.at === "number") ? body.at : undefined,
          every: (typeof body.every === "string" || typeof body.every === "number") ? body.every : undefined,
          allowedToolNames: Array.isArray(body.allowedToolNames)
            ? body.allowedToolNames.filter((x): x is string => typeof x === "string")
            : undefined,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined
        },
        now
      );
      const job = schedulerStore.insertJob(draft);
      job.nextRunAtMs = computeNextRunAtMs(job, job.createdAt, now);
      schedulerStore.updateJob(job);
      notifySchedulerChanged();
      return job;
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-scheduler/jobs/remove") {
    await withSchedulerHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) {
        throw Object.assign(new Error("id 不能为空"), { scheduleCode: "INVALID_REQUEST" });
      }
      const removed = schedulerStore.removeJob(id);
      notifySchedulerChanged();
      return { removed };
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-scheduler/jobs/run") {
    await withSchedulerHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) {
        throw Object.assign(new Error("id 不能为空"), { scheduleCode: "INVALID_REQUEST" });
      }
      const record = requestManualRun(id);
      return { runId: record.id, status: record.status };
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-scheduler/unlock") {
    await withSchedulerHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const modelConfig = asRecord(body.modelConfig);
      setSchedulerModelKey({
        provider: typeof modelConfig.provider === "string" ? modelConfig.provider : "",
        presetId: typeof modelConfig.presetId === "string" ? modelConfig.presetId : "",
        apiKey: typeof modelConfig.apiKey === "string" ? modelConfig.apiKey : "",
        baseUrl: typeof modelConfig.baseUrl === "string" ? modelConfig.baseUrl : "",
        modelName: typeof modelConfig.modelName === "string" ? modelConfig.modelName : "",
        modelStrength: modelConfig.modelStrength === "strong" || modelConfig.modelStrength === "weak" ? modelConfig.modelStrength : "middle",
        thinkingModeEnabled: modelConfig.thinkingModeEnabled === true,
        temperature: typeof modelConfig.temperature === "number" ? modelConfig.temperature : 0.7,
        maxOutputTokens: typeof modelConfig.maxOutputTokens === "number" ? modelConfig.maxOutputTokens : 2000,
        streamEnabled: false
      } as ModelConfig);
      return { unlocked: true };
    });
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知调度端点" } });
  return true;
}

/** 供 health/自检类输出引用的运行上界。 */
export { SCHEDULER_RUNNER_LIMITS } from "./schedulerRunner";
