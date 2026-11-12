/**
 * PRO-05 静默巡检持久化 —— 唯一存储入口。
 *
 * 三个文件各司其职，互不混写：
 * - HEARTBEAT.md   用户可编辑的巡检清单；代码只读，永不覆盖（缺失时也不自动创建）。
 * - config.json    只有开关 { enabled }；语义上属于 UI 的显式意图。
 * - state.json     只有运行态：游标、去重 fingerprint、最近结果。
 *
 * 语义不在这里：清单解析、问题判定、去重窗口全部由 heartbeatPolicy.ts 决定。
 * 配置文件损坏 → 隔离并保持「关闭」（本模块的 fail-safe 方向是不巡检）。
 * 状态文件损坏 → 隔离 + 重建空状态，并让 runner 暂停一轮通知（避免重复轰炸）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import {
  HEARTBEAT_CONFIG_VERSION,
  HEARTBEAT_DEFAULT_CHECKLIST,
  HEARTBEAT_MAX_CHECKLIST_BYTES,
  HEARTBEAT_MAX_FINGERPRINTS,
  HEARTBEAT_STATE_VERSION,
  emptyHeartbeatState,
  type HeartbeatConfig,
  type HeartbeatConfigStatus,
  type HeartbeatFingerprintRecord,
  type HeartbeatRoundResult,
  type HeartbeatState,
  type HeartbeatStateStatus
} from "./heartbeatTypes";
import type { HeartbeatChecklistRaw } from "./heartbeatPolicy";

const OUTCOMES: ReadonlySet<HeartbeatRoundResult["outcome"]> = new Set([
  "NO_ISSUES",
  "NOTIFIED",
  "SUPPRESSED_DUPLICATE",
  "SUPPRESSED_STATE_CORRUPT",
  "SKIPPED",
  "ENQUEUE_FAILED"
]);

function heartbeatDir(): string {
  const fromEnv = process.env.VOID_HEARTBEAT_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "heartbeat");
}

function configFile(): string {
  return join(heartbeatDir(), "config.json");
}

function stateFile(): string {
  return join(heartbeatDir(), "state.json");
}

export function heartbeatChecklistFile(): string {
  return join(heartbeatDir(), "HEARTBEAT.md");
}

function writeJsonAtomic(file: string, body: unknown): void {
  mkdirSync(heartbeatDir(), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), "utf8");
  renameSync(tmp, file);
}

function sanitizeFingerprints(raw: unknown): HeartbeatFingerprintRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const records: HeartbeatFingerprintRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.key !== "string" || !record.key) {
      continue;
    }
    if (typeof record.lastNotifiedAt !== "number" || !Number.isFinite(record.lastNotifiedAt)) {
      continue;
    }
    records.push({
      key: record.key.slice(0, 120),
      firstSeenAt: typeof record.firstSeenAt === "number" && Number.isFinite(record.firstSeenAt)
        ? record.firstSeenAt
        : record.lastNotifiedAt,
      lastNotifiedAt: record.lastNotifiedAt,
      lastCheck: typeof record.lastCheck === "string" ? record.lastCheck.slice(0, 40) : ""
    });
  }
  return records.slice(-HEARTBEAT_MAX_FINGERPRINTS);
}

function sanitizeRoundResult(raw: unknown): HeartbeatRoundResult | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome as HeartbeatRoundResult["outcome"])) {
    return null;
  }
  return {
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
    outcome: record.outcome as HeartbeatRoundResult["outcome"],
    skippedReason: typeof record.skippedReason === "string"
      ? (record.skippedReason as HeartbeatRoundResult["skippedReason"])
      : undefined,
    issuesFound: typeof record.issuesFound === "number" ? Math.max(0, Math.floor(record.issuesFound)) : 0,
    notified: typeof record.notified === "number" ? Math.max(0, Math.floor(record.notified)) : 0,
    suppressed: typeof record.suppressed === "number" ? Math.max(0, Math.floor(record.suppressed)) : 0,
    summary: typeof record.summary === "string" ? record.summary.slice(0, 400) : undefined,
    errorCode: typeof record.errorCode === "string" ? record.errorCode.slice(0, 40) : undefined
  };
}

class HeartbeatStore {
  private config: HeartbeatConfig | null = null;
  private configStatus: HeartbeatConfigStatus = "missing";
  private state: HeartbeatState | null = null;
  private stateStatus: HeartbeatStateStatus = "missing";

  /** 配置缺失按「关闭」处理：不巡检是安全方向，不猜用户想开。 */
  readConfig(): { config: HeartbeatConfig; status: HeartbeatConfigStatus } {
    if (this.config) {
      return { config: { ...this.config }, status: this.configStatus };
    }
    const file = configFile();
    if (!existsSync(file)) {
      this.config = { enabled: false, updatedAt: null };
      this.configStatus = "missing";
      return { config: { ...this.config }, status: this.configStatus };
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (parsed.version !== HEARTBEAT_CONFIG_VERSION || typeof parsed.enabled !== "boolean") {
        throw new Error("配置结构不匹配");
      }
      this.config = {
        enabled: parsed.enabled,
        updatedAt: typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : null
      };
      this.configStatus = "ok";
      return { config: { ...this.config }, status: this.configStatus };
    } catch (error) {
      this.quarantine("config.json", error);
      this.config = { enabled: false, updatedAt: null };
      this.configStatus = "corrupt";
      return { config: { ...this.config }, status: this.configStatus };
    }
  }

  /**
   * 保存开关。开启且清单缺失时写入默认模板；已有文件绝不覆盖。
   * 返回是否新建了模板，供 UI 提示。
   */
  setEnabled(enabled: boolean): { createdChecklist: boolean } {
    writeJsonAtomic(configFile(), {
      version: HEARTBEAT_CONFIG_VERSION,
      enabled,
      updatedAt: Date.now()
    });
    this.config = { enabled, updatedAt: Date.now() };
    this.configStatus = "ok";
    if (!enabled) {
      return { createdChecklist: false };
    }
    const checklist = heartbeatChecklistFile();
    if (existsSync(checklist)) {
      return { createdChecklist: false };
    }
    mkdirSync(heartbeatDir(), { recursive: true });
    const tmp = `${checklist}.tmp`;
    writeFileSync(tmp, HEARTBEAT_DEFAULT_CHECKLIST, "utf8");
    renameSync(tmp, checklist);
    console.info("[void-heartbeat] 已写入默认巡检清单模板");
    return { createdChecklist: true };
  }

  readChecklistFile(): HeartbeatChecklistRaw {
    const path = heartbeatChecklistFile();
    if (!existsSync(path)) {
      return { path, exists: false, text: "", tooLarge: false, unreadable: false };
    }
    try {
      if (statSync(path).size > HEARTBEAT_MAX_CHECKLIST_BYTES) {
        return { path, exists: true, text: "", tooLarge: true, unreadable: false };
      }
      return { path, exists: true, text: readFileSync(path, "utf8"), tooLarge: false, unreadable: false };
    } catch {
      return { path, exists: true, text: "", tooLarge: false, unreadable: true };
    }
  }

  loadState(): HeartbeatState {
    if (this.state) {
      return this.state;
    }
    const file = stateFile();
    if (!existsSync(file)) {
      this.state = emptyHeartbeatState();
      this.stateStatus = "missing";
      return this.state;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (parsed.version !== HEARTBEAT_STATE_VERSION) {
        throw new Error("状态版本不匹配");
      }
      this.state = {
        version: HEARTBEAT_STATE_VERSION,
        lastRunAt: typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt)
          ? parsed.lastRunAt
          : null,
        lastRunDayKey: typeof parsed.lastRunDayKey === "string" ? parsed.lastRunDayKey.slice(0, 10) : null,
        roundsToday: typeof parsed.roundsToday === "number" ? Math.max(0, Math.floor(parsed.roundsToday)) : 0,
        fingerprints: sanitizeFingerprints(parsed.fingerprints),
        lastResult: sanitizeRoundResult(parsed.lastResult)
      };
      this.stateStatus = "ok";
      return this.state;
    } catch (error) {
      this.quarantine("state.json", error);
      this.state = emptyHeartbeatState();
      this.stateStatus = "corrupt";
      return this.state;
    }
  }

  saveState(state: HeartbeatState): void {
    writeJsonAtomic(stateFile(), state);
    this.state = state;
    this.stateStatus = "ok";
  }

  getStateStatus(): HeartbeatStateStatus {
    return this.stateStatus;
  }

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.config = null;
    this.configStatus = "missing";
    this.state = null;
    this.stateStatus = "missing";
  }

  private quarantine(name: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      renameSync(join(heartbeatDir(), name), join(heartbeatDir(), `${name}.corrupt-${Date.now()}`));
    } catch {
      // 改名失败也不能阻塞：内存里仍按安全默认继续。
    }
    console.warn(`[void-heartbeat] ${name} 已隔离（${reason}）`);
  }
}

export const heartbeatStore = new HeartbeatStore();
