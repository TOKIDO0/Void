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


  if (toolName === "file.downloadMediaPage" && typeof record.tempPath === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
    const bytes = record.bytes ?? "?";
    const pageUrl = typeof record.pageUrl === "string" ? record.pageUrl : "";
    return `${toolName} 完成：${fileName || record.tempPath}（${mediaKind}, ${String(bytes)} bytes）${pageUrl ? ` 来自 ${pageUrl}` : ""} → ${record.tempPath}`;
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

  // 本地整理链：list / read / create / move / reveal 都要可读，禁止退回泛化「执行成功」
  if (toolName === "file.listDirectory" && typeof record.path === "string") {
    const count = typeof record.count === "number" ? record.count : 0;
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${record.path}（${count} 项${truncated}）`;
  }

  if (toolName === "file.readText" && typeof record.path === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const characters = record.characters ?? "?";
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${fileName || record.path}（${String(characters)} 字${truncated}）`;
  }

  if (toolName === "file.createDirectory" && typeof record.path === "string") {
    return `${toolName} 完成：已创建目录 ${record.path}`;
  }

  if (toolName === "file.move" && typeof record.destinationPath === "string") {
    const sourcePath = typeof record.sourcePath === "string" ? record.sourcePath : "?";
    const renamed = record.renamedForConflict === true ? "，冲突已自动改名" : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "";
    const bytes = typeof record.bytes === "number" ? record.bytes : undefined;
    const meta =
      mediaKind || bytes !== undefined
        ? `（${mediaKind || "unknown"}${bytes !== undefined ? `, ${bytes} bytes` : ""}）`
        : "";
    return `${toolName} 完成：${sourcePath} → ${record.destinationPath}${meta}${renamed}`;
  }

  if (toolName === "desktop.revealPath" && typeof record.revealedPath === "string") {
    const openMode = typeof record.openMode === "string" ? record.openMode : "open";
    const modeLabel = openMode === "select" ? "已选中文件" : "已打开目录";
    return `${toolName} 完成：${modeLabel} ${record.revealedPath}`;
  }

  if (toolName === "desktop.openKnownLocation" && record.location === "this_pc") {
    return `${toolName} 完成：已打开 Windows 此电脑`;
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
