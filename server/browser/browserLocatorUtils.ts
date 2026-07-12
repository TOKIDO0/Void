/**
 * Q5：浏览器 locator / a11y 定位与错误辅助。
 * 从 browserSessionManager 拆出，避免会话管理文件继续膨胀。
 */

import type { Page } from "playwright";

export function createBrowserError(
  code:
    | "INVALID_REQUEST"
    | "SESSION_NOT_FOUND"
    | "PAGE_NOT_FOUND"
    | "NAVIGATION_FAILED"
    | "PARSE_FAILED"
    | "BROWSER_UNAVAILABLE"
    | "TIMEOUT"
    | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    browserCode: string;
    details?: Record<string, unknown>;
  };
  error.browserCode = code;
  error.details = details;
  return error;
}

export function isBrowserCodedError(
  error: unknown
): error is Error & { browserCode: string; details?: Record<string, unknown> } {
  return (
    typeof error === "object"
    && error !== null
    && "browserCode" in error
    && typeof (error as { browserCode?: unknown }).browserCode === "string"
  );
}

export function normalizeSelector(selector: string): string {
  const trimmed = selector?.trim() ?? "";
  if (!trimmed) {
    throw createBrowserError("INVALID_REQUEST", "selector 不能为空");
  }
  if (trimmed.length > 500) {
    throw createBrowserError("INVALID_REQUEST", "selector 不能超过 500 字符");
  }
  return trimmed;
}

/** 规范化无障碍 role（Playwright getByRole 用） */
export function normalizeA11yRole(role: string): string {
  const trimmed = role?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    throw createBrowserError("INVALID_REQUEST", "role 不能为空");
  }
  if (trimmed.length > 80) {
    throw createBrowserError("INVALID_REQUEST", "role 不能超过 80 字符");
  }
  return trimmed;
}

/** 规范化无障碍可访问名（getByRole 的 name，exact 匹配） */
export function normalizeA11yName(name: string): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) {
    throw createBrowserError("INVALID_REQUEST", "name 不能为空");
  }
  if (trimmed.length > 200) {
    throw createBrowserError("INVALID_REQUEST", "name 不能超过 200 字符");
  }
  return trimmed;
}

/**
 * 点击/输入目标解析：selector 与 role+name 并存。
 * - 同时给 role 与 name → 走 getByRole
 * - 否则必须给 selector
 */
export function resolveActionTarget(
  page: Page,
  input: { selector?: string; role?: string; name?: string }
): { locator: ReturnType<Page["locator"]>; targetLabel: string; via: "selector" | "role" } {
  const roleRaw = typeof input.role === "string" ? input.role.trim() : "";
  const nameRaw = typeof input.name === "string" ? input.name.trim() : "";
  const hasRole = roleRaw.length > 0;
  const hasName = nameRaw.length > 0;

  if (hasRole !== hasName) {
    throw createBrowserError(
      "INVALID_REQUEST",
      "使用无障碍定位时必须同时提供 role 与 name",
      { role: roleRaw || undefined, name: nameRaw || undefined }
    );
  }

  if (hasRole && hasName) {
    const role = normalizeA11yRole(roleRaw);
    const name = normalizeA11yName(nameRaw);
    const locator = page.getByRole(role as Parameters<Page["getByRole"]>[0], {
      name,
      exact: true
    });
    const targetLabel = `role=${role}[name="${name}"]`;
    return { locator, targetLabel, via: "role" };
  }

  const selectorRaw = typeof input.selector === "string" ? input.selector : "";
  const selector = normalizeSelector(selectorRaw);
  return {
    locator: page.locator(selector),
    targetLabel: selector,
    via: "selector"
  };
}

/** 要求目标只命中一个元素 */
export async function assertSingleMatch(
  locator: { count: () => Promise<number> },
  targetLabel: string
) {
  const count = await locator.count();
  if (count === 0) {
    throw createBrowserError(
      "PARSE_FAILED",
      `未匹配到任何元素：${targetLabel}`,
      { selector: targetLabel, count }
    );
  }
  if (count > 1) {
    throw createBrowserError(
      "INVALID_REQUEST",
      `匹配到 ${count} 个元素，请收窄 selector 或改用更精确的 role+name：${targetLabel}`,
      { selector: targetLabel, count }
    );
  }
}

export function mapLocatorActionError(
  error: unknown,
  action: "click" | "type" | "waitFor",
  targetLabel: string
) {
  if (isBrowserCodedError(error)) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("waiting for")) {
    return createBrowserError(
      "TIMEOUT",
      `${action} 超时：${targetLabel}（${message}）`,
      { selector: targetLabel, action }
    );
  }
  return createBrowserError(
    "INTERNAL_ERROR",
    `${action} 失败：${message}`,
    { selector: targetLabel, action }
  );
}
