import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-read-root-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "void-file-read-outside-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const sampleDirectory = path.join(runtimeRoot, "samples");
    mkdirSync(path.join(sampleDirectory, "child"), { recursive: true });
    const textPath = path.join(sampleDirectory, "notes.txt");
    writeFileSync(textPath, "第一行\nVOID UTF-8 sample\n", "utf8");
    writeFileSync(path.join(sampleDirectory, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(path.join(sampleDirectory, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    writeFileSync(path.join(sampleDirectory, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 0x61));
    const outsideText = path.join(outsideRoot, "secret.txt");
    writeFileSync(outsideText, "outside", "utf8");
    const { fileAccessManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileAccessManager.ts")).href
    );
    const { fileDownloadManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/file/fileDownloadManager.ts")).href
    );

    const listed = fileAccessManager.listDirectory(sampleDirectory);
    assert(listed.entries.some((entry) => entry.name === "notes.txt"), "目录应包含 notes.txt");
    assert(listed.entries.some((entry) => entry.name === "child" && entry.kind === "directory"), "应列出一层子目录但不递归");
    const read = fileAccessManager.readText(textPath);
    assert(read.content.includes("VOID UTF-8 sample"), "应读取严格 UTF-8 文本");
    assert(fileDownloadManager.verify(textPath).exists, "file.verify 应复用同一允许根策略");

    const escapeLink = path.join(sampleDirectory, "escape");
    symlinkSync(outsideRoot, escapeLink, "junction");
    expectFileError(() => fileAccessManager.readText(outsideText), "PATH_NOT_ALLOWED");
    expectFileError(() => fileAccessManager.readText(path.join(escapeLink, "secret.txt")), "PATH_NOT_ALLOWED");
    expectFileError(() => fileAccessManager.readText(path.join(sampleDirectory, "binary.bin")), "BINARY_FILE");
    expectFileError(() => fileAccessManager.readText(path.join(sampleDirectory, "invalid.txt")), "INVALID_UTF8");
    expectFileError(() => fileAccessManager.readText(path.join(sampleDirectory, "large.txt")), "FILE_TOO_LARGE");

    console.log("[agent-file-read-smoke] PASSED");
    console.log(" - 单层目录/UTF-8 成功；根外/链接逃逸/二进制/非法 UTF-8/超限均拒绝");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-file-read-smoke] FAILED", error);
  process.exitCode = 1;
});
