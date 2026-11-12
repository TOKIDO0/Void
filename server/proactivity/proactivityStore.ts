/**
 * PRO-04 安静时段持久化 —— 唯一存储入口。
 *
 * 存储：<runtime>/proactivity/quiet-hours.json，原子写（tmp + rename）。
 * 语义不在这里：窗口判定、默认值、fail-safe 全部由 proactivityPolicy.ts 决定。
 * 配置缺失用默认窗口；损坏先隔离再按默认窗口继续，绝不静默变成“全天可打扰”。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import {
  createProactivityError,
  defaultQuietHoursConfig,
  evaluateQuietHours,
  parseQuietHoursConfig,
  type QuietHoursConfig,
  type QuietHoursConfigStatus,
  type QuietHoursEvaluation
} from "./proactivityPolicy";

const STATE_VERSION = 1;

export type ProactivityStatus = {
  config: QuietHoursConfig;
  configStatus: QuietHoursConfigStatus;
  quiet: boolean;
  windowEndsAt: number | null;
  nextChangeAt: number | null;
  updatedAt: number | null;
  serverNow: number;
};

type StoredState = QuietHoursConfig & {
  version: typeof STATE_VERSION;
  updatedAt: number;
};

function proactivityDir(): string {
  const fromEnv = process.env.VOID_PROACTIVITY_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "proactivity");
}

function quietHoursFile(): string {
  return join(proactivityDir(), "quiet-hours.json");
}

class ProactivityStore {
  private config: QuietHoursConfig | null = null;
  private configStatus: QuietHoursConfigStatus = "missing";
  private updatedAt: number | null = null;
  private loadAttempted = false;

  private ensureLoaded(): void {
    if (this.loadAttempted) {
      return;
    }
    this.loadAttempted = true;
    mkdirSync(proactivityDir(), { recursive: true });

    const file = quietHoursFile();
    if (!existsSync(file)) {
      this.config = defaultQuietHoursConfig();
      this.configStatus = "missing";
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.quarantineCorrupt("JSON 解析失败");
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.quarantineCorrupt("结构不是对象");
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== STATE_VERSION) {
      this.quarantineCorrupt("版本不匹配");
      return;
    }

    const result = parseQuietHoursConfig(record);
    if (!result.ok) {
      this.quarantineCorrupt(result.message);
      return;
    }

    this.config = result.config;
    this.updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : null;
    this.configStatus = "ok";
  }

  /** 坏文件改名隔离后按默认窗口继续；不猜测修复，也不让坏配置变成全天放行。 */
  private quarantineCorrupt(reason: string): void {
    try {
      renameSync(quietHoursFile(), join(proactivityDir(), `quiet-hours.corrupt-${Date.now()}.json`));
    } catch {
      // 改名失败也不能阻塞：内存里仍按默认窗口继续。
    }
    this.config = defaultQuietHoursConfig();
    this.updatedAt = null;
    this.configStatus = "corrupt";
    console.warn(`[void-proactivity] quiet-hours.json 已隔离（${reason}），按默认 23:00–08:00 继续`);
  }

  private flush(): void {
    this.ensureLoaded();
    const config = this.config ?? defaultQuietHoursConfig();
    const state: StoredState = {
      version: STATE_VERSION,
      ...config,
      updatedAt: Date.now()
    };
    const file = quietHoursFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
    this.updatedAt = state.updatedAt;
    this.configStatus = "ok";
  }

  getConfig(): QuietHoursConfig {
    this.ensureLoaded();
    return { ...(this.config ?? defaultQuietHoursConfig()) };
  }

  evaluate(nowMs = Date.now()): QuietHoursEvaluation {
    return evaluateQuietHours(this.getConfig(), nowMs);
  }

  getStatus(nowMs = Date.now()): ProactivityStatus {
    this.ensureLoaded();
    const config = this.getConfig();
    const evaluation = evaluateQuietHours(config, nowMs);
    return {
      config,
      configStatus: this.configStatus,
      quiet: evaluation.quiet,
      windowEndsAt: evaluation.windowEndsAt,
      nextChangeAt: evaluation.nextChangeAt,
      updatedAt: this.updatedAt,
      serverNow: nowMs
    };
  }

  /** 整体替换；非法值不写盘。 */
  setQuietHours(raw: unknown, nowMs = Date.now()): ProactivityStatus {
    this.ensureLoaded();
    const parsed = parseQuietHoursConfig(raw);
    if (!parsed.ok) {
      throw createProactivityError("INVALID_REQUEST", parsed.message);
    }
    this.config = parsed.config;
    this.flush();
    return this.getStatus(nowMs);
  }

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.config = null;
    this.configStatus = "missing";
    this.updatedAt = null;
    this.loadAttempted = false;
  }
}

export const proactivityStore = new ProactivityStore();
