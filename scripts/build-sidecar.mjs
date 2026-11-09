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
 *      同时把同步 Kokoro 合成入口 server/voice/voiceTtsWorker.ts 打成
 *      tts-worker.cjs，避免阻塞 sidecar 主线程的 /void-model-proxy。
 *   2. 复制当前 node 可执行文件为 Tauri sidecar 二进制（带目标三元组后缀）。
 *   3. 组装 src-tauri/sidecar-app：void-bridge.cjs + tts-worker.cjs +
 *      node_modules/playwright-core 整包原样复制（白名单裁剪会在 playwright
 *      升级后静默失效，禁止）。
 *
 * 产物（均 gitignore，CI/本地按需生成，不入库）：
 *   src-tauri/binaries/node-<target-triple>.exe
 *   src-tauri/sidecar-app/void-bridge.cjs
 *   src-tauri/sidecar-app/tts-worker.cjs
 *   src-tauri/sidecar-app/node_modules/playwright-core/
 * 打包映射（tauri.conf.json）：externalBin binaries/node + resources sidecar-app。
 * Rust 拉起：cwd=<resourceDir>/sidecar-app + sidecar("node").args(["void-bridge.cjs"])。
 * 刻意不用绝对路径当参数：Windows 绝对路径在参数传输链上曾被截断（0.2.6 EISDIR on `D:`）。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import WebSocket from "ws";
import { ensureSttModel, ensureTtsModel } from "./fetch-stt-model.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const buildDir = join(projectRoot, ".sidecar-build");
const binariesDir = join(projectRoot, "src-tauri", "binaries");
const sidecarAppDir = join(projectRoot, "src-tauri", "sidecar-app");

// Windows x64 目标三元组（Tauri sidecar 命名约定）。
const TARGET_TRIPLE = "x86_64-pc-windows-msvc";

const bundlePath = join(buildDir, "void-bridge.cjs");
const workerBundlePath = join(buildDir, "tts-worker.cjs");
const nodeExePath = join(binariesDir, `node-${TARGET_TRIPLE}.exe`);

