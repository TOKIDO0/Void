/**
 * 桌面控制面分级授权（P0-5 真源，Claude Code 式）。
 *
 * owner：server/desktop/desktopAuthorizer.ts。
 * - 三态：allow（直行）/ ask（需前端确认，sidecar 默认记账放行、严格模式要求 confirmed 标记）
 *   / deny（sidecar 直接 403，一票否决）；
 * - 通配符：desktop.*、desktop.window.*、*；deny 优先于 allow/ask；
 * - 持久化：<runtime-root>/desktop/permissions.json（规则 + profile），缺失用内置默认；
 * - highPermissionMode 降级为快捷 profile（见 PermissionProfile），不再是独立布尔语义；
 * - /permissions 查询与更新走 desktopHttpHandlers 的只读/写路由（另行挂载）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

export type PermissionEffect = "allow" | "ask" | "deny";
export type PermissionProfile = "default" | "read-only" | "permissive";

export type DesktopPermissionRule = {
  /** 匹配模式：精确（desktop.screenshot）或通配（desktop.window.*、desktop.*、*）。 */
  pattern: string;
  effect: PermissionEffect;
  reason?: string;
};

export type DesktopPermissionsFile = {
  version: 1;
  profile: PermissionProfile;
  /** 严格模式：ask 必须携带 confirmed:true，否则 409。默认 false（ask 记账放行）。 */
  strictAsk: boolean;
  rules: DesktopPermissionRule[];
};

export type PermissionDecision = {
  effect: PermissionEffect;
  reason: string;
  matchedPattern?: string;
};

const PERMISSION_FILE_VERSION = 1;

/** 内置默认规则：只读直行，写/控 ask，危险（关窗口/注入文本/执行调用）默认 ask + 可一键 deny。 */
const DEFAULT_RULES: DesktopPermissionRule[] = [
  { pattern: "desktop.listWindows", effect: "allow", reason: "只读窗口枚举" },
  { pattern: "desktop.getSystemInfo", effect: "allow", reason: "只读系统信息" },
  { pattern: "desktop.screenshot", effect: "allow", reason: "只读截图" },
  { pattern: "desktop.inspectWindowControls", effect: "allow", reason: "只读控件检查" },
  { pattern: "desktop.listApps", effect: "allow", reason: "只读应用列表" },
  { pattern: "desktop.clipboard.read", effect: "allow", reason: "剪贴板读取（读侧）" },
  { pattern: "desktop.health", effect: "allow", reason: "健康检查" },
  { pattern: "desktop.clipboard.write", effect: "ask", reason: "剪贴板写入外发风险" },
  { pattern: "desktop.revealPath", effect: "ask", reason: "打开资源管理器路径" },
  { pattern: "desktop.openKnownLocation", effect: "ask", reason: "打开系统位置" },
  { pattern: "desktop.launchApp", effect: "ask", reason: "启动应用" },
  { pattern: "desktop.openFile", effect: "ask", reason: "默认程序打开文件" },
  { pattern: "desktop.focusWindow", effect: "ask", reason: "窗口焦点切换" },
  { pattern: "desktop.setWindowBounds", effect: "ask", reason: "窗口位置/尺寸变更" },
  { pattern: "desktop.closeWindow", effect: "ask", reason: "关闭窗口不可逆" },
  { pattern: "desktop.setControlText", effect: "ask", reason: "向控件注入文本" },
  { pattern: "desktop.invokeControl", effect: "ask", reason: "触发控件动作" },
  { pattern: "desktop.*", effect: "ask", reason: "桌面域默认需确认" }
];

function permissionsDir(): string {
  const fromEnv = process.env.VOID_DESKTOP_PERMISSIONS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(resolveRuntimeRoot(), "desktop");
}

function permissionsFile(): string {
  return join(permissionsDir(), "permissions.json");
}

function defaultPermissions(): DesktopPermissionsFile {
  return {
    version: PERMISSION_FILE_VERSION,
    profile: "default",
    strictAsk: process.env.VOID_DESKTOP_STRICT_ASK === "1",
    rules: DEFAULT_RULES.map((rule) => ({ ...rule }))
  };
}

