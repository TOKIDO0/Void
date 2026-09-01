import type { ToolMetadata } from "../tools/toolTypes";

/** 当前应用 profile 的显式工具授权；新增工具必须在对应阶段明确加入。 */
const CURRENT_APP_PERMISSION_GRANTS = new Set([
  "tool.echo",
  "tool.agent.inspectCapabilities",
  "tool.agent.planTaskRoute",
  "tool.agent.inspectToolContract",
  "tool.agent.inspectExtensionPolicy",
  "tool.agent.inspectSafetyHooks",
  "tool.agent.inspectPrivacyBoundaries",
  "tool.agent.inspectTaskPlaybooks",
  "tool.agent.inspectSkills",
  "tool.agent.inspectMemoryVerification",
  "tool.browser.open",
  "tool.browser.search",
  "tool.browser.readResult",
  "tool.browser.screenshot",
  "tool.browser.selectTarget",
  "tool.browser.reveal",
  "tool.browser.click",
  "tool.browser.longPress",
  "tool.browser.type",
  "tool.browser.wait",
  "tool.browser.extract",
  "tool.browser.tabs",
  "tool.browser.switchTab",
  "tool.clipboard.read",
  "tool.clipboard.write",
  "tool.desktop.revealPath",
  "tool.desktop.openKnownLocation",
  "tool.desktop.listInstalledApplications",
  "tool.desktop.launchApplication",
  "tool.file.downloadMedia",
  "tool.file.downloadToTemp",
  "tool.file.downloadMediaPage",
  "tool.file.placeDownload",
  "tool.file.verify",
  "tool.file.listDirectory",
  "tool.file.inspectPath",
  "tool.file.findByName",
  "tool.file.listRecentArtifacts",
  "tool.file.readText",
  "tool.file.searchText",
  "tool.file.inspectWriteTarget",
  "tool.file.createDirectory",
  "tool.file.move",
  "tool.file.writeText",
  "tool.file.organizeDirectory",
  "tool.file.createExcel",
  "tool.file.createPptx",
  "tool.file.createDocx",
  "tool.security.inspectLocalRuntime",
  "tool.software.listSupported",
  "tool.software.resolveInstaller",
  "tool.software.downloadInstaller"
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
