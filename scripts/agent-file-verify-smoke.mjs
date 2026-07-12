// P4 冒烟：file.verify 的 mediaKind 分类（安装包/压缩包/文本/图片）。
// 目的：确认 Python 安装包 .exe、.msi 归 binary，.zip/.tgz 归 archive，不被误判。
// 说明：直接调用 fileDownloadManager.verify，只读本地临时文件，无需启动 bridge。
// 用法：npx tsx scripts/agent-file-verify-smoke.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

// 期望：文件名 → mediaKind
const CASES = [
  { name: "python-3.12.4-amd64.exe", expect: "binary" },
  { name: "setup.msi", expect: "binary" },
  { name: "bundle.zip", expect: "archive" },
  { name: "release.tgz", expect: "archive" },
  { name: "notes.txt", expect: "text" },
  { name: "photo.png", expect: "image" }
];

async function main() {
  const { fileDownloadManager } = await import(
    pathToFileURL(path.join(root, "server/file/fileDownloadManager.ts")).href
  );

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "void-verify-smoke-"));
  let failed = false;

  try {
    for (const testCase of CASES) {
      const filePath = path.join(tempDir, testCase.name);
      writeFileSync(filePath, "smoke-content");

      const result = fileDownloadManager.verify(filePath);

      const actual = result.mediaKind;
      const ok = result.exists && actual === testCase.expect;
      console.log(
        `[agent-file-verify-smoke] ${testCase.name} → mediaKind=${actual} contentTypeGuess=${result.contentTypeGuess ?? "-"} ${ok ? "OK" : "FAIL"}`
      );
      if (!ok) {
        failed = true;
        console.error(
          `[agent-file-verify-smoke] 分类不符：${testCase.name} 期望 ${testCase.expect}，实际 ${actual}`
        );
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (failed) {
    console.error("[agent-file-verify-smoke] FAILED");
    process.exitCode = 1;
    return;
  }

  console.log("[agent-file-verify-smoke] PASSED");
  console.log(" - 安装包 .exe/.msi=binary，压缩包 .zip/.tgz=archive，文本/图片正确");
}

main().catch((error) => {
  console.error("[agent-file-verify-smoke] crashed", error);
  process.exitCode = 1;
});