function sanitizePermissions(raw: unknown): DesktopPermissionsFile {
  const fallback = defaultPermissions();
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  const profile: PermissionProfile =
    record.profile === "read-only" || record.profile === "permissive" ? record.profile : "default";
  const strictAsk = record.strictAsk === true || process.env.VOID_DESKTOP_STRICT_ASK === "1";
  const rules: DesktopPermissionRule[] = [];
  if (Array.isArray(record.rules)) {
    for (const item of record.rules.slice(0, 100)) {
      if (typeof item !== "object" || item === null) continue;
      const rule = item as Record<string, unknown>;
      if (typeof rule.pattern !== "string" || !rule.pattern.trim()) continue;
      if (rule.effect !== "allow" && rule.effect !== "ask" && rule.effect !== "deny") continue;
      rules.push({
        pattern: rule.pattern.trim().slice(0, 120),
        effect: rule.effect,
        reason: typeof rule.reason === "string" ? rule.reason.slice(0, 200) : undefined
      });
    }
  }
  return {
    version: 1,
    profile,
    strictAsk,
    rules: rules.length > 0 ? rules : fallback.rules
  };
}

function applyProfile(base: DesktopPermissionsFile): DesktopPermissionsFile {
  if (base.profile === "read-only") {
    // 只读档：把所有 ask/allow 的写控动作收紧为 ask，deny 保持。
    return {
      ...base,
      rules: base.rules.map((rule) =>
        rule.effect === "deny" ? rule : isReadOnlyAction(rule.pattern) ? rule : { ...rule, effect: "ask" as PermissionEffect }
      )
    };
  }
  if (base.profile === "permissive") {
    // highPermissionMode 的继任者：快捷 profile，一键把 ask 放宽为 allow（deny 仍优先）。
    return {
      ...base,
      rules: base.rules.map((rule) =>
        rule.effect === "ask" ? { ...rule, effect: "allow" as PermissionEffect, reason: `${rule.reason ?? ""}（permissive profile 放宽）` } : rule
      )
    };
  }
  return base;
}

function isReadOnlyAction(pattern: string): boolean {
  return (
    pattern.includes("listWindows") ||
    pattern.includes("getSystemInfo") ||
    pattern.includes("screenshot") ||
    pattern.includes("inspectWindowControls") ||
    pattern.includes("listApps") ||
    pattern.includes("clipboard.read") ||
    pattern.includes("health")
  );
}

function matchesPattern(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern === action) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return action === prefix || action.startsWith(`${prefix}.`);
  }
  if (pattern.includes("*")) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${escaped.join(".*")}$`).test(action);
  }
  return false;
}

class DesktopAuthorizer {
  private cache: DesktopPermissionsFile | null = null;

  private load(): DesktopPermissionsFile {
    if (this.cache) return this.cache;
    try {
      mkdirSync(permissionsDir(), { recursive: true });
      const file = permissionsFile();
      if (!existsSync(file)) {
        this.cache = applyProfile(defaultPermissions());
        return this.cache;
      }
      this.cache = applyProfile(sanitizePermissions(JSON.parse(readFileSync(file, "utf8"))));
      return this.cache;
    } catch {
      this.cache = applyProfile(defaultPermissions());
      return this.cache;
    }
  }

  /** 测试/隔离：重置内存缓存。 */
  resetMemory(): void {
    this.cache = null;
  }

  getState(): DesktopPermissionsFile {
    const state = this.load();
    return { ...state, rules: state.rules.map((rule) => ({ ...rule })) };
  }

  saveState(next: DesktopPermissionsFile): DesktopPermissionsFile {
    const sanitized = applyProfile(sanitizePermissions(next));
    mkdirSync(permissionsDir(), { recursive: true });
    const file = permissionsFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(sanitized, null, 2), "utf8");
    renameSync(tmp, file);
    this.cache = sanitized;
    return this.getState();
  }

  /**
   * deny 优先：任意 deny 命中即 deny（取最具体的 deny）；
   * 其余按最具体 pattern 的 effect 裁决（精确 allow 不被兜底 ask 覆盖）。
   */
  decide(action: string): PermissionDecision {
    const state = this.load();
    const hits = state.rules
      .filter((rule) => matchesPattern(rule.pattern, action))
      .sort((a, b) => b.pattern.length - a.pattern.length);
    const deny = hits.find((rule) => rule.effect === "deny");
    if (deny) {
      return { effect: "deny", reason: deny.reason ?? "管理员 deny 规则命中", matchedPattern: deny.pattern };
    }
    const top = hits[0];
    if (top) {
      return { effect: top.effect, reason: top.reason ?? "规则命中", matchedPattern: top.pattern };
    }
    return { effect: "ask", reason: "无规则命中，默认需确认" };
  }

  isStrictAsk(): boolean {
    return this.load().strictAsk;
  }
}

export const desktopAuthorizer = new DesktopAuthorizer();
