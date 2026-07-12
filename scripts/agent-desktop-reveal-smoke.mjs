import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectDesktopError(work, expectedCode) {
  return Promise.resolve()
    .then(() => work())
    .then(() => {
      throw new Error(`预期失败 ${expectedCode}，实际成功`);
    })
    .catch((error) => {
      if (error?.message?.startsWith("预期失败")) {
        throw error;
      }
      assert(error?.desktopCode === expectedCode, `期望 ${expectedCode}，实际 ${error?.desktopCode}`);
    });
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-desktop-reveal-root-"));
  const outsideRoot = mkdtempSync(path.join(os.tmpdir(), "void-desktop-reveal-outside-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const { desktopRevealManager } = await import(
      pathToFileURL(path.join(projectRoot, "server/desktop/desktopRevealManager.ts")).href
    );

    const workspace = path.join(runtimeRoot, "workspace");
    mkdirSync(workspace);
    const sampleFile = path.join(workspace, "reveal-me.txt");
    writeFileSync(sampleFile, "reveal sample", "utf8");

    const fileReveal = await desktopRevealManager.revealPath(sampleFile);
    assert(fileReveal.openMode === "select", "文件应使用 select");
    assert(fileReveal.revealedPath === path.resolve(sampleFile) || existsSync(fileReveal.revealedPath), "应返回已解析路径");

    const dirReveal = await desktopRevealManager.revealPath(workspace);
    assert(dirReveal.openMode === "open", "目录应使用 open");

    // 根外路径必须真实存在，才能先过 mustExist 再命中允许根拒绝
    const outsideFile = path.join(outsideRoot, "outside.txt");
    writeFileSync(outsideFile, "outside", "utf8");
    await expectDesktopError(
      () => desktopRevealManager.revealPath(outsideFile),
      "PATH_NOT_ALLOWED"
    );

    await expectDesktopError(
      () => desktopRevealManager.revealPath(path.join(workspace, "missing.txt")),
      "PATH_NOT_FOUND"
    );

    const escapeLink = path.join(workspace, "escape");
    symlinkSync(outsideRoot, escapeLink, "junction");
    await expectDesktopError(
      () => desktopRevealManager.revealPath(path.join(escapeLink, "outside.txt")),
      "PATH_NOT_ALLOWED"
    );

    console.log("[agent-desktop-reveal-smoke] PASSED");
    console.log(" - 目录 open / 文件 select 成功；根外、不存在、链接逃逸均拒绝");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-desktop-reveal-smoke] FAILED", error);
  process.exitCode = 1;
});
