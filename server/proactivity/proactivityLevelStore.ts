/**
 * PRO-02 Proactivity 分级持久化 —— 唯一存储入口。
 *
 * 存储：<runtime>/proactivity/level.json，原子写（tmp + rename）。
 * 语义（三档、预算、默认值、fail-safe）全部由 proactivityLevelPolicy.ts 决定。
 * 缺失按「平衡」继续；损坏先隔离再按「平衡」继续，绝不静默变成「积极」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import {
  DEFAULT_PROACTIVITY_LEVEL,
  assertValidProactivityLevel,
  isProactivityLevel,
  resolveProactivityBudget,
  type ProactivityLevel,
  type ProactivityLevelConfigStatus,
  type ProactivityLevelStatus
} from "./proactivityLevelPolicy";

const STATE_VERSION = 1;

type StoredState = {
  version: typeof STATE_VERSION;
  level: ProactivityLevel;
  updatedAt: number;
};

function proactivityDir(): string {
  const fromEnv = process.env.VOID_PROACTIVITY_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "proactivity");
}

function levelFile(): string {
  return join(proactivityDir(), "level.json");
}

class ProactivityLevelStore {
  private level: ProactivityLevel = DEFAULT_PROACTIVITY_LEVEL;
  private configStatus: ProactivityLevelConfigStatus = "missing";
  private updatedAt: number | null = null;
  private loadAttempted = false;

  private ensureLoaded(): void {
    if (this.loadAttempted) {
      return;
    }
    this.loadAttempted = true;

    const file = levelFile();
    if (!existsSync(file)) {
      this.configStatus = "missing";
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.quarantine("JSON 解析失败");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.quarantine("结构不是对象");
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== STATE_VERSION || !isProactivityLevel(record.level)) {
      this.quarantine("版本或等级不匹配");
      return;
    }

    this.level = record.level;
    this.updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : null;
    this.configStatus = "ok";
  }

  /** 坏文件改名隔离后按「平衡」继续；不猜测用户想要的档位。 */
  private quarantine(reason: string): void {
    try {
      renameSync(levelFile(), join(proactivityDir(), `level.corrupt-${Date.now()}.json`));
    } catch {
      // 改名失败也不能阻塞：内存里仍按默认等级继续。
    }
    this.level = DEFAULT_PROACTIVITY_LEVEL;
    this.updatedAt = null;
    this.configStatus = "corrupt";
    console.warn(`[void-proactivity] level.json 已隔离（${reason}），按平衡档继续`);
  }

  getLevel(): { level: ProactivityLevel; configStatus: ProactivityLevelConfigStatus } {
    this.ensureLoaded();
    return { level: this.level, configStatus: this.configStatus };
  }

  getStatus(nowMs = Date.now()): ProactivityLevelStatus {
    this.ensureLoaded();
    return {
      level: this.level,
      configStatus: this.configStatus,
      budget: resolveProactivityBudget(this.level),
      updatedAt: this.updatedAt,
      serverNow: nowMs
    };
  }

  /** 整体替换；非法值不写盘。 */
  setLevel(raw: unknown, nowMs = Date.now()): ProactivityLevelStatus {
    this.ensureLoaded();
    const level = assertValidProactivityLevel(raw);
    const state: StoredState = { version: STATE_VERSION, level, updatedAt: nowMs };
    mkdirSync(proactivityDir(), { recursive: true });
    const file = levelFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
    this.level = level;
    this.updatedAt = state.updatedAt;
    this.configStatus = "ok";
    return this.getStatus(nowMs);
  }

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.level = DEFAULT_PROACTIVITY_LEVEL;
    this.configStatus = "missing";
    this.updatedAt = null;
    this.loadAttempted = false;
  }
}

export const proactivityLevelStore = new ProactivityLevelStore();
