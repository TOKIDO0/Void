// 工具错误净化：剥离结构化框架 token + 截断，防止不可信文件/网页内容污染 tool 消息。
// 对标 Hermes `model_tools.py:626-649 _sanitize_tool_error`（ironclaw#1639 移植），纯函数。

const TOOL_ERROR_ROLE_TAG_RE = /<\/?(?:tool_call|function_call|result|response|output|input|system|assistant|user)>/gi;
const TOOL_ERROR_FENCE_OPEN_RE = /^\s*```(?:json|xml|html|markdown)?\s*/gim;
const TOOL_ERROR_FENCE_CLOSE_RE = /\s*```\s*$/gim;
const TOOL_ERROR_CDATA_RE = /<!\[CDATA\[.*?\]\]>/gs;
const TOOL_ERROR_MAX_LEN = 2000;

export function sanitizeToolErrorMessage(message: string): string {
  const raw = typeof message === "string" ? message : String(message ?? "");
  if (!raw) {
    return "[TOOL_ERROR] ";
  }
  let sanitized = raw.replace(TOOL_ERROR_ROLE_TAG_RE, "");
  sanitized = sanitized.replace(TOOL_ERROR_FENCE_OPEN_RE, "");
  sanitized = sanitized.replace(TOOL_ERROR_FENCE_CLOSE_RE, "");
  sanitized = sanitized.replace(TOOL_ERROR_CDATA_RE, "");
  // 额外剥离常见 XML 角色混淆写法（<|im_start|> 等变体不在 Hermes 范围，保守不扩）
  sanitized = sanitized.trim();
  if (sanitized.length > TOOL_ERROR_MAX_LEN) {
    sanitized = sanitized.slice(0, TOOL_ERROR_MAX_LEN - 3) + "...";
  }
  return `[TOOL_ERROR] ${sanitized}`;
}

export const SANITIZE_TOOL_ERROR_MAX_LEN = TOOL_ERROR_MAX_LEN;
