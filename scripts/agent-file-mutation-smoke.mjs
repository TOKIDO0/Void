import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectFileError(work, expectedCode) {
  try {
    work();
  } catch (error) {
    assert(error?.fileCode === expectedCode, `期望 ${expectedCode}，实际 ${error?.fileCode}`);
    return;
  }
  throw new Error(`预期失败 ${expectedCode}，实际成功`);
}

async function expectFileErrorAsync(work, expectedCode) {
  try {
    await work();
  } catch (error) {
    assert(error?.fileCode === expectedCode, `期望 ${expectedCode}，实际 ${error?.fileCode}`);
    return;
  }
  throw new Error(`预期失败 ${expectedCode}，实际成功`);
}

async function startDownloadFixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/redirect.txt") {
      response.statusCode = 302;
      response.setHeader("Location", "/sample.txt");
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("download safety sample");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "下载 fixture server 未拿到端口");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-mutation-root-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-mutation-outside-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const alternateRoot = "D:\\AI\\void-runtime";
  if (existsSync(alternateRoot)) {
    process.env.VOID_FILE_ALLOW_ROOTS = alternateRoot;
  }
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const { fileMutationManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileMutationManager.ts")).href
    );
    const { fileDownloadManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileDownloadManager.ts")).href
    );
    const { fileAccessManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileAccessManager.ts")).href
    );
    const { fetchWithPublicDownloadGuard } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/httpDownloadSafety.ts")).href
    );
    const { ensureRuntimeDirectories, resolveInboxRoot, resolveRuntimeRoot } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileRuntimePaths.ts")).href
    );

    const workspace = path.join(runtimeRoot, "workspace");
    mkdirSync(workspace);
    const createdPath = path.join(workspace, "created");
    assert(fileMutationManager.createDirectory(createdPath).created, "应创建一层目录");
    expectFileError(
      () => fileMutationManager.createDirectory(path.join(workspace, "missing", "deep")),
      "FILE_NOT_FOUND"
    );

    const source = path.join(workspace, "source.txt");
    const moved = path.join(workspace, "moved.txt");
    writeFileSync(source, "move sample", "utf8");
    const movedResult = fileMutationManager.move(source, moved, "refuse");
    assert(!existsSync(source) && fileDownloadManager.verify(moved).exists, "移动后源消失且目标可验证");
    assert(movedResult.bytes > 0 && movedResult.mediaKind === "text", "移动结果应含 bytes/mediaKind");

    const conflictSource = path.join(workspace, "conflict-source.txt");
    const conflictTarget = path.join(workspace, "conflict.txt");
    writeFileSync(conflictSource, "source", "utf8");
    writeFileSync(conflictTarget, "target", "utf8");
    expectFileError(
      () => fileMutationManager.move(conflictSource, conflictTarget, "refuse"),
      "DESTINATION_EXISTS"
    );
    assert(existsSync(conflictSource), "冲突拒绝后源文件必须保持不变");
    const renamed = fileMutationManager.move(conflictSource, conflictTarget, "rename");
    assert(renamed.renamedForConflict && existsSync(renamed.destinationPath), "rename 策略应生成新目标");
    assert(existsSync(conflictTarget), "rename 策略不得覆盖原目标");

    const newWriteTarget = path.join(workspace, "write-preview-new.md");
    const newWriteTargetInspection = fileMutationManager.inspectTextWriteTarget(newWriteTarget, "refuse");
    assert(newWriteTargetInspection.writable, "新文本文件预检应允许写入");
    assert(newWriteTargetInspection.wouldCreate, "新文本文件预检应标记为将创建");
    assert(!newWriteTargetInspection.targetExists, "新文本文件预检应识别目标不存在");
    assert(newWriteTargetInspection.resolvedPath === newWriteTarget, "新文本文件预检不应改写目标路径");
    assert(!existsSync(newWriteTarget), "写入目标预检不得创建新文件");

    const refuseWriteTargetInspection = fileMutationManager.inspectTextWriteTarget(conflictTarget, "refuse");
    assert(!refuseWriteTargetInspection.writable, "已存在文本文件 + refuse 预检应标记不可写");
    assert(refuseWriteTargetInspection.blockingCode === "DESTINATION_EXISTS", "已存在文本文件 + refuse 应返回 DESTINATION_EXISTS");
    assert(!refuseWriteTargetInspection.wouldOverwrite, "refuse 预检不得标记覆盖");

    const renameWriteTargetInspection = fileMutationManager.inspectTextWriteTarget(conflictTarget, "rename");
    assert(renameWriteTargetInspection.writable, "已存在文本文件 + rename 预检应允许写入");
    assert(renameWriteTargetInspection.wouldRename, "已存在文本文件 + rename 预检应标记改名");
    assert(renameWriteTargetInspection.resolvedPath !== conflictTarget, "rename 预检应给出新目标路径");
    assert(!existsSync(renameWriteTargetInspection.resolvedPath), "rename 预检不得创建改名后的文件");

    expectFileError(
      () => fileMutationManager.inspectTextWriteTarget(path.join(workspace, "blocked.exe"), "refuse"),
      "INVALID_REQUEST"
    );

    const editFile = path.join(workspace, "edit-me.md");
    writeFileSync(editFile, "# Title\nhello world\nbye world\n", "utf8");
    expectFileError(
      () => fileMutationManager.editText(editFile, "world", "x"),
      "EDIT_AMBIGUOUS"
    );
    assert(
      readFileSync(editFile, "utf8") === "# Title\nhello world\nbye world\n",
      "歧义拒绝后文件必须保持不变"
    );
    const edited = fileMutationManager.editText(editFile, "hello world", "hello VOID");
    assert(edited.replacements === 1, "行级编辑应恰好替换一处");
    assert(
      readFileSync(editFile, "utf8") === "# Title\nhello VOID\nbye world\n",
      "行级编辑后文件内容应正确且其余部分不动"
    );
    expectFileError(
      () => fileMutationManager.editText(editFile, "missing-needle-xyz", "x"),
      "EDIT_TARGET_NOT_FOUND"
    );
    assert(
      readFileSync(editFile, "utf8").includes("hello VOID"),
      "未命中拒绝后文件必须保持不变"
    );
    const blockedEdit = path.join(workspace, "blocked-edit.exe");
    writeFileSync(blockedEdit, "binary-ish", "utf8");
    expectFileError(
      () => fileMutationManager.editText(blockedEdit, "a", "b"),
      "INVALID_REQUEST"
    );
    const outsideEdit = path.join(outsideRoot, "outside.txt");
    writeFileSync(outsideEdit, "outside", "utf8");
    expectFileError(
      () => fileMutationManager.editText(outsideEdit, "outside", "x"),
      "PATH_NOT_ALLOWED"
    );
    assert(
      readFileSync(outsideEdit, "utf8") === "outside",
      "根外拒绝后外部文件必须保持不变"
    );

    const inspectNote = path.join(workspace, "inspect-note.md");
    writeFileSync(inspectNote, "inspect path smoke", "utf8");
    const inspectedFile = fileAccessManager.inspectPath(inspectNote);
    assert(inspectedFile.exists, "inspectPath should report existing files");
    assert(inspectedFile.kind === "file", "inspectPath should classify regular files");
    assert(inspectedFile.bytes === 18, "inspectPath should expose file byte size");
    assert(inspectedFile.extension === ".md", "inspectPath should expose extension");
    assert(inspectedFile.mediaKind === "text", "inspectPath should classify text media");
    assert(inspectedFile.readTextLikelySupported, "inspectPath should mark markdown as likely readable");
    assert(inspectedFile.readTextSizeAllowed, "inspectPath should mark small markdown as size-allowed");
    assert(!("content" in inspectedFile), "inspectPath should not expose file content");

    const inspectedDirectory = fileAccessManager.inspectPath(workspace);
    assert(inspectedDirectory.exists && inspectedDirectory.kind === "directory", "inspectPath should classify directories");
    assert(!inspectedDirectory.readTextLikelySupported, "inspectPath should not mark directories as readable text");

    const inspectedMissing = fileAccessManager.inspectPath(path.join(workspace, "missing-note.md"));
    assert(!inspectedMissing.exists && inspectedMissing.kind === "missing", "inspectPath should report missing allowed-root paths");

    const sensitivePath = path.join(workspace, ".env");
    writeFileSync(sensitivePath, "TOKEN=secret", "utf8");
    const inspectedSensitive = fileAccessManager.inspectPath(sensitivePath);
    assert(inspectedSensitive.sensitiveHint, "inspectPath should flag sensitive file names");
    assert(
      inspectedSensitive.safetyNotes.some((note) => note.includes("敏感凭据")),
      "inspectPath should explain sensitive-path confirmation"
    );

    const inspectedLinkPath = path.join(workspace, "inspect-link");
    symlinkSync(outsideRoot, inspectedLinkPath, "junction");
    const inspectedLink = fileAccessManager.inspectPath(inspectedLinkPath);
    assert(inspectedLink.kind === "symlink", "inspectPath should report symlinks and junctions");
    assert(inspectedLink.isSymbolicLink, "inspectPath should mark symlink metadata");
    assert(!inspectedLink.readTextLikelySupported, "inspectPath should not mark symlinks as readable text");
    assert(
      inspectedLink.safetyNotes.some((note) => note.includes("不跟随")),
      "inspectPath should explain that symlinks are not followed"
    );

    expectFileError(() => fileAccessManager.inspectPath(path.join(outsideRoot, "outside.txt")), "PATH_NOT_ALLOWED");

    const nestedSearchDirectory = path.join(workspace, "nested");
    const reportDirectory = path.join(workspace, "report-dir");
    mkdirSync(nestedSearchDirectory);
    mkdirSync(reportDirectory);
    const reportAlpha = path.join(workspace, "report-alpha.md");
    const reportBeta = path.join(nestedSearchDirectory, "report-beta.txt");
    const notesFile = path.join(workspace, "notes.txt");
    const reportLink = path.join(workspace, "report-link");
    writeFileSync(reportAlpha, "alpha report content must stay unread", "utf8");
    writeFileSync(reportBeta, "beta report content must stay unread", "utf8");
    writeFileSync(notesFile, "notes", "utf8");
    symlinkSync(outsideRoot, reportLink, "junction");

    const foundReports = fileAccessManager.findByName({
      path: workspace,
      query: "report"
    });
    const foundReportNames = foundReports.matches.map((entry) => entry.fileName).sort();
    assert(
      foundReportNames.join("|") === "report-alpha.md|report-beta.txt|report-dir",
      "findByName should match files and directories by name across bounded depth"
    );
    assert(foundReports.kindFilter === "any", "findByName should default kind filter to any");
    assert(foundReports.matches.every((entry) => !("content" in entry)), "findByName should not expose file content");
    assert(foundReports.skipped.symbolicLinks >= 1, "findByName should skip symlinks and junctions");
    assert(!foundReportNames.includes("report-link"), "findByName should not return symlink matches");
    assert(
      foundReports.matches.some((entry) =>
        entry.fileName === "report-alpha.md"
        && entry.kind === "file"
        && entry.extension === ".md"
        && entry.mediaKind === "text"
        && entry.bytes > 0
      ),
      "findByName file matches should include bytes, extension and mediaKind metadata"
    );

    const limitedReports = fileAccessManager.findByName({
      path: workspace,
      query: "report",
      maxResults: 2
    });
    assert(limitedReports.matchCount === 2 && limitedReports.truncated, "findByName should honor maxResults and mark truncation");

    const reportFilesOnly = fileAccessManager.findByName({
      path: workspace,
      query: "report",
      kind: "file"
    });
    assert(
      reportFilesOnly.matches.length === 2
      && reportFilesOnly.matches.every((entry) => entry.kind === "file"),
      "findByName kind=file should only return files"
    );

    const reportDirectoriesOnly = fileAccessManager.findByName({
      path: workspace,
      query: "report",
      kind: "directory"
    });
    assert(
      reportDirectoriesOnly.matches.length === 1
      && reportDirectoriesOnly.matches[0].fileName === "report-dir",
      "findByName kind=directory should only return matching directories"
    );

    expectFileError(() => fileAccessManager.findByName({ path: outsideRoot, query: "report" }), "PATH_NOT_ALLOWED");
    expectFileError(() => fileAccessManager.findByName({ path: workspace, query: "" }), "INVALID_REQUEST");

    // file.listRecentArtifacts only returns one-level metadata from the default downloads root.
    const downloads = path.join(runtimeRoot, "downloads");
    mkdirSync(downloads, { recursive: true });
    const oldArtifact = path.join(downloads, "old-note.txt");
    const newerArtifact = path.join(downloads, "newer-report.md");
    const newestArtifact = path.join(downloads, "newest-data.json");
    const linkedArtifact = path.join(downloads, "linked-outside");
    writeFileSync(oldArtifact, "old artifact", "utf8");
    writeFileSync(newerArtifact, "newer artifact", "utf8");
    writeFileSync(newestArtifact, "{\"ok\":true}", "utf8");
    const baseMtimeMs = Date.now() - 60_000;
    utimesSync(oldArtifact, new Date(baseMtimeMs), new Date(baseMtimeMs + 1_000));
    utimesSync(newerArtifact, new Date(baseMtimeMs), new Date(baseMtimeMs + 2_000));
    utimesSync(newestArtifact, new Date(baseMtimeMs), new Date(baseMtimeMs + 3_000));
    symlinkSync(outsideRoot, linkedArtifact, "junction");

    const recentArtifacts = fileAccessManager.listRecentArtifacts(2);
    const recentNames = recentArtifacts.entries.map((entry) => entry.fileName);
    assert(
      path.resolve(recentArtifacts.rootPath).toLowerCase() === path.resolve(downloads).toLowerCase(),
      "listRecentArtifacts should use the default downloads root"
    );
    assert(recentArtifacts.limit === 2 && recentArtifacts.count === 2, "listRecentArtifacts should honor limit");
    assert(
      recentNames.join("|") === "newest-data.json|newer-report.md",
      "listRecentArtifacts should sort by modified time descending"
    );
    assert(!recentNames.includes("linked-outside"), "listRecentArtifacts should skip symlinks and junctions");
    assert(
      path.resolve(recentArtifacts.entries[0].path).toLowerCase() === path.resolve(newestArtifact).toLowerCase()
      && recentArtifacts.entries[0].bytes === 11
      && recentArtifacts.entries[0].extension === ".json"
      && recentArtifacts.entries[0].mediaKind === "text",
      "listRecentArtifacts should return file path, bytes, extension and mediaKind"
    );
    assert(!("content" in recentArtifacts.entries[0]), "listRecentArtifacts should not expose file content");

    const clampedRecentArtifacts = fileAccessManager.listRecentArtifacts(999);
    assert(clampedRecentArtifacts.limit === 50, "listRecentArtifacts should clamp limit to 50");
    expectFileError(() => fileAccessManager.listRecentArtifacts(0), "INVALID_REQUEST");

    const outsideTarget = path.join(outsideRoot, "outside.txt");
    expectFileError(() => fileMutationManager.move(moved, outsideTarget, "refuse"), "PATH_NOT_ALLOWED");
    assert(existsSync(moved), "根外拒绝后源文件必须保持不变");

    const escapeLink = path.join(workspace, "escape");
    symlinkSync(outsideRoot, escapeLink, "junction");
    expectFileError(
      () => fileMutationManager.move(moved, path.join(escapeLink, "escaped.txt"), "refuse"),
      "PATH_NOT_ALLOWED"
    );
    assert(existsSync(moved), "链接逃逸拒绝后源文件必须保持不变");

    if (
      existsSync(alternateRoot)
      && path.parse(alternateRoot).root.toLowerCase() !== path.parse(runtimeRoot).root.toLowerCase()
    ) {
      expectFileError(
        () => fileMutationManager.move(moved, path.join(alternateRoot, "cross-device-smoke.txt"), "refuse"),
        "CROSS_DEVICE_MOVE"
      );
      assert(existsSync(moved), "跨盘拒绝后源文件必须保持不变");
    }

    const originalAllowedPrivateHosts = process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS;
    const downloadFixture = await startDownloadFixtureServer();
    try {
      delete process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS;
      await expectFileErrorAsync(
        () => fetchWithPublicDownloadGuard(`${downloadFixture.origin}/sample.txt`),
        "DOWNLOAD_BLOCKED"
      );

      process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS = `127.0.0.1:${downloadFixture.port}`;
      const allowed = await fetchWithPublicDownloadGuard(`${downloadFixture.origin}/sample.txt`);
      assert(allowed.response.ok && allowed.finalUrl.endsWith("/sample.txt"), "allowlist 后本地直链应可下载");
      await allowed.response.body?.cancel();

      const redirected = await fetchWithPublicDownloadGuard(`${downloadFixture.origin}/redirect.txt`);
      assert(
        redirected.response.ok
        && redirected.redirectChain.length === 2
        && redirected.finalUrl.endsWith("/sample.txt"),
        "allowlist 后同主机重定向应逐跳校验并放行"
      );
      await redirected.response.body?.cancel();

      process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS = `127.0.0.1:${downloadFixture.port + 1}`;
      await expectFileErrorAsync(
        () => fetchWithPublicDownloadGuard(`${downloadFixture.origin}/sample.txt`),
        "DOWNLOAD_BLOCKED"
      );
    } finally {
      if (originalAllowedPrivateHosts === undefined) {
        delete process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS;
      } else {
        process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS = originalAllowedPrivateHosts;
      }
      await downloadFixture.close();
    }

    // P5-A 人控机收件箱闭环：隔离运行时根内落盘→可见→读出→归档，全程零触碰真实用户目录
    assert(resolveRuntimeRoot() === runtimeRoot, "隔离断言：运行时根应为本轮临时目录");
    ensureRuntimeDirectories();
    const inboxRoot = resolveInboxRoot();
    const inboxProcessed = path.join(inboxRoot, "processed");
    assert(existsSync(inboxRoot) && existsSync(inboxProcessed), "收件箱 inbox/ 与 processed/ 应由运行时目录契约创建");
    const inboxTask = path.join(inboxRoot, "task-smoke.md");
    writeFileSync(inboxTask, "# smoke task\n请列出下载目录\n", "utf8");
    const inboxListing = fileAccessManager.listDirectory(inboxRoot);
    assert(inboxListing.entries.some((entry) => entry.name === "task-smoke.md" && entry.kind === "file"), "收件箱落盘后 listDirectory 应可见");
    const inboxContent = await fileAccessManager.readText(inboxTask);
    assert(inboxContent.content.includes("请列出下载目录"), "收件箱 readText 应读出指令正文");
    const archivedPath = path.join(inboxProcessed, "task-smoke.md");
    fileMutationManager.move(inboxTask, archivedPath, "refuse");
    assert(!existsSync(inboxTask) && fileDownloadManager.verify(archivedPath).exists, "归档后源消失且 processed 内可验证");

    console.log("[agent-file-mutation-smoke] PASSED");
    console.log(" - 收件箱闭环：隔离根内 inbox 落盘→listDirectory 可见→readText 读出→move 归档 processed 可验证");
    console.log(" - 创建/移动/重命名成功；写入目标预检零写盘；冲突/根外/链接逃逸/深层创建均零写入拒绝");
    console.log(" - 行级编辑恰好一处替换；歧义/未命中/非文本扩展名/根外均拒绝且文件不变");
    console.log(" - 路径元数据预检零读正文：文件/目录/缺失/敏感名/junction/根外路径均按边界处理");
    console.log(" - 文件名查找只返回元数据：文件/目录/嵌套/结果上限/kind 过滤/junction/根外路径均按边界处理");
    console.log(" - 私网下载默认拦截，显式 host:port allowlist 后逐跳放行，错端口仍拒绝");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-file-mutation-smoke] FAILED", error);
  process.exitCode = 1;
});
