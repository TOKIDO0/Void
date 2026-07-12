/**
 * 工具进度文案（阶段 F4）。
 *
 * 把内部 toolName 映射成用户能懂的短句，避免回复层刷「正在调用 browser.search…」。
 * 未知工具回退到中性描述，不暴露实现细节堆栈。
 */

const TOOL_PROGRESS_LABELS: Record<string, string> = {
  "browser.search": "正在搜索…",
  "browser.open": "正在打开自动化预览窗口…",
  "browser.readResult": "正在读取页面内容…",
  "browser.screenshot": "正在截取页面…",
  "browser.selectTarget": "正在确认搜索目标…",
  "browser.revealInSystemBrowser": "正在用系统浏览器打开给你看…",
  "browser.click": "正在点击页面元素…",
  "browser.type": "正在输入内容…",
  "browser.waitFor": "正在等待页面就绪…",
  "browser.extract": "正在抽取页面内容…",
  "browser.tabs": "正在列出标签页…",
  "browser.switchTab": "正在切换标签页…",
  "clipboard.read": "正在读取剪贴板…",
  "clipboard.write": "正在写入剪贴板…",
  "desktop.revealPath": "正在资源管理器中展示路径…",
  "file.downloadToTemp": "正在下载到临时目录…",
  "file.placeDownload": "正在保存到下载目录…",
  "file.verify": "正在校验文件…",
  "file.listDirectory": "正在列出目录…",
  "file.readText": "正在读取文本…",
  "file.createDirectory": "正在创建目录…",
  "file.move": "正在移动或重命名…",
  echo: "正在执行内部校验…"
};

const TOOL_CONFIRM_LABELS: Record<string, string> = {
  "browser.selectTarget": "请确认要打开的目标",
  "file.downloadToTemp": "请确认是否下载该文件",
  "file.placeDownload": "请确认是否保存到下载目录",
  "clipboard.write": "请确认是否写入剪贴板",
  "browser.open": "请确认是否打开该页面",
  "browser.revealInSystemBrowser": "请确认是否用系统浏览器打开",
  "desktop.revealPath": "请确认是否在资源管理器中展示",
  "file.createDirectory": "请确认是否创建目录",
  "file.move": "请确认是否移动或重命名"
};

/** 执行中进度 */
export function formatToolProgressMessage(toolName: string): string {
  return TOOL_PROGRESS_LABELS[toolName] ?? `正在处理：${humanizeToolName(toolName)}…`;
}

/** 等待确认 */
export function formatToolConfirmWaitMessage(toolName: string): string {
  const specific = TOOL_CONFIRM_LABELS[toolName];
  if (specific) {
    return `${specific}。你可以说「好」或「取消」。`;
  }
  return `需要你确认：${humanizeToolName(toolName)}。你可以说「好」或「取消」。`;
}

/**
 * 同工具连续失败/空转熔断后的用户可读收口文案。
 * 必须点明工具名 + 错误码，避免只说「遇到问题」。
 */
export function formatSameToolStreakCloseMessage(
  toolName: string,
  errorCode: string,
  streakCount: number
): string {
  const safeToolName = toolName.trim() || "未知工具";
  const safeCode = errorCode.trim() || "EXECUTION_FAILED";
  const safeCount = Number.isFinite(streakCount) && streakCount > 0
    ? Math.floor(streakCount)
    : 1;
  const progressHint = TOOL_PROGRESS_LABELS[safeToolName]
    ? `（${TOOL_PROGRESS_LABELS[safeToolName].replace(/…$/, "")}）`
    : "";
  return [
    `刚才连续 ${safeCount} 次调用「${safeToolName}」${progressHint}都没推进`,
    `（错误码：${safeCode}），已停止重复尝试。`,
    "请换一种说法，或检查本机相关服务后重试。"
  ].join("");
}

function humanizeToolName(toolName: string) {
  const leaf = toolName.includes(".") ? toolName.split(".").pop() ?? toolName : toolName;
  return leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}
