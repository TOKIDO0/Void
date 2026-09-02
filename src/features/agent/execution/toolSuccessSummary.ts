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

  if (toolName === "software.listSupported" && typeof record.count === "number") {
    return `${toolName} 完成：已登记 ${record.count} 款官方软件`;
  }

  if (toolName === "software.resolveInstaller" && typeof record.displayName === "string") {
    const ready = record.canAutoDownload === true ? "可自动下载" : "适配器未就绪";
    return `${toolName} 完成：${record.displayName}（${ready}）`;
  }

  if (toolName === "software.downloadInstaller" && typeof record.finalPath === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const bytes = record.bytes ?? "?";
    const signature =
      typeof record.signatureStatus === "string" ? record.signatureStatus : "";
    const signaturePart = signature ? `，签名 ${signature}` : "";
    return `${toolName} 完成：${fileName || record.finalPath}（${String(bytes)} bytes${signaturePart}）→ ${record.finalPath}`;
  }

  if (toolName === "security.inspectLocalRuntime" && typeof record.overall === "string") {
    const checks = Array.isArray(record.checks) ? record.checks : [];
    const failedChecks = checks.filter(
      (check) => typeof check === "object"
        && check !== null
        && (check as { ok?: unknown }).ok === false
    );
    return `${toolName} 完成：整体 ${record.overall}，${checks.length - failedChecks.length}/${checks.length} 项通过`;
  }

  if (toolName === "agent.inspectCapabilities" && typeof record.capabilityCount === "number") {
    const toolCount = typeof record.toolCount === "number" ? record.toolCount : "?";
    return `${toolName} 完成：${record.capabilityCount} 类能力，${String(toolCount)} 个用户可见工具`;
  }

  if (toolName === "agent.planTaskRoute" && typeof record.capability === "string") {
    const toolCount = Array.isArray(record.availableToolNames)
      ? record.availableToolNames.length
      : "?";
    return `${toolName} 完成：${record.capability} 路由，${String(toolCount)} 个可用工具（未执行）`;
  }

  if (toolName === "agent.inspectToolContract" && typeof record.status === "string") {
    const normalizedToolName =
      typeof record.normalizedToolName === "string" ? record.normalizedToolName : "未知工具";
    if (record.status === "not_found") {
      return `${toolName} 完成：未找到 ${normalizedToolName}`;
    }
    const tool = record.tool;
    const risk =
      tool && typeof tool === "object" && typeof (tool as { riskLevel?: unknown }).riskLevel === "string"
        ? (tool as { riskLevel: string }).riskLevel
        : "?";
    return `${toolName} 完成：${normalizedToolName}（风险 ${risk}）`;
  }

  if (toolName === "agent.inspectExtensionPolicy" && typeof record.executableExtensionRuntime === "string") {
    const detectedCount = Array.isArray(record.detectedExtensionToolNames)
      ? record.detectedExtensionToolNames.length
      : "?";
    return `${toolName} 完成：扩展运行时 ${record.executableExtensionRuntime}，检测到 ${String(detectedCount)} 个扩展工具`;
  }

  if (toolName === "agent.inspectSafetyHooks" && typeof record.hookCount === "number") {
    return `${toolName} 完成：${record.hookCount} 条动态安全确认规则`;
  }

  if (toolName === "agent.inspectPrivacyBoundaries" && typeof record.ruleCount === "number") {
    return `${toolName} 完成：${record.ruleCount} 条隐私与数据边界规则`;
  }

  if (toolName === "agent.inspectTaskPlaybooks" && typeof record.playbookCount === "number") {
    const availableCount =
      typeof record.availablePlaybookCount === "number" ? record.availablePlaybookCount : "?";
    return `${toolName} 完成：${String(availableCount)}/${record.playbookCount} 个任务范式可用`;
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

  if (toolName === "file.inspectPath" && typeof record.path === "string") {
    const exists = record.exists === true ? "存在" : "不存在";
    const kind = typeof record.kind === "string" ? record.kind : "unknown";
    const readable = record.readTextLikelySupported === true ? "可尝试读取文本" : "不建议直接读文本";
    return `${toolName} 完成：${record.path}（${exists}，${kind}，${readable}）`;
  }

  if (toolName === "file.findByName" && typeof record.path === "string") {
    const query = typeof record.query === "string" ? record.query : "";
    const matchCount = record.matchCount ?? "?";
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${record.path} 查找「${query.slice(0, 40)}」（${String(matchCount)} 项${truncated}）`;
  }

  if (toolName === "file.listRecentArtifacts" && typeof record.rootPath === "string") {
    const count = typeof record.count === "number" ? record.count : 0;
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${record.rootPath} 最近 ${count} 项${truncated}`;
  }

  if (toolName === "file.readText" && typeof record.path === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const characters = record.characters ?? "?";
    const sourceKind = typeof record.sourceKind === "string" ? `${record.sourceKind}, ` : "";
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${fileName || record.path}（${sourceKind}${String(characters)} 字${truncated}）`;
  }

  if (toolName === "file.searchText" && typeof record.path === "string") {
    const query = typeof record.query === "string" ? record.query : "";
    const matchCount = record.matchCount ?? "?";
    const filesMatched = record.filesMatched ?? "?";
    const truncated = record.truncated === true ? "，已截断" : "";
    return `${toolName} 完成：${record.path} 搜索「${query.slice(0, 40)}」（${String(matchCount)} 条，${String(filesMatched)} 个文件${truncated}）`;
  }

  if (toolName === "file.inspectWriteTarget" && typeof record.resolvedPath === "string") {
    const policy = typeof record.conflictPolicy === "string" ? record.conflictPolicy : "?";
    const writable = record.writable === true ? "可写入" : "会被阻止";
    const action =
      record.wouldOverwrite === true
        ? "覆盖"
        : record.wouldRename === true
          ? "自动改名"
          : "创建";
    return `${toolName} 完成：${writable}，策略 ${policy} 将${action} → ${record.resolvedPath}`;
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

  if (toolName === "file.writeText" && typeof record.path === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const characters = record.characters ?? "?";
    const bytes = record.bytes ?? "?";
    const renamed = record.renamedForConflict === true ? "，冲突已自动改名" : "";
    const overwritten = record.overwritten === true ? "，已覆盖旧文件" : "";
    return `${toolName} 完成：${fileName || record.path}（${String(characters)} 字, ${String(bytes)} bytes）→ ${record.path}${renamed}${overwritten}`;
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

  if (toolName === "agent.runCode") {
    const language = typeof record.language === "string" ? record.language : "?";
    const timedOut = record.timedOut === true ? "，已超时" : "";
    const truncated = record.truncated === true ? "，已截断" : "";
    const exitCode = record.exitCode ?? "?";
    const stdout = typeof record.stdout === "string" ? record.stdout.slice(0, 60) : "";
    const preview = stdout ? `：${stdout.replace(/\n/g, " ").slice(0, 60)}` : "";
    return `${toolName} 完成：${language}（exit ${String(exitCode)}${timedOut}${truncated}）${preview}`;
  }

  if (toolName === "file.organizeDirectory" && typeof record.path === "string") {
    const movedCount = typeof record.movedCount === "number" ? record.movedCount : 0;
    const totalFiles = typeof record.totalFiles === "number" ? record.totalFiles : 0;
    const dryRun = record.dryRun === true ? "（预演）" : "";
    return `${toolName} 完成：${record.path}${dryRun} ${movedCount}/${totalFiles} 个文件已整理`;
  }

  if (toolName === "file.createExcel" && typeof record.fileName === "string") {
    return `${toolName} 完成：${record.fileName}（${String(record.sheets ?? "?")} 个 Sheet）→ ${String(record.path ?? "")}`;
  }

  if (toolName === "file.createPptx" && typeof record.fileName === "string") {
    return `${toolName} 完成：${record.fileName}（${String(record.slides ?? "?")} 张）→ ${String(record.path ?? "")}`;
  }

  if (toolName === "file.createDocx" && typeof record.fileName === "string") {
    return `${toolName} 完成：${record.fileName}（${String(record.sections ?? "?")} 节）→ ${String(record.path ?? "")}`;
  }

  return `${toolName} 执行成功`;
}
