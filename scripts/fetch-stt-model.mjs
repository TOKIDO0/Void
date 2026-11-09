/**
 * 阶段 4：构建期准备本地 STT 模型（sherpa-onnx paraformer int8）。
 *
 * - 只下载官方 GitHub asr-models tar.bz2，校验 SHA256；
 * - 只提取 int8 三件套 + README/LICENSE 到 src-tauri/resources/voice/stt/<name>；
 * - 缓存 tar，重复构建不重复下载；
 * - VOID_SKIP_STT_MODEL=1 时跳过（生产模拟门禁也会跳过语音加载）。
 *
 * 模型不进 git；目标目录由 .gitignore 排除。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import tarStream from "tar-stream";
import unbzip2 from "unbzip2-stream";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");

export const STT_MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en";
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";
const TAR_SHA256 = "5462A1FCE42693DEAE572AF1E8C4687124B12AA85FE61FF4D3168BB5280E205F";
const WANTED_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt", "README.md", "LICENSE"];

export const STT_MODEL_DIR = join(PROJECT_ROOT, "src-tauri", "resources", "voice", "stt", STT_MODEL_NAME);
const MARKER = join(STT_MODEL_DIR, ".verified.json");

export const TTS_MODEL_NAME = "kokoro-multi-lang-v1_0";
const TTS_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2";
const TTS_TAR_SHA256 = "60703707BC05CCD48D60E1EB723F38B07D6E474795A0B6A588D7220400E0F7A4";
const TTS_WANTED_FILES = [
  "model.onnx",
  "voices.bin",
  "tokens.txt",
  "lexicon-zh.txt",
  "lexicon-gb-en.txt",
  "lexicon-us-en.txt",
  "number-zh.fst",
  "date-zh.fst",
  "phone-zh.fst",
  "LICENSE",
  "README.md"
];
export const TTS_MODEL_DIR = join(PROJECT_ROOT, "src-tauri", "resources", "voice", "tts", TTS_MODEL_NAME);
const TTS_MARKER = join(TTS_MODEL_DIR, ".verified.json");

function resolveCacheDir() {
  const fromEnv = process.env.VOID_MODEL_CACHE_DIR?.trim();
  if (fromEnv) return fromEnv;
  const runtimeRoot = "D:\\AI\\void-runtime";
  return existsSync(runtimeRoot) ? join(runtimeRoot, "model-cache") : join(tmpdir(), "void-model-cache");
}

const CACHE_DIR = resolveCacheDir();
const TAR_PATH = join(CACHE_DIR, `${STT_MODEL_NAME}.tar.bz2`);
const TTS_TAR_PATH = join(CACHE_DIR, `${TTS_MODEL_NAME}.tar.bz2`);

export async function ensureSttModel({ force = false } = {}) {
  if (process.env.VOID_SKIP_STT_MODEL === "1") {
    console.log("[stt-model] VOID_SKIP_STT_MODEL=1，跳过模型准备");
    return null;
  }
  if (!force && isModelReady()) {
    console.log(`[stt-model] 已就绪：${STT_MODEL_DIR}`);
    return STT_MODEL_DIR;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(TAR_PATH) || (await sha256File(TAR_PATH)) !== TAR_SHA256) {
    console.log(`[stt-model] 下载官方模型 tar → ${TAR_PATH}`);
    await downloadWithRetry(MODEL_URL, TAR_PATH);
    const actual = await sha256File(TAR_PATH);
    if (actual !== TAR_SHA256) {
      rmSync(TAR_PATH, { force: true });
      throw new Error(`[stt-model] SHA256 不匹配：expected ${TAR_SHA256}, got ${actual}`);
    }
  } else {
    console.log("[stt-model] 复用缓存 tar 并通过 SHA256 校验");
  }

  const extractDir = join(CACHE_DIR, `.extract-${Date.now()}`);
  try {
    console.log("[stt-model] 解压 int8 文件...");
    await extractWantedFiles(TAR_PATH, extractDir, WANTED_FILES);
    const sourceDir = join(extractDir, STT_MODEL_NAME);
    if (!existsSync(sourceDir)) {
      throw new Error(`[stt-model] 解压目录缺少 ${STT_MODEL_NAME}`);
    }
    rmSync(STT_MODEL_DIR, { recursive: true, force: true });
    mkdirSync(STT_MODEL_DIR, { recursive: true });
    const fileSizes = {};
    for (const name of WANTED_FILES) {
      const source = join(sourceDir, name);
      if (!existsSync(source)) continue;
      const target = join(STT_MODEL_DIR, name);
      copyFileSync(source, target);
      fileSizes[name] = statSync(target).size;
    }
    for (const required of ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]) {
      if (!fileSizes[required]) {
        throw new Error(`[stt-model] 缺少必需文件：${required}`);
      }
    }
    writeFileSync(
      join(STT_MODEL_DIR, "NOTICE.txt"),
      [
        `Model: ${STT_MODEL_NAME}`,
        `Source: ${MODEL_URL}`,
        `Tar SHA256: ${TAR_SHA256}`,
        "License: Apache-2.0 (per sherpa-onnx model README).",
        "Original weights: ModelScope damo/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online.",
        "Before redistribution, independently verify the original ModelScope model license.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(MARKER, JSON.stringify({ tarSha256: TAR_SHA256, files: fileSizes, createdAt: Date.now() }, null, 2), "utf8");
    console.log(`[stt-model] 就绪：${STT_MODEL_DIR}`);
    return STT_MODEL_DIR;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function isModelReady() {
  if (!existsSync(MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER, "utf8"));
    if (marker.tarSha256 !== TAR_SHA256 || !marker.files) return false;
    for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt"]) {
      const path = join(STT_MODEL_DIR, name);
      if (!existsSync(path) || statSync(path).size !== marker.files[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureTtsModel({ force = false } = {}) {
  if (process.env.VOID_SKIP_TTS_MODEL === "1") {
    console.log("[tts-model] VOID_SKIP_TTS_MODEL=1，跳过模型准备");
    return null;
  }
  if (!force && isTtsModelReady()) {
    console.log(`[tts-model] 已就绪：${TTS_MODEL_DIR}`);
    return TTS_MODEL_DIR;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(TTS_TAR_PATH) || (await sha256File(TTS_TAR_PATH)) !== TTS_TAR_SHA256) {
    console.log(`[tts-model] 下载官方模型 tar → ${TTS_TAR_PATH}`);
    await downloadWithRetry(TTS_MODEL_URL, TTS_TAR_PATH);
    const actual = await sha256File(TTS_TAR_PATH);
    if (actual !== TTS_TAR_SHA256) {
      rmSync(TTS_TAR_PATH, { force: true });
      throw new Error(`[tts-model] SHA256 不匹配：expected ${TTS_TAR_SHA256}, got ${actual}`);
    }
  } else {
    console.log("[tts-model] 复用缓存 tar 并通过 SHA256 校验");
  }

  const extractDir = join(CACHE_DIR, `.extract-tts-${Date.now()}`);
  try {
    console.log("[tts-model] 解压 Kokoro 文件...");
    await extractWantedFiles(TTS_TAR_PATH, extractDir, TTS_WANTED_FILES);
    const sourceDir = join(extractDir, TTS_MODEL_NAME);
    if (!existsSync(sourceDir)) {
      throw new Error(`[tts-model] 解压目录缺少 ${TTS_MODEL_NAME}`);
    }
    rmSync(TTS_MODEL_DIR, { recursive: true, force: true });
    mkdirSync(TTS_MODEL_DIR, { recursive: true });
    const fileSizes = {};
    for (const name of TTS_WANTED_FILES) {
      const source = join(sourceDir, name);
      if (!existsSync(source)) continue;
      const target = join(TTS_MODEL_DIR, name);
      copyFileSync(source, target);
      fileSizes[name] = statSync(target).size;
    }
    for (const required of ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt"]) {
      if (!fileSizes[required]) {
        throw new Error(`[tts-model] 缺少必需文件：${required}`);
      }
    }
    writeFileSync(
      join(TTS_MODEL_DIR, "NOTICE.txt"),
      [
        `Model: ${TTS_MODEL_NAME}`,
        `Source: ${TTS_MODEL_URL}`,
        `Tar SHA256: ${TTS_TAR_SHA256}`,
        "License: Apache-2.0 (Kokoro model; see LICENSE).",
        "Original weights: hexgrad/Kokoro-82M, exported by sherpa-onnx.",
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(TTS_MARKER, JSON.stringify({ tarSha256: TTS_TAR_SHA256, files: fileSizes, createdAt: Date.now() }, null, 2), "utf8");
    console.log(`[tts-model] 就绪：${TTS_MODEL_DIR}`);
    return TTS_MODEL_DIR;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function isTtsModelReady() {
  if (!existsSync(TTS_MARKER)) return false;
  try {
    const marker = JSON.parse(readFileSync(TTS_MARKER, "utf8"));
    if (marker.tarSha256 !== TTS_TAR_SHA256 || !marker.files) return false;
    for (const name of ["model.onnx", "voices.bin", "tokens.txt", "lexicon-zh.txt"]) {
      const path = join(TTS_MODEL_DIR, name);
      if (!existsSync(path) || statSync(path).size !== marker.files[name]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadWithRetry(url, dest) {
  const partial = `${dest}.partial`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      rmSync(partial, { force: true });
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, dest);
      return;
    } catch (error) {
      lastError = error;
      rmSync(partial, { force: true });
      console.warn(`[stt-model] 下载失败（第 ${attempt}/3 次）：${error instanceof Error ? error.message : error}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw new Error(`[stt-model] 下载失败：${lastError instanceof Error ? lastError.message : lastError}`);
}

async function extractWantedFiles(tarPath, dest, wantedFiles) {
  mkdirSync(dest, { recursive: true });
  const extract = tarStream.extract();
  extract.on("entry", (header, stream, next) => {
    const name = header.name.replace(/\\/g, "/");
    if (header.type === "directory" || !isWanted(name, wantedFiles)) {
      stream.resume();
      stream.on("end", next);
      stream.on("error", next);
      return;
    }
    const target = join(dest, name);
    if (!target.startsWith(dest + sep)) {
      stream.resume();
      stream.on("end", next);
      stream.on("error", next);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    pipeline(stream, createWriteStream(target)).then(() => next()).catch(next);
  });

  await new Promise((resolve, reject) => {
    extract.on("finish", resolve);
    extract.on("error", reject);
    createReadStream(tarPath)
      .pipe(unbzip2())
      .on("error", reject)
      .pipe(extract);
  });
}

function isWanted(name, wantedFiles) {
  if (name.endsWith("/")) return false;
  const base = name.slice(name.lastIndexOf("/") + 1);
  return wantedFiles.includes(base);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex").toUpperCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const force = process.argv.includes("--force");
  const wantTts = process.argv.includes("--tts");
  const wantAll = process.argv.includes("--all");
  const tasks = [];
  if (!wantTts || wantAll) tasks.push(ensureSttModel({ force }));
  if (wantTts || wantAll) tasks.push(ensureTtsModel({ force }));
  Promise.all(tasks)
    .then((dirs) => {
      for (const dir of dirs) {
        if (dir) console.log(`[voice-model] done: ${dir}`);
      }
    })
    .catch((error) => {
      console.error("[voice-model] failed:", error);
      process.exit(1);
    });
}
