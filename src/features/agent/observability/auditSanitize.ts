// 日志脱敏：禁止把 API Key / Cookie / 令牌 / 密码写入执行日志。

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|cookie|session|credential|private[_-]?key)/i;

const REDACTED = "[REDACTED]";

/**
 * 深度脱敏对象。命中敏感 key 或疑似密钥字符串时替换为占位符。
 */
export function sanitizeForAudit(
  value: unknown,
  extraRedactKeys: string[] = [],
  depth = 0
): unknown {
  if (depth > 6) {
    return "[TRUNCATED_DEPTH]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return looksLikeSecret(value) ? REDACTED : clipString(value, 500);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeForAudit(item, extraRedactKeys, depth + 1));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key, extraRedactKeys)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeForAudit(child, extraRedactKeys, depth + 1);
      }
    }
    return result;
  }

  return String(value);
}

export function isSensitiveKey(key: string, extraRedactKeys: string[] = []) {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }
  return extraRedactKeys.some((item) => item.toLowerCase() === key.toLowerCase());
}

function looksLikeSecret(value: string) {
  if (value.length < 16) {
    return false;
  }
  // 粗略识别 JWT / 长 hex / sk- 前缀密钥，避免日志误存。
  if (/^sk-[A-Za-z0-9_-]{10,}$/.test(value)) {
    return true;
  }
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value)) {
    return true;
  }
  if (/^[A-Fa-f0-9]{32,}$/.test(value)) {
    return true;
  }
  return false;
}

function clipString(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}
