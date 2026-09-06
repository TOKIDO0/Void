/**
 * C 模型用量记账：tokens 按天按模型累积 + 每日上限熔断。
 * 数据只认上游回执的 usage（SSE 尾块 / 非流 JSON）；拿不到时只记 calls/bytes，不编造 tokens。
 * 持久化运行时根 usage/usage.json（原子写，保留 90 天）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

export type ModelUsageDayEntry = {
  date: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseBytes: number;
  models: Record<string, {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
};

export type ModelUsageState = {
  version: 1;
  dailyTokenCap: number;
  days: Record<string, ModelUsageDayEntry>;
};

const MAX_KEPT_DAYS = 90;

function usageDir(): string {
  const fromEnv = process.env.VOID_USAGE_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "usage");
}

function usageFile(): string {
  return join(usageDir(), "usage.json");
}

function todayKey(nowMs = Date.now()): string {
  const date = new Date(nowMs);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyDay(date: string): ModelUsageDayEntry {
  return { date, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, responseBytes: 0, models: {} };
}

function emptyState(): ModelUsageState {
  return { version: 1, dailyTokenCap: 0, days: {} };
}

function sanitizeState(raw: unknown): ModelUsageState {
  const state = emptyState();
  if (typeof raw !== "object" || raw === null) {
    return state;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.dailyTokenCap === "number" && Number.isFinite(record.dailyTokenCap) && record.dailyTokenCap >= 0) {
    state.dailyTokenCap = Math.floor(record.dailyTokenCap);
  }
  if (typeof record.days === "object" && record.days !== null && !Array.isArray(record.days)) {
    for (const [date, entry] of Object.entries(record.days as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof entry !== "object" || entry === null) {
        continue;
      }
      const item = entry as Record<string, unknown>;
      const num = (value: unknown): number => (
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
      );
      const models: ModelUsageDayEntry["models"] = {};
      if (typeof item.models === "object" && item.models !== null && !Array.isArray(item.models)) {
        for (const [name, model] of Object.entries(item.models as Record<string, unknown>)) {
          if (typeof model !== "object" || model === null || Array.isArray(model)) {
            continue;
          }
          const m = model as Record<string, unknown>;
          models[String(name).slice(0, 120)] = {
            calls: num(m.calls),
            promptTokens: num(m.promptTokens),
            completionTokens: num(m.completionTokens),
            totalTokens: num(m.totalTokens)
          };
        }
      }
      state.days[date] = {
        date,
        calls: num(item.calls),
        promptTokens: num(item.promptTokens),
        completionTokens: num(item.completionTokens),
        totalTokens: num(item.totalTokens),
        responseBytes: num(item.responseBytes),
        models
      };
    }
  }
  return state;
}

/** 从 SSE 文本 / 非流 JSON 文本里提取 usage（只认数字字段，不估算）。 */
export function parseUsageFromText(text: string): { promptTokens: number; completionTokens: number; totalTokens: number } | null {
  if (!text) {
    return null;
  }
  const match = text.match(/"usage"\s*:\s*\{([^}]*)\}/);
  if (!match) {
    return null;
  }
  const num = (key: string): number | null => {
    const found = match[1].match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
    return found ? Number(found[1]) : null;
  };
  const promptTokens = num("prompt_tokens");
  const completionTokens = num("completion_tokens");
  const totalTokens = num("total_tokens");
  if (promptTokens === null && completionTokens === null && totalTokens === null) {
    return null;
  }
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0)
  };
}

/** 从请求体提取模型名（非对象/无 model 返回 null，调用方跳过记账）。 */
export function extractRequestModel(body: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === "string" && model.trim() ? model.trim().slice(0, 120) : null;
  } catch {
    return null;
  }
}

/**
 * 为缺 stream_options 的流式 chat 请求补 include_usage（中转支持则回 usage，不支持则忽略）。
 * 仅当 body 为含 messages 数组的对象且 stream === true 时改写；其它原样返回同一 Buffer。
 */
export function withUsageStreamOptions(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return body;
  }
  const record = parsed as Record<string, unknown>;
  if (record.stream !== true || !Array.isArray(record.messages) || record.stream_options !== undefined) {
    return body;
  }
  return Buffer.from(JSON.stringify({ ...record, stream_options: { include_usage: true } }), "utf8");
}

class ModelUsageStore {
  private state: ModelUsageState | null = null;

  private ensureLoaded(): ModelUsageState {
    if (this.state) {
      return this.state;
    }
    try {
      mkdirSync(usageDir(), { recursive: true });
      const file = usageFile();
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
    const dates = Object.keys(state.days).sort();
    while (dates.length > MAX_KEPT_DAYS) {
      const oldest = dates.shift();
      if (oldest) {
        delete state.days[oldest];
      }
    }
    const file = usageFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
  }

  recordCompletion(input: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    responseBytes: number;
    nowMs?: number;
  }): void {
    const state = this.ensureLoaded();
    const date = todayKey(input.nowMs);
    const day = state.days[date] ?? emptyDay(date);
    state.days[date] = day;
    day.calls += 1;
    day.promptTokens += input.promptTokens;
    day.completionTokens += input.completionTokens;
    day.totalTokens += input.totalTokens;
    day.responseBytes += input.responseBytes;
    const name = input.model.slice(0, 120);
    const model = day.models[name] ?? { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    day.models[name] = model;
    model.calls += 1;
    model.promptTokens += input.promptTokens;
    model.completionTokens += input.completionTokens;
    model.totalTokens += input.totalTokens;
    this.flush();
  }

  getDay(date: string): ModelUsageDayEntry {
    return this.ensureLoaded().days[date] ?? emptyDay(date);
  }

  getToday(nowMs = Date.now()): ModelUsageDayEntry {
    return this.getDay(todayKey(nowMs));
  }

  getLast7Days(nowMs = Date.now()): ModelUsageDayEntry[] {
    const state = this.ensureLoaded();
    const out: ModelUsageDayEntry[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const date = todayKey(nowMs - offset * 24 * 3600_000);
      out.push(state.days[date] ?? emptyDay(date));
    }
    return out;
  }

  getDailyTokenCap(): number {
    return this.ensureLoaded().dailyTokenCap;
  }

  setDailyTokenCap(cap: number): number {
    const state = this.ensureLoaded();
    state.dailyTokenCap = Math.max(0, Math.floor(cap));
    this.flush();
    return state.dailyTokenCap;
  }

  isOverBudget(nowMs = Date.now()): boolean {
    const state = this.ensureLoaded();
    if (!(state.dailyTokenCap > 0)) {
      return false;
    }
    return this.getToday(nowMs).totalTokens >= state.dailyTokenCap;
  }

  /** 测试/隔离专用：重置内存态。 */
  resetMemory(): void {
    this.state = null;
  }
}

export const modelUsageStore = new ModelUsageStore();
export { todayKey };
