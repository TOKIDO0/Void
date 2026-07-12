/**
 * Q5：工具成功摘要文案表。
 * 从 toolExecutor 拆出，避免 summary 分支继续堆在执行器里。
 */

/**
 * 把工具输出压成一行可读摘要（日志 / 终态话术）。
 */
export function buildToolSuccessSummary(toolName: string, output: unknown): string {
  if (!output || typeof output !== "object") {
    return `${toolName} 执行成功`;
  }

  const record = output as Record<string, unknown>;

  if ("echoed" in record) {
    const echoed = String(record.echoed);
    return `${toolName} 完成：${echoed.slice(0, 80)}`;
  }

  if (toolName === "browser.search" && Array.isArray(record.results)) {
    const query = typeof record.query === "string" ? record.query : "";
    return `${toolName} 完成：${query}（${record.results.length} 条）`;
  }

  if (toolName === "browser.readResult" && Array.isArray(record.results)) {
    return `${toolName} 完成：${record.results.length} 条结果`;
  }

  if (toolName === "browser.open" && typeof record.finalUrl === "string") {
    const title = typeof record.title === "string" ? record.title : "";
    return `${toolName} 完成：${title || record.finalUrl}`.slice(0, 120);
  }

  if (toolName === "browser.screenshot" && typeof record.path === "string") {
    return `${toolName} 完成：${record.path}`;
  }

  if (toolName === "browser.selectTarget" && typeof record.title === "string") {
    return `${toolName} 完成：已确认「${String(record.title).slice(0, 60)}」`;
  }

  if (toolName === "browser.tabs" && typeof record.count === "number") {
    return `${toolName} 完成：${record.count} 个标签页`;
  }

  if (toolName === "browser.switchTab" && typeof record.title === "string") {
    return `${toolName} 完成：${String(record.title).slice(0, 80)}`;
  }

  if (toolName === "file.downloadToTemp" && typeof record.tempPath === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
    const bytes = record.bytes ?? "?";
    return `${toolName} 完成：${fileName || record.tempPath}（${mediaKind}, ${String(bytes)} bytes）→ ${record.tempPath}`;
  }

  if (toolName === "file.placeDownload" && typeof record.finalPath === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
    const bytes = record.bytes ?? "?";
    return `${toolName} 完成：${fileName || record.finalPath}（${mediaKind}, ${String(bytes)} bytes）→ ${record.finalPath}`;
  }

  if (toolName === "file.verify") {
    if (record.exists) {
      const fileName = typeof record.fileName === "string" ? record.fileName : "";
      const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
      const bytes = record.bytes ?? "?";
      return `${toolName} 完成：${fileName || "已存在"}（${mediaKind}, ${String(bytes)} bytes）`;
    }
    return `${toolName} 完成：文件不存在`;
  }

  if (toolName === "file.createDirectory" && typeof record.path === "string") {
    return `${toolName} 完成：${record.path}`;
  }

  if (toolName === "file.move" && typeof record.destinationPath === "string") {
    return `${toolName} 完成：${String(record.sourcePath)} → ${record.destinationPath}`;
  }

  if (toolName === "clipboard.read") {
    if (record.empty) {
      return `${toolName} 完成：剪贴板为空`;
    }
    const length = record.length ?? "?";
    const truncated = record.truncated ? "，已截断" : "";
    return `${toolName} 完成：${String(length)} 字符${truncated}`;
  }

  if (toolName === "clipboard.write") {
    return `${toolName} 完成：已写入 ${String(record.length ?? "?")} 字符`;
  }

  return `${toolName} 执行成功`;
}
