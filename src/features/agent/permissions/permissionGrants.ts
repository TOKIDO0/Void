import type { ToolMetadata } from "../tools/toolTypes";

/** 当前应用 profile 的显式工具授权；新增工具必须在对应阶段明确加入。 */
const CURRENT_APP_PERMISSION_GRANTS = new Set([
  "tool.echo",
  "tool.browser.open",
  "tool.browser.search",
  "tool.browser.readResult",
  "tool.browser.screenshot",
  "tool.browser.selectTarget",
  "tool.browser.reveal",
  "tool.browser.click",
  "tool.browser.type",
  "tool.browser.wait",
  "tool.browser.extract",
  "tool.browser.tabs",
  "tool.browser.switchTab",
  "tool.clipboard.read",
  "tool.clipboard.write",
  "tool.file.downloadToTemp",
  "tool.file.placeDownload",
  "tool.file.verify"
]);

export type PermissionGrants = ReadonlySet<string>;

export function getCurrentPermissionGrants(): PermissionGrants {
  return new Set(CURRENT_APP_PERMISSION_GRANTS);
}

export function hasToolPermissionGrants(
  tool: Pick<ToolMetadata, "permissions">,
  grants: PermissionGrants
): boolean {
  return tool.permissions.every((permission) => grants.has(permission));
}

export function listMissingToolPermissionGrants(
  tool: Pick<ToolMetadata, "permissions">,
  grants: PermissionGrants
): string[] {
  return tool.permissions.filter((permission) => !grants.has(permission));
}
