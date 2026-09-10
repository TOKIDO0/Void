/**
 * P1 Hooks 注册表（Claude 兼容 PreToolUse / PostToolUse）。
 *
 * owner：server/hooks/hooksRegistry.ts。
 * - 配置：<runtime-root>/hooks/hooks.json（缺失即空集，不报错）；
 * - hook 形态：{ event: PreToolUse|PostToolUse, toolPattern（* 通配）, effect: allow|ask|deny, reason? }；
 * - command 字段保留但默认不执行（VOID_HOOKS_ALLOW_COMMANDS=1 才允许，且本期只记录不执行，
 *   执行面待审计链路闭合后再开）；
 * - deny 优先；PreToolUse 供桌面/MCP 门禁咨询，PostToolUse 供审计补充。
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

export type HookEvent = "PreToolUse" | "PostToolUse";
export type HookEffect = "allow" | "ask" | "deny";

export type ToolHook = {
  event: HookEvent;
  toolPattern: string;
  effect: HookEffect;
  reason?: string;
};

export type HooksFile = {
  version: 1;
  hooks: ToolHook[];
};

export type HookDecision = {
  effect: HookEffect;
  reason: string;
  matchedPattern?: string;
};

function hooksDir(): string {
  const fromEnv = process.env.VOID_HOOKS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveRuntimeRoot(), "hooks");
}

function hooksFile(): string {
  return join(hooksDir(), "hooks.json");
}

function matchPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern === toolName) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return toolName === prefix || toolName.startsWith(`${prefix}.`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${escaped.join(".*")}$`).test(toolName);
  }
  return false;
}

function sanitize(raw: unknown): HooksFile {
  if (typeof raw !== "object" || raw === null) return { version: 1, hooks: [] };
  const record = raw as Record<string, unknown>;
  const hooks: ToolHook[] = [];
  if (Array.isArray(record.hooks)) {
    for (const item of record.hooks.slice(0, 100)) {
      if (typeof item !== "object" || item === null) continue;
      const hook = item as Record<string, unknown>;
      if (hook.event !== "PreToolUse" && hook.event !== "PostToolUse") continue;
      if (typeof hook.toolPattern !== "string" || !hook.toolPattern.trim()) continue;
      if (hook.effect !== "allow" && hook.effect !== "ask" && hook.effect !== "deny") continue;
      hooks.push({
        event: hook.event,
        toolPattern: hook.toolPattern.trim().slice(0, 120),
        effect: hook.effect,
        reason: typeof hook.reason === "string" ? hook.reason.slice(0, 200) : undefined
      });
    }
  }
  return { version: 1, hooks };
}

class HooksRegistry {
  private cache: HooksFile | null = null;
  private cacheAt = 0;
  private readonly cacheTtlMs = 5_000;

  private load(): HooksFile {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < this.cacheTtlMs) return this.cache;
    try {
      mkdirSync(hooksDir(), { recursive: true });
      const file = hooksFile();
      if (!existsSync(file)) {
        this.cache = { version: 1, hooks: [] };
        this.cacheAt = now;
        return this.cache;
      }
      this.cache = sanitize(JSON.parse(readFileSync(file, "utf8")));
      this.cacheAt = now;
      return this.cache;
    } catch {
      this.cache = { version: 1, hooks: [] };
      this.cacheAt = now;
      return this.cache;
    }
  }

  resetMemory(): void {
    this.cache = null;
    this.cacheAt = 0;
  }

  list(): HooksFile {
    const state = this.load();
    return { version: 1, hooks: state.hooks.map((hook) => ({ ...hook })) };
  }

  /** deny 优先；同 effect 取最具体 pattern；无命中返回 null（无 hook 干预）。 */
  consult(event: HookEvent, toolName: string): HookDecision | null {
    const hits = this.load()
      .hooks.filter((hook) => hook.event === event && matchPattern(hook.toolPattern, toolName))
      .sort((a, b) => b.toolPattern.length - a.toolPattern.length);
    const deny = hits.find((hook) => hook.effect === "deny");
    if (deny) {
      return { effect: "deny", reason: deny.reason ?? `Hook deny：${deny.toolPattern}`, matchedPattern: deny.toolPattern };
    }
    const ask = hits.find((hook) => hook.effect === "ask");
    if (ask) {
      return { effect: "ask", reason: ask.reason ?? `Hook ask：${ask.toolPattern}`, matchedPattern: ask.toolPattern };
    }
    const allow = hits.find((hook) => hook.effect === "allow");
    if (allow) {
      return { effect: "allow", reason: allow.reason ?? `Hook allow：${allow.toolPattern}`, matchedPattern: allow.toolPattern };
    }
    return null;
  }
}

export const hooksRegistry = new HooksRegistry();
