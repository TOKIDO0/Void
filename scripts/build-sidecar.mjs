/**
 * 构建 VOID 桥接 sidecar 的独立可执行文件（Node SEA 单文件应用）。
 *
 * 面向上线：正式安装包不能假设用户机器装了 Node，因此把桥接服务打成独立 .exe，
 * 随 Tauri 作为 sidecar 分发。使用 Node 官方 Single Executable Applications 方案，
 * 无第三方打包器依赖。
 *
 * 步骤：
 *   1. esbuild（JS API）把 server/voidBridgeServer.ts 及其依赖（ws 等）打成单个 CJS 文件。
 *   2. node --experimental-sea-config 生成 SEA blob。
 *   3. 复制当前 node 可执行文件，用 postject（JS API）注入 blob，产出带三元组后缀的 sidecar exe。
 *
 * 产物：src-tauri/binaries/void-bridge-<target-triple>.exe
 *   （Tauri externalBin 约定：文件名必须带目标三元组后缀。）
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const buildDir = join(projectRoot, ".sidecar-build");
const binariesDir = join(projectRoot, "src-tauri", "binaries");

// Windows x64 目标三元组（Tauri sidecar 命名约定）。
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";
const SIDECAR_NAME = "void-bridge";
// Node SEA 约定的哨兵熔断串，postject 注入时用于定位 blob 占位。
const SEA_SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const bundlePath = join(buildDir, "void-bridge.cjs");
const seaConfigPath = join(buildDir, "sea-config.json");
const seaBlobPath = join(buildDir, "void-bridge.blob");
const outputExePath = join(binariesDir, `${SIDECAR_NAME}-${TARGET_TRIPLE}.exe`);

async function main() {
  // 准备目录
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  // 1. esbuild 打包为单个 CJS。可选原生/动态依赖标记为 external，运行时按需加载或由依赖自身回退。
  console.log("[build-sidecar] bundling with esbuild...");
  await build({
    entryPoints: [join(projectRoot, "server", "voidBridgeServer.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: [
      "bufferutil",
      "utf-8-validate",
      "@huggingface/transformers",
      "onnxruntime-common",
      "onnxruntime-node",
      "chromium-bidi/*",
      "*.node"
    ],
    outfile: bundlePath
  });

  // 2. 生成 SEA blob
  console.log("[build-sidecar] generating SEA blob...");
  const seaConfig = {
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true
  };
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit",
    cwd: projectRoot
  });

  // 3. 复制 node 可执行文件并注入 blob
  console.log("[build-sidecar] injecting blob into node binary...");
  copyFileSync(process.execPath, outputExePath);
  const blobData = readFileSync(seaBlobPath);
  await inject(outputExePath, "NODE_SEA_BLOB", blobData, {
    sentinelFuse: SEA_SENTINEL_FUSE
  });

  rmSync(buildDir, { recursive: true, force: true });
  console.log(`[build-sidecar] done → ${outputExePath}`);
}

main().catch((error) => {
  console.error("[build-sidecar] failed:", error);
  process.exit(1);
});
