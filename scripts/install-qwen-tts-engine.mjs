/**
 * Qwen3-TTS 可选语音引擎包安装/登记脚本。
 *
 * 为什么要单独安装：1.7B 模型 + PyTorch CUDA + Python 运行时约 7GB，
 * 不进基础安装包；装到 D 盘，未安装时 VOID 自动回退 Kokoro。
 *
 * 用法：
 *   node scripts/install-qwen-tts-engine.mjs --register
 *     # 复用本机已有的 tts-eval venv/模型，只写 engine.json（开发机最快）
 *   node scripts/install-qwen-tts-engine.mjs --install
 *     # 从 uv/PyPI/ModelScope 完整安装到 D:\AI\void-runtime\voice-engines\qwen3-tts
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, copyFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice";
const MODEL_NAME = "Qwen3-TTS-12Hz-1.7B-CustomVoice";
const RUNTIME_ROOT = process.env.VOID_RUNTIME_ROOT?.trim() || "D:\\AI\\void-runtime";
const ENGINE_ROOT = resolve(process.env.VOID_QWEN_TTS_ENGINE_ROOT?.trim() || join(RUNTIME_ROOT, "voice-engines", "qwen3-tts"));
const SERVER_SOURCE = join(process.cwd(), "server", "voice", "qwen3tts", "qwen3_tts_server.py");
// 当前 ModelScope 版本（2026-11）的权重哈希；升级模型时同步更新。
const EXPECTED_MODEL_SHA256 = "38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137";
const ENGINE_PYTHON = join(ENGINE_ROOT, "venv", "Scripts", "python.exe");
const ENGINE_MODEL = join(ENGINE_ROOT, "model", MODEL_NAME);
const DEV_PYTHON = join(RUNTIME_ROOT, "tts-eval", "qwen3-tts", ".venv", "Scripts", "python.exe");
const DEV_MODEL = join(RUNTIME_ROOT, "tts-eval", "models", "Qwen3-TTS", MODEL_NAME);

function log(message) {
  console.log(`[qwen3-engine] ${message}`);
}

function fail(message) {
  console.error(`[qwen3-engine] ${message}`);
  process.exit(1);
}

function run(command, args, extraEnv = {}) {
  log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    fail(`命令失败（exit=${result.status}）：${command} ${args.join(" ")}`);
  }
}

async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function writeManifest({ python, modelDir }) {
  if (!existsSync(python)) fail(`Python 不存在：${python}`);
  if (!existsSync(modelDir)) fail(`模型目录不存在：${modelDir}`);
  if (!existsSync(SERVER_SOURCE)) fail(`服务脚本不存在：${SERVER_SOURCE}`);

  mkdirSync(ENGINE_ROOT, { recursive: true });
  const serverTarget = join(ENGINE_ROOT, "qwen3_tts_server.py");
  copyFileSync(SERVER_SOURCE, serverTarget);

  const modelFile = join(modelDir, "model.safetensors");
  const files = {};
  for (const name of ["model.safetensors", "config.json"]) {
    const path = join(modelDir, name);
    if (!existsSync(path)) continue;
    log(`校验 ${name} …`);
    const sha256 = await sha256File(path);
    if (name === "model.safetensors" && EXPECTED_MODEL_SHA256 && sha256 !== EXPECTED_MODEL_SHA256) {
      fail(`模型权重哈希不匹配：期望 ${EXPECTED_MODEL_SHA256}，实际 ${sha256}`);
    }
    files[name] = {
      bytes: statSync(path).size,
      sha256
    };
  }
  if (!modelFile || !existsSync(modelFile)) fail(`模型权重缺失：${modelFile}`);

  const manifest = {
    schemaVersion: 1,
    engine: "qwen3-tts",
    model: MODEL_NAME,
    python,
    modelDir,
    server: serverTarget,
    license: "Apache-2.0",
    source: "https://github.com/QwenLM/Qwen3-TTS",
    modelSource: `https://modelscope.cn/models/${MODEL_ID}`,
    installedAt: new Date().toISOString(),
    files
  };
  const manifestPath = join(ENGINE_ROOT, "engine.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  log(`完成：${manifestPath}`);
  log(`python=${python}`);
  log(`modelDir=${modelDir}`);
}

async function registerExisting() {
  const python = process.env.VOID_QWEN_TTS_PYTHON?.trim()
    || (existsSync(ENGINE_PYTHON) ? ENGINE_PYTHON : DEV_PYTHON);
  const modelDir = process.env.VOID_QWEN_TTS_MODEL_DIR?.trim()
    || (existsSync(ENGINE_MODEL) ? ENGINE_MODEL : DEV_MODEL);
  log("登记本机已有 Qwen3-TTS 环境（不重新下载）");
  await writeManifest({ python, modelDir });
}

async function installFresh() {
  const venvDir = join(ENGINE_ROOT, "venv");
  const python = join(venvDir, "Scripts", "python.exe");
  const modelDir = join(ENGINE_ROOT, "model", MODEL_NAME);
  const cacheRoot = join(ENGINE_ROOT, "cache");
  const env = {
    UV_CACHE_DIR: join(cacheRoot, "uv"),
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    UV_PYTHON_INSTALL_DIR: join(ENGINE_ROOT, "python"),
    MODELSCOPE_CACHE: join(cacheRoot, "modelscope")
  };

  mkdirSync(ENGINE_ROOT, { recursive: true });
  log("1/5 安装 Python 3.12");
  run("uv", ["python", "install", "3.12"], env);
  log("2/5 创建隔离 venv");
  run("uv", ["venv", "--python", "3.12", venvDir], env);
  log("3/5 安装 PyTorch CUDA 12.8");
  run("uv", ["pip", "install", "--python", python, "torch", "torchaudio", "--index-url", "https://download.pytorch.org/whl/cu128"], env);
  log("4/5 安装 qwen-tts / modelscope");
  run("uv", ["pip", "install", "--python", python, "qwen-tts", "modelscope"], env);
  log("5/5 下载模型（约 4.2GB）");
  const modelscope = join(venvDir, "Scripts", "modelscope.exe");
  run(modelscope, ["download", "--model", MODEL_ID, "--local_dir", modelDir], env);

  await writeManifest({ python, modelDir });
}

const mode = process.argv.includes("--install") ? "install" : "register";
(mode === "install" ? installFresh() : registerExisting()).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
