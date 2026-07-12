/**
 * Q5：L2/L3 确认文案表（对话循环与任务计划器共用）。
 * 必须说清「做什么 / 作用对象 / 可能结果」，禁止裸「确定」。
 */

import type { RiskLevel } from "../tools";

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/**
 * 根据工具名与输入生成确认描述。
 * @param stepTitle 任务计划步骤标题（仅 fallback 用）
 */
export function buildToolConfirmationDescription(
  toolName: string,
  riskLevel: RiskLevel,
  input: unknown,
  stepTitle?: string
): string {
  const record = asRecord(input);

  if (toolName === "browser.selectTarget") {
    const title = typeof record.title === "string" ? record.title : "(未命名目标)";
    const url = typeof record.url === "string" ? record.url : "";
    const rank = typeof record.rank === "number" ? record.rank : undefined;
    return [
      `将确认搜索结果目标（风险 ${riskLevel}）。`,
      rank ? `候选序号：#${rank}` : undefined,
      `标题：${title}`,
      url ? `URL：${url}` : undefined,
      "确认后才会打开该页面并进入后续下载流程；拒绝则任务停止。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (toolName === "file.placeDownload") {
    const tempPath = typeof record.tempPath === "string" ? record.tempPath : "";
    const destinationDirectory =
      typeof record.destinationDirectory === "string" ? record.destinationDirectory : "";
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "";
    const bytes = typeof record.bytes === "number" ? record.bytes : undefined;
    const overwritePolicy =
      typeof record.overwritePolicy === "string" ? record.overwritePolicy : "refuse";
    const inferredName =
      fileName
      || (tempPath ? tempPath.split(/[/\\]/).pop() ?? "" : "");
    return [
      `将把已下载的临时文件移动到最终目录（风险 ${riskLevel}）。`,
      tempPath ? `临时文件：${tempPath}` : undefined,
      destinationDirectory ? `目标目录：${destinationDirectory}` : undefined,
      inferredName ? `文件名：${inferredName}` : undefined,
      mediaKind ? `类型：${mediaKind}` : undefined,
      bytes !== undefined ? `大小：${bytes} bytes` : undefined,
      `覆盖策略：${overwritePolicy}（refuse=已存在则失败 / overwrite=覆盖 / rename=自动改名）`,
      "确认后才会写入最终目录；拒绝则保留临时文件且不落盘。目录须在本机下载白名单内。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (toolName === "file.downloadToTemp") {
    const url = typeof record.url === "string" ? record.url : "";
    const suggestedFileName =
      typeof record.suggestedFileName === "string" ? record.suggestedFileName : "";
    return [
      `将下载文件到任务临时目录（风险 ${riskLevel}）。`,
      url ? `来源 URL：${url}` : undefined,
      suggestedFileName ? `建议文件名：${suggestedFileName}` : undefined,
      "文件先进入隔离临时目录，不会直接写入最终目录；仍请确认来源可信。适用于任意类型资源。"
    ]
      .filter(Boolean)
      .join("\n");
  }


  if (toolName === "file.downloadMediaPage") {
    const pageUrl = typeof record.pageUrl === "string" ? record.pageUrl : "";
    const suggestedFileName =
      typeof record.suggestedFileName === "string" ? record.suggestedFileName : "";
    return [
      `将从受支持的媒体页下载视频到任务临时目录（风险 ${riskLevel}）。`,
      pageUrl ? `媒体页：${pageUrl}` : undefined,
      suggestedFileName ? `建议文件名：${suggestedFileName}` : undefined,
      "首期仅支持 B 站视频页；依赖本机 yt-dlp。文件先进入隔离临时目录，不会直接写入最终目录。",
      "确认后开始下载；拒绝则不会拉取媒体。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (toolName === "file.createDirectory") {
    const path = typeof record.path === "string" ? record.path : "";
    return [
      `将在允许根内创建目录（风险 ${riskLevel}）。`,
      path ? `完整路径：${path}` : undefined,
      "只创建这一层目录；父目录必须已存在，拒绝则不会写入。"
    ].filter(Boolean).join("\n");
  }

  if (toolName === "file.move") {
    const sourcePath = typeof record.sourcePath === "string" ? record.sourcePath : "";
    const destinationPath = typeof record.destinationPath === "string" ? record.destinationPath : "";
    const conflictPolicy = typeof record.conflictPolicy === "string"
      ? record.conflictPolicy
      : "refuse";
    return [
      `将在允许根内移动或重命名目标（风险 ${riskLevel}）。`,
      sourcePath ? `源路径：${sourcePath}` : undefined,
      destinationPath ? `目标路径：${destinationPath}` : undefined,
      `冲突策略：${conflictPolicy}（refuse=拒绝 / rename=自动改名；绝不覆盖）`,
      "仅支持同盘原子移动；拒绝则源路径保持不变。"
    ].filter(Boolean).join("\n");
  }

  if (toolName === "desktop.revealPath") {
    const path = typeof record.path === "string" ? record.path : "";
    return [
      `将在 Windows 资源管理器中展示路径（风险 ${riskLevel}）。`,
      path ? `完整路径：${path}` : undefined,
      "目录会打开，文件会选中显示；绝不执行目标文件。拒绝则不会启动资源管理器。"
    ].filter(Boolean).join("\n");
  }

  if (toolName === "desktop.openKnownLocation") {
    return [
      `将在 Windows 资源管理器中打开“此电脑”（风险 ${riskLevel}）。`,
      "该工具只接受固定枚举 this_pc，不会执行任意程序、路径或命令。拒绝则不会启动资源管理器。"
    ].join("\n");
  }

  if (toolName === "browser.open") {
    const url = typeof record.url === "string" ? record.url : "";
    return [
      `将在自动化窗口打开网页（风险 ${riskLevel}）。`,
      url ? `URL：${url}` : undefined,
      "这不是你的日常浏览器；若要在常用浏览器查看，打开后还需 revealInSystemBrowser。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (toolName === "clipboard.write") {
    const text = typeof record.text === "string" ? record.text : "";
    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    return [
      `将覆盖写入本机系统剪贴板（风险 ${riskLevel}）。`,
      `长度：${text.length} 字符`,
      preview ? `预览：${preview}` : "内容为空（将清空剪贴板文本）",
      "确认后会替换当前剪贴板文本；拒绝则不改动剪贴板。请勿写入密码等敏感凭证。"
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (stepTitle) {
    return `即将执行步骤「${stepTitle}」（工具 ${toolName}，风险 ${riskLevel}）。请确认是否继续。`;
  }

  return `即将执行工具「${toolName}」（风险 ${riskLevel}）。请确认是否继续；拒绝则不会执行该步。`;
}
