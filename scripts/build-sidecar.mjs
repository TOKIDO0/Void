/**
 * 构建 VOID 桥接 sidecar（随 Tauri 安装包分发）。
 *
 * 面向上线：正式安装包不能假设用户机器装了 Node，因此把 Node 解释器本身
 * （当前构建机 node 可执行文件）+ 服务 bundle 一起打包，由 Rust 以 sidecar 方式拉起。
 *
 * 为什么不用 Node SEA 单文件（0.2.4 教训，勿回退）：
 * playwright-core 在模块顶层按计算出的绝对路径 require 自身 package.json，
 * 该写法与 SEA 快照不兼容——快照内的 require 不回退文件系统，启动即
 * ERR_UNKNOWN_BUILTIN_MODULE，全进程崩溃，监听从未建立，安装包内桥接全挂。
 * 而 dev 下 tsx 走真实 node_modules 所以正常，这就是“开发正常、安装包全挂”的分叉。
 * 结论：凡是按磁盘相对路径自读文件的依赖，一律走“解释器 + 真实文件”分发，不进快照。
 *
 * 步骤：
 *   1. esbuild 把 server/voidBridgeServer.ts 打成单个 CJS（playwright-core 等
 *      磁盘自读依赖保持 external，运行时从 sidecar-app/node_modules 解析）。
 *   2. 复制当前 node 可执行文件为 Tauri sidecar 二进制（带目标三元组后缀）。
 *   3. 组装 src-tauri/sidecar-app：void-bridge.cjs + node_modules/playwright-core
 *      整包原样复制（白名单裁剪会在 playwright 升级后静默失效，禁止）。
 *
 * 产物（均 gitignore，CI/本地按需生成，不入库）：
 *   src-tauri/binaries/node-<target-triple>.exe
 *   src-tauri/sidecar-app/void-bridge.cjs
 *   src-tauri/sidecar-app/node_modules/playwright-core/
 * 打包映射（tauri.conf.json）：externalBin binaries/node + resources sidecar-app。
 * Rust 拉起：sidecar("node").args([<resourceDir>/sidecar-app/void-bridge.cjs])。
 */
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const buildDir = join(projectRoot, ".sidecar-build");
const binariesDir = join(projectRoot, "src-tauri", "binaries");
const sidecarAppDir = join(projectRoot, "src-tauri", "sidecar-app");

// Windows x64 目标三元组（Tauri sidecar 命名约定）。
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const bundlePath = join(buildDir, "void-bridge.cjs");
const nodeExePath = join(binariesDir, `node-${TARGET_TRIPLE}.exe`);

async function main() {
  // 准备目录
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  // 1. esbuild 打包为单个 CJS。playwright-core 等磁盘自读依赖保持 external：
  // bundle 内只留 require("playwright-core")，由普通 Node 按 node_modules 向上查找解析。
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
      "playwright",
      "playwright-core",
      "@huggingface/transformers",
      "onnxruntime-common",
      "onnxruntime-node",
      "chromium-bidi/*",
      "*.node"
    ],
    outfile: bundlePath
  });

  // 2. 解释器本身作为 sidecar 二进制分发（与构建机 Node 大版本一致，esbuild target node22）。
  console.log("[build-sidecar] staging node runtime as sidecar binary...");
  copyFileSync(process.execPath, nodeExePath);

  // 3. 组装 sidecar-app：bundle + playwright-core 整包。
  console.log("[build-sidecar] assembling sidecar-app...");
  rmSync(sidecarAppDir, { recursive: true, force: true });
  const appModulesDir = join(sidecarAppDir, "node_modules");
  mkdirSync(appModulesDir, { recursive: true });
  copyFileSync(bundlePath, join(sidecarAppDir, "void-bridge.cjs"));
  cpSync(
    join(projectRoot, "node_modules", "playwright-core"),
    join(appModulesDir, "playwright-core"),
    { recursive: true }
  );

  rmSync(buildDir, { recursive: true, force: true });
  console.log(`[build-sidecar] done → ${nodeExePath} + ${sidecarAppDir}`);
}

main().catch((error) => {
  console.error("[build-sidecar] failed:", error);
  process.exit(1);
});
