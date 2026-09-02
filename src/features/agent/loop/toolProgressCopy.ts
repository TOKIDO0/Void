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
  "browser.longPress": "正在长按页面元素…",
  "browser.type": "正在输入内容…",
  "browser.waitFor": "正在等待页面就绪…",
  "browser.extract": "正在抽取页面内容…",
  "browser.tabs": "正在列出标签页…",
  "browser.switchTab": "正在切换标签页…",
  "clipboard.read": "正在读取剪贴板…",
  "clipboard.write": "正在写入剪贴板…",
  "desktop.revealPath": "正在资源管理器中展示路径…",
  "desktop.openKnownLocation": "正在打开此电脑…",
  "desktop.listInstalledApplications": "正在扫描已安装应用…",
  "desktop.launchApplication": "正在启动应用…",
  "file.downloadToTemp": "正在下载到临时目录…",
  "file.downloadMedia": "正在下载媒体…",
  "file.downloadMediaPage": "正在从媒体页下载视频…",
  "file.placeDownload": "正在保存到下载目录…",
  "file.verify": "正在校验文件…",
  "file.listDirectory": "正在列出目录…",
  "file.inspectPath": "正在检查路径…",
  "file.findByName": "正在按名称查找文件…",
  "file.listRecentArtifacts": "正在查看最近产物…",
  "file.readText": "正在读取文件内容…",
  "file.searchText": "正在搜索本地文本…",
  "file.inspectWriteTarget": "正在预检写入目标…",
  "file.createDirectory": "正在创建目录…",
  "file.move": "正在移动或重命名…",
  "file.writeText": "正在写入文本文件…",
  "file.organizeDirectory": "正在整理目录…",
  "file.createExcel": "正在生成 Excel…",
  "file.createPptx": "正在生成 PPT…",
  "file.createDocx": "正在生成 Word 文档…",
  "software.listSupported": "正在查看已支持的官方软件…",
  "software.resolveInstaller": "正在解析官方安装包信息…",
  "software.downloadInstaller": "正在下载并校验官方安装包…",
  "security.inspectLocalRuntime": "正在检查本地运行时安全配置…",
  "agent.inspectCapabilities": "正在整理当前可用能力…",
  "agent.planTaskRoute": "正在预演任务工具路线…",
  "agent.inspectToolContract": "正在检查工具契约…",
  "agent.inspectExtensionPolicy": "正在检查扩展机制安全边界…",
  "agent.inspectSafetyHooks": "正在检查动态安全确认规则…",
  "agent.inspectPrivacyBoundaries": "正在检查隐私与数据边界…",
  "agent.inspectTaskPlaybooks": "正在整理可用任务范式…",
  "agent.inspectSkills": "正在查看技能目录…",
  "agent.inspectWorkspace": "正在查看工作区结构…",
  "agent.runCode": "正在执行代码…",
  "agent.inspectMemoryVerification": "正在检查记忆自验…",
  echo: "正在执行内部校验…"
};

const TOOL_CONFIRM_LABELS: Record<string, string> = {
  "browser.selectTarget": "请确认要打开的目标",
  "file.downloadToTemp": "请确认是否下载该文件",
  "file.downloadMedia": "请确认是否下载该媒体",
  "file.downloadMediaPage": "请确认是否从该媒体页下载视频",
  "file.placeDownload": "请确认是否保存到下载目录",
  "clipboard.write": "请确认是否写入剪贴板",
  "browser.open": "请确认是否打开该页面",
  "browser.revealInSystemBrowser": "请确认是否用系统浏览器打开",
  "desktop.revealPath": "请确认是否在资源管理器中展示",
  "desktop.openKnownLocation": "请确认是否打开此电脑",
  "desktop.launchApplication": "请确认是否启动该应用",
  "file.createDirectory": "请确认是否创建目录",
  "file.move": "请确认是否移动或重命名",
  "file.writeText": "请确认是否写入文本文件",
  "file.organizeDirectory": "请确认是否整理该目录",
  "file.createExcel": "请确认是否生成该 Excel",
  "file.createPptx": "请确认是否生成该 PPT",
  "file.createDocx": "请确认是否生成该 Word 文档",
  "software.resolveInstaller": "请确认要解析的软件",
  "software.downloadInstaller": "请确认是否下载该官方安装包",
  "agent.runCode": "请确认是否执行该代码"
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

/**
 * 工具轮次/调用预算耗尽且未达终态时的用户可读收口。
 * 禁止再抛「工具循环超过 6 轮…」这种内部实现口吻。
 */
export function formatToolBudgetExhaustedMessage(params: {
  maxRounds: number;
  toolInvocationCount: number;
  lastToolName?: string;
  lastErrorCode?: string;
}): string {
  const rounds = Number.isFinite(params.maxRounds) && params.maxRounds > 0
    ? Math.floor(params.maxRounds)
    : 6;
  const tools = Number.isFinite(params.toolInvocationCount) && params.toolInvocationCount >= 0
    ? Math.floor(params.toolInvocationCount)
    : 0;
  const toolName = params.lastToolName?.trim() || "";
  const errorCode = params.lastErrorCode?.trim() || "";

  const parts = [
    "这轮工具操作没能完成。",
    `已尝试 ${rounds} 轮对话、执行工具 ${tools} 次，仍未拿到可汇报的最终结果。`
  ];

  if (toolName && errorCode) {
    parts.push(`最近卡在「${toolName}」（错误码：${errorCode}）。`);
  } else if (toolName) {
    parts.push(`最近卡在「${toolName}」。`);
  } else if (errorCode) {
    parts.push(`最近错误码：${errorCode}。`);
  }

  parts.push(
    "若是下载安装包：请提供可直接打开的文件直链（如 .exe/.msi/.zip），",
    "或换更具体的官网下载页；当前不会靠反复点击网页按钮自动完成下载。",
    "你也可以缩小任务后重试。"
  );

  return parts.join("");
}

function humanizeToolName(toolName: string) {
  const leaf = toolName.includes(".") ? toolName.split(".").pop() ?? toolName : toolName;
  return leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}
