const USER_FACING_HIDDEN_TOOLS = new Set([
  "echo",
  "browser.screenshot",
  "browser.readResult"
]);

export function isToolHiddenFromUserFacingCapabilities(toolName: string): boolean {
  return USER_FACING_HIDDEN_TOOLS.has(toolName.trim());
}

export function countUserFacingHiddenTools(toolNames: string[]): number {
  return toolNames.filter(isToolHiddenFromUserFacingCapabilities).length;
}

export function describeToolVisibilityHiddenReason(toolName: string): string | null {
  if (!isToolHiddenFromUserFacingCapabilities(toolName)) {
    return null;
  }

  if (toolName === "echo") {
    return "内部冒烟/诊断工具，不作为普通用户能力展示。";
  }
  if (toolName === "browser.screenshot" || toolName === "browser.readResult") {
    return "低频内部浏览器辅助工具，避免模型在普通任务里空转截图或重复读取。";
  }

  return "内部工具，不作为普通用户能力展示。";
}