async function main() {
  // 准备目录
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  // 1. esbuild 打包为单个 CJS。playwright-core 等磁盘自读依赖保持 external：
  // bundle 内只留 require("playwright-core")，由普通 Node 按 node_modules 向上查找解析。
  console.log("[build-sidecar] bundling with esbuild...");
  const esbuildOptions = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: [
      "bufferutil",
      "utf-8-validate",
      "playwright",
      "playwright-core",
      "sherpa-onnx-node",
      "sherpa-onnx-win-x64",
      "@huggingface/transformers",
      "onnxruntime-common",
      "onnxruntime-node",
      "chromium-bidi/*",
      "*.node"
    ]
  };
  await build({
    ...esbuildOptions,
    entryPoints: [join(projectRoot, "server", "voidBridgeServer.ts")],
    outfile: bundlePath
  });
  // Kokoro 同步 generate 必须放在独立 worker，否则会阻塞 sidecar 主线程的 /void-model-proxy。
  await build({
    ...esbuildOptions,
    entryPoints: [join(projectRoot, "server", "voice", "voiceTtsWorker.ts")],
    outfile: workerBundlePath
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
  copyFileSync(workerBundlePath, join(sidecarAppDir, "tts-worker.cjs"));
  // Qwen3-TTS 的 Python 服务脚本随 sidecar-app 分发；Python 运行时/模型由可选引擎包提供。
  const qwenTtsDir = join(sidecarAppDir, "qwen3tts");
  mkdirSync(qwenTtsDir, { recursive: true });
  copyFileSync(
    join(projectRoot, "server", "voice", "qwen3tts", "qwen3_tts_server.py"),
    join(qwenTtsDir, "qwen3_tts_server.py")
  );
  for (const pkg of ["playwright-core", "sherpa-onnx-node", "sherpa-onnx-win-x64"]) {
    const source = join(projectRoot, "node_modules", pkg);
    if (!existsSync(source)) {
      throw new Error(`[build-sidecar] 缺少运行时依赖：${source}`);
    }
    cpSync(source, join(appModulesDir, pkg), { recursive: true });
  }

  rmSync(buildDir, { recursive: true, force: true });
  console.log(`[build-sidecar] done → ${nodeExePath} + ${sidecarAppDir}`);

  // 4. 生产模拟门禁：把 sidecar-app 复制到仓库外的隔离目录（避免向上查找到
  // 项目 node_modules 造成“本地能跑、用户机器崩”的污染式验证），按安装包的
  // 真实拉起方式（cwd=sidecar-app + 相对入口）启动并探测端点。
  // 0.2.4（SEA 快照）与 0.2.6（绝对路径参数）两代事故本应都在这里被拦下。
  const sttModelDir = await ensureSttModel();
  const ttsModelDir = await ensureTtsModel();
  await runProductionSimGate(sttModelDir, ttsModelDir);
}

/**
 * 生产模拟门禁使用的隔离目录。
 * 优先级：环境变量 VOID_PRODSIM_DIR > 本机运行时根（D 盘，不占用 C 盘）
 * > 系统临时目录（CI runner 走这里）。
 * 调用方保证用后删除，不留垃圾。
 */
function resolveProdSimRoot() {
  const fromEnv = process.env.VOID_PRODSIM_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const runtimeRoot = "D:\\AI\\void-runtime";
  if (existsSync(runtimeRoot)) {
    return join(runtimeRoot, ".tmp-prod-sim");
  }
  return join(tmpdir(), "void-prod-sim");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHealth(port, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/void-bridge/health`, {
      signal: controller.signal
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return payload?.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runProductionSimGate(sttModelDir, ttsModelDir) {
  const cjs = join(sidecarAppDir, "void-bridge.cjs");
  const playwrightPkg = join(sidecarAppDir, "node_modules", "playwright-core", "package.json");
  const sherpaPkg = join(sidecarAppDir, "node_modules", "sherpa-onnx-node", "package.json");
  if (!existsSync(cjs)) {
    throw new Error(`[prod-sim] 缺少入口：${cjs}`);
  }
  const ttsWorker = join(sidecarAppDir, "tts-worker.cjs");
  if (!existsSync(ttsWorker)) {
    throw new Error(`[prod-sim] 缺少 TTS worker：${ttsWorker}`);
  }
  if (!existsSync(playwrightPkg)) {
    throw new Error(`[prod-sim] 缺少随包依赖：${playwrightPkg}`);
  }
  if (!existsSync(sherpaPkg)) {
    throw new Error(`[prod-sim] 缺少随包依赖：${sherpaPkg}`);
  }

  const simRoot = resolveProdSimRoot();
  const simAppDir = join(simRoot, "sidecar-app");
  console.log(`[prod-sim] 隔离目录：${simRoot}`);
  rmSync(simRoot, { recursive: true, force: true });
  mkdirSync(simRoot, { recursive: true });
  try {
    cpSync(sidecarAppDir, simAppDir, { recursive: true });
    const port = Number(process.env.VOID_PRODSIM_PORT ?? "17998");
    // 与 Rust 拉起完全一致：cwd=sidecar-app，参数为相对文件名。
    const child = spawn(process.execPath, ["void-bridge.cjs"], {
      cwd: simAppDir,
      env: {
        ...process.env,
        VOID_BRIDGE_PORT: String(port),
        // 仅生产模拟：允许空 bridge token 以便门禁直接取票；真实安装仍走 token。
        VOID_BRIDGE_TOKEN: "",
        VOID_ALLOW_EMPTY_BRIDGE_TOKEN: "1",
        ...(sttModelDir ? { VOID_STT_MODEL_DIR: sttModelDir } : {}),
        ...(ttsModelDir ? { VOID_TTS_MODEL_DIR: ttsModelDir } : {})
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });
    const startedAt = Date.now();
    let healthy = false;
    try {
      while (Date.now() - startedAt < 45_000) {
        if (child.exitCode !== null) {
          throw new Error(
            `[prod-sim] sidecar 启动后退出，exitCode=${child.exitCode}（复现了安装包启动崩溃）。stderr 尾巴：${stderrTail || "(空)"}`
          );
        }
        if (await probeHealth(port, 2000)) {
          healthy = true;
          break;
        }
        await sleep(1000);
      }
      if (!healthy) {
        throw new Error("[prod-sim] 45s 内 /void-bridge/health 未就绪");
      }
      console.log("[prod-sim] 健康检查通过，安装包拉起方式可服务");
      if (sttModelDir) {
        await probeVoiceStt(port);
        console.log("[prod-sim] 本地 STT 引擎加载通过（DLL + 模型）");
      } else {
        console.log("[prod-sim] 跳过本地 STT 引擎门禁（无模型）");
      }
      if (ttsModelDir) {
        await probeVoiceTts(port);
        console.log("[prod-sim] 本地 TTS 引擎合成通过（Kokoro）");
      } else {
        console.log("[prod-sim] 跳过本地 TTS 引擎门禁（无模型）");
      }
    } finally {
      child.kill();
      await sleep(500);
    }
  } finally {
    rmSync(simRoot, { recursive: true, force: true });
  }
}

async function probeVoiceStt(port, timeoutMs = 30_000) {
  const response = await fetch(`http://127.0.0.1:${port}/void-voice/stt/ticket`, { method: "POST" });
  const payload = await response.json();
  if (!response.ok || !payload?.ok || !payload.data?.ticket) {
    throw new Error(`[prod-sim] 本地 STT 取票失败：HTTP ${response.status} ${JSON.stringify(payload)}`);
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/void-voice/stt?ticket=${encodeURIComponent(payload.data.ticket)}`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("[prod-sim] 本地 STT WS 超时")), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("error", onError);
      };
      const onMessage = (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === "ready") {
          cleanup();
          resolve();
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(`[prod-sim] 本地 STT 引擎错误：${message.code ?? ""} ${message.message ?? ""}`));
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      ws.on("open", () => ws.send(JSON.stringify({ type: "start", sampleRate: 16000, format: "pcm_s16le" })));
      ws.on("message", onMessage);
      ws.on("error", onError);
      ws.on("unexpected-response", (_request, responseMessage) => {
        cleanup();
        reject(new Error(`[prod-sim] 本地 STT WS 握手失败：HTTP ${responseMessage.statusCode}`));
      });
    });
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

async function probeVoiceTts(port, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/void-voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好，我是 VOID。" }),
      signal: controller.signal
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[prod-sim] 本地 TTS 失败：HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) {
      throw new Error(`[prod-sim] 本地 TTS 未返回有效 PCM（${buffer.length} bytes）`);
    }
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error) => {
  console.error("[build-sidecar] failed:", error);
  process.exit(1);
});
