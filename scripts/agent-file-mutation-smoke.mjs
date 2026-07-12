import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

    console.log("[agent-file-mutation-smoke] PASSED");
    console.log(" - 创建/移动/重命名成功；冲突/根外/链接逃逸/深层创建均零写入拒绝");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-file-mutation-smoke] FAILED", error);
  process.exitCode = 1;
});
