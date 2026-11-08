/**
 * 本机 bridge 鉴权失败分类（单一真源）。
 *
 * 根因（阶段 1 实测）：桌面端与 sidecar 的 token/来源不一致时，
 * bridge 返回 `BRIDGE_TOKEN_FORBIDDEN` / `ORIGIN_FORBIDDEN`。
 * 各工具共享映射的 default 分支会把它当成 internal_error + 可重试，
 * 于是模型会反复重试一个「重启服务才能好」的鉴权问题。
 *
 * 这里只提供判定与稳定文案；具体 ToolError 由各共享映射组装，
 * 保持 web/file/desktop/browser 四个 owner 的既有 details 字段不变。
 */

export const BRIDGE_AUTH_FAILURE_KIND = "bridge_auth_failed";

export const BRIDGE_AUTH_FAILURE_MESSAGE =
  "本机服务鉴权失败（token 不匹配或来源被拒绝）；请重启 VOID 桌面端或本机服务后再试，不要重复调用。";

export function isBridgeAuthFailureCode(code: string): boolean {
  return code === "BRIDGE_TOKEN_FORBIDDEN" || code === "ORIGIN_FORBIDDEN";
}
