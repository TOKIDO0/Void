// 结构化执行日志与用户可见进度。设计依据：`.md/27` §5.6。

import { sanitizeForAudit } from "./auditSanitize";

export type ExecutionLogLevel = "debug" | "info" | "warn" | "error";

export type ExecutionLogEvent = {
  id: string;
  at: number;
  level: ExecutionLogLevel;
  taskId: string;
  stepId?: string;
  toolName?: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
};

export type TaskProgressSnapshot = {
  taskId: string;
  status: string;
  goal: string;
  currentStepId?: string;
  currentStepTitle?: string;
  currentToolName?: string;
  completedSteps: number;
  totalSteps: number;
  message: string;
  updatedAt: number;
};

type LogListener = (event: ExecutionLogEvent) => void;
type ProgressListener = (progress: TaskProgressSnapshot) => void;

const logs: ExecutionLogEvent[] = [];
const progressByTaskId = new Map<string, TaskProgressSnapshot>();
const logListeners = new Set<LogListener>();
const progressListeners = new Set<ProgressListener>();

let logSequence = 0;
const MAX_LOG_EVENTS = 500;

export function appendExecutionLog(input: {
  level?: ExecutionLogLevel;
  taskId: string;
  stepId?: string;
  toolName?: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  redactKeys?: string[];
}): ExecutionLogEvent {
  logSequence += 1;
  const event: ExecutionLogEvent = {
    id: `log_${Date.now().toString(36)}_${logSequence}`,
    at: Date.now(),
    level: input.level ?? "info",
    taskId: input.taskId,
    stepId: input.stepId,
    toolName: input.toolName,
    event: input.event,
    message: input.message,
    data: input.data
      ? (sanitizeForAudit(input.data, input.redactKeys ?? []) as Record<string, unknown>)
      : undefined
  };

  logs.push(event);
  if (logs.length > MAX_LOG_EVENTS) {
    logs.splice(0, logs.length - MAX_LOG_EVENTS);
  }

  for (const listener of logListeners) {
    listener(event);
  }

  return event;
}

export function setTaskProgress(progress: TaskProgressSnapshot) {
  const next: TaskProgressSnapshot = {
    ...progress,
    message: progress.message,
    updatedAt: Date.now()
  };
  progressByTaskId.set(progress.taskId, next);
  for (const listener of progressListeners) {
    listener(next);
  }
  return next;
}

export function getTaskProgress(taskId: string) {
  return progressByTaskId.get(taskId);
}

export function listExecutionLogs(taskId?: string) {
  if (!taskId) {
    return logs.map((item) => ({ ...item, data: item.data ? { ...item.data } : undefined }));
  }
  return logs
    .filter((item) => item.taskId === taskId)
    .map((item) => ({ ...item, data: item.data ? { ...item.data } : undefined }));
}

export function subscribeExecutionLogs(listener: LogListener) {
  logListeners.add(listener);
  return () => {
    logListeners.delete(listener);
  };
}

export function subscribeTaskProgress(listener: ProgressListener) {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

export function clearExecutionObservability() {
  logs.splice(0, logs.length);
  progressByTaskId.clear();
}
