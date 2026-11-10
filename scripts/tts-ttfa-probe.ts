/**
 * TTS 首字延迟（TTFA）分段实测 —— 只读探针，不改任何生产代码。
 *
 * 目的：把「用户发消息 → 首帧出声」拆成可测量、可归因的几段，
 * 用真实数据回答「换 TTS 引擎能不能把 TTFA 压到 2 秒」。
 *
 * 测量范围：
 *  1. 冷启动：拉起 Python 服务 → /health 可用 → 模型加载完成；
 *  2. 分块：用生产模块 speechChunking.ts 模拟逐字到达，量出「首块要等多少字」；
 *  3. TTS：按首块/后续块/长句三档实测 TTFB 与总时长；
 *  4. 缓存：同句第二次命中的耗时；
 *  5. 并发：orchestrator 用 2 个 worker，实测 Python 侧是否真的并行。
 *
 * 不测量（需要真实模型供应商配置，脚本无权也不该读取）：
 *  - LLM 首 token 延迟、首块 16 字到达耗时。
 *  脚本会据此算出「留给 LLM 的预算」，由真人跑一轮日志核对。
 *
 * 用法：
 *  npx tsx scripts/tts-ttfa-probe.ts
 *  npx tsx scripts/tts-ttfa-probe.ts --device cuda:0 --port 0
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { extractReadySentences } from "../src/features/voice/tts/speechChunking";

const STARTUP_TIMEOUT_MS = 180_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/** 播放器 worklet 的启动缓冲（voicePcmPlaybackProcessor.js START_BUFFER_MS）。 */
const PLAYBACK_START_BUFFER_MS = 200;

type EngineConfig = {
  python: string;
  script: string;
  modelDir: string;
  device: string;
  engineRoot: string;
};

type TtsSample = {
  caseId: string;
  text: string;
  chars: number;
  ttfbMs: number;
  totalMs: number;
  bytes: number;
  sampleRate: number;
  /** 该块生成的音频时长（秒），PCM16LE 单声道：字节数 / (采样率 × 2)。 */
  audioSeconds: number;
  /** RTF = 生成耗时 / 音频时长。>1 表示生成追不上播放，连续播放必然累积空洞。 */
  rtf: number;
  cached: boolean;
};

type ChunkProbe = {
  reply: string;
  firstChunk: string;
  firstChunkChars: number;
  charsWaited: number;
  chunkCount: number;
};

function runtimeRoot(): string {
  return process.env.VOID_RUNTIME_ROOT?.trim() || "D:\\AI\\void-runtime";
}

function resolveEngineConfig(deviceOverride?: string): EngineConfig | null {
  const root = runtimeRoot();
  const engineRoot = process.env.VOID_QWEN_TTS_ENGINE_ROOT?.trim()
    || join(root, "voice-engines", "qwen3-tts");
  const manifestPath = join(engineRoot, "engine.json");

  let manifest: { python?: string; modelDir?: string; server?: string } | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      manifest = null;
    }
  }

  const python = process.env.VOID_QWEN_TTS_PYTHON?.trim() || manifest?.python?.trim() || "";
  const modelDir = process.env.VOID_QWEN_TTS_MODEL_DIR?.trim() || manifest?.modelDir?.trim() || "";
  const script = process.env.VOID_QWEN_TTS_SCRIPT?.trim()
    || manifest?.server?.trim()
    || join(process.cwd(), "server", "voice", "qwen3tts", "qwen3_tts_server.py");
  const device = deviceOverride || process.env.VOID_QWEN_TTS_DEVICE?.trim() || "cuda:0";

  if (!python || !modelDir) return null;
  if (!existsSync(python) || !existsSync(script) || !existsSync(modelDir)) return null;
  return { python, script, modelDir, device, engineRoot };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function probeHealth(port: number, token: string): Promise<{ loaded: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-VOID-Qwen-Token": token },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const payload = await response.json() as { ok?: boolean; loaded?: boolean };
    if (payload.ok !== true) return null;
    return { loaded: payload.loaded === true };
  } catch {
    return null;
  }
}

async function waitForHealth(port: number, token: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(port, token);
    if (health) return performance.now() - started;
    await sleep(300);
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有通过健康检查`);
}

async function waitForModelLoaded(port: number, token: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(port, token);
    if (health?.loaded) return performance.now() - started;
    await sleep(500);
  }
  throw new Error(`模型在 ${timeoutMs}ms 内没有加载完成`);
}

async function synthesizeOnce(
  port: number,
  token: string,
  caseId: string,
  text: string
): Promise<TtsSample> {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VOID-Qwen-Token": token
    },
    body: JSON.stringify({ text, speaker: "ono_anna", language: "zh", style: "neutral" }),
    signal: AbortSignal.timeout(120_000)
  });
  // 服务端先 send_response/headers，再在生成完成后 write(pcm)：
  // 所以 TTFB 已经等价于「整块生成完」，这是当前无流式的直接证据。
  const ttfbMs = performance.now() - started;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`合成失败 HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const totalMs = performance.now() - started;
  const sampleRate = Number(response.headers.get("x-void-tts-sample-rate") || "24000");
  const audioSeconds = buffer.length / (sampleRate * 2);
  return {
    caseId,
    text,
    chars: text.length,
    ttfbMs,
    totalMs,
    bytes: buffer.length,
    sampleRate,
    audioSeconds,
    rtf: audioSeconds > 0 ? (totalMs / 1000) / audioSeconds : 0,
    cached: response.headers.get("x-void-tts-cached") === "1"
  };
}

/** 逐字到达，复刻 VoidStage.tsx 的 push 逻辑，量首块需要等多少字。 */
function probeChunking(reply: string): ChunkProbe {
  let cursor = 0;
  let emittedChunkCount = 0;
  let firstChunk = "";
  let charsWaited = 0;
  let chunkCount = 0;

  for (let index = 0; index < reply.length; index += 1) {
    // 关键：只喂「已经到达的前缀」，复刻真实流式；不能把整段未到达文本交给分块器。
    const segment = reply.slice(cursor, index + 1);
    const { sentences, consumedLength } = extractReadySentences(segment, false, emittedChunkCount);
    if (!sentences.length) continue;
    if (!firstChunk) {
      firstChunk = sentences[0];
      charsWaited = index + 1;
    }
    cursor += consumedLength;
    emittedChunkCount += sentences.length;
    chunkCount += sentences.length;
  }

  const tail = reply.slice(cursor);
  if (tail.trim()) {
    const { sentences } = extractReadySentences(tail, true, emittedChunkCount);
    if (sentences.length) {
      if (!firstChunk) {
        firstChunk = sentences[0];
        charsWaited = reply.length;
      }
      chunkCount += sentences.length;
    }
  }

  return {
    reply,
    firstChunk,
    firstChunkChars: firstChunk.length,
    charsWaited,
    chunkCount
  };
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

function fmt(value: number): string {
  return `${value.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const deviceArg = args.indexOf("--device");
  const requestedPort = portArg >= 0 ? Number(args[portArg + 1]) : 0;
  const device = deviceArg >= 0 ? args[deviceArg + 1] : undefined;

  // 只量分块、不启动引擎：改完分块阈值后快速回归用。
  if (args.includes("--chunk-only")) {
    const replies = [
      "今天天气不错，我们一起出去走走吧。",
      "好的，我马上帮你看看这个问题，先别着急。",
      "我刚看完你发来的那封邮件，里面提到的两个问题都可以处理。",
      "这个问题需要分两步解决，先把数据补齐，再看具体是哪一环出了问题。",
      "好的。明白了。我这就去办。还有别的事吗？",
      "嗯。可以。没问题。"
    ];
    console.log("=== 分块器实测（按 VoidStage 逐字 push 逻辑）===");
    for (const probe of replies.map(probeChunking)) {
      console.log(
        `  首块 ${String(probe.firstChunkChars).padStart(2)} 字 / 需等 ${String(probe.charsWaited).padStart(2)} 字`
        + ` / 共 ${probe.chunkCount} 块 → "${probe.firstChunk}"`
      );
    }
    return;
  }

  const config = resolveEngineConfig(device);
  if (!config) {
    console.error("[probe] 找不到可用的 Qwen3-TTS 引擎配置。");
    console.error("        需要 D:\\AI\\void-runtime\\voice-engines\\qwen3-tts\\engine.json 指向真实 python / modelDir / server。");
    process.exitCode = 1;
    return;
  }

  console.log("=== TTS TTFA 分段实测 ===");
  console.log(`引擎: ${config.engineRoot}`);
  console.log(`模型: ${config.modelDir}`);
  console.log(`设备: ${config.device}`);
  console.log("");

  const port = requestedPort > 0 ? requestedPort : await getFreePort();
  const token = `probe-${Date.now().toString(36)}`;
  const child: ChildProcess = spawn(config.python, [
    config.script,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--model-dir", config.modelDir,
    "--device", config.device,
    "--token", token,
    // 探针期间禁用空闲卸载，避免中途卸载模型污染样本。
    "--idle-unload", "0"
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const engineLog: string[] = [];
  const collect = (chunk: Buffer) => {
    const line = String(chunk).trim();
    if (line) engineLog.push(line);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = () => {
    try { child.kill(); } catch { /* 已退出 */ }
  };
  process.on("exit", stop);
  process.on("SIGINT", () => { stop(); process.exit(130); });

  try {
    const listenMs = await waitForHealth(port, token, STARTUP_TIMEOUT_MS);
    console.log(`[1] 服务可连接: ${fmt(listenMs)}（进程启动 → /health 通过）`);

    const loadMs = await waitForModelLoaded(port, token, STARTUP_TIMEOUT_MS);
    console.log(`[2] 模型加载完成: ${fmt(loadMs)}`);
    console.log("    （真实产品路径在后台预热，这段不计入用户等待；仅首次安装后第一轮会撞上）");
    console.log("");

    // 预热请求：吃掉首句编译成本，不计入样本。
    await synthesizeOnce(port, token, "warmup", "你好。").catch((error) => {
      console.warn("[probe] 预热请求失败，后续数据可能包含首句编译成本:", error instanceof Error ? error.message : error);
    });

    // ── 分块：首块要等多少字 ────────────────────────────────────────────
    const replies = [
      "今天天气不错，我们一起出去走走吧。",
      "好的，我马上帮你看看这个问题，先别着急。",
      "我刚看完你发来的那封邮件，里面提到的两个问题都可以处理。",
      "这个问题需要分两步解决，先把数据补齐，再看具体是哪一环出了问题。"
    ];
    const chunkProbes = replies.map(probeChunking);
    console.log("[3] 分块器实测（按 VoidStage 逐字 push 逻辑）");
    for (const probe of chunkProbes) {
      console.log(
        `    首块 ${String(probe.firstChunkChars).padStart(2)} 字 / 需等 ${String(probe.charsWaited).padStart(2)} 字`
        + ` / 共 ${probe.chunkCount} 块 → "${probe.firstChunk}"`
      );
    }
    console.log("");

    // ── TTS 生成：首块 / 后续块 / 长句 ─────────────────────────────────
    const cases: Array<{ id: string; texts: string[] }> = [
      {
        id: "极短(6-8字)",
        texts: [
          "好的，马上。",
          "我这就去办。",
          "别急，我看看。"
        ]
      },
      {
        id: "首块(≈13字)",
        texts: [
          "今天天气不错，出去走走吧。",
          "我刚到家，你先休息一会儿。",
          "这个问题我想一下再回答。"
        ]
      },
      {
        id: "后续块(≈32字)",
        texts: [
          "我刚看完你发来的那封邮件，里面提到的两个问题都可以处理。",
          "这个问题需要分两步解决，先把数据补齐，再看是哪一环出了问题。",
          "今天下午的会议改到三点，你先把材料整理好发给我。"
        ]
      },
      {
        id: "长句(≈50字)",
        texts: [
          "我今天下午去了趟医院，医生说没什么大问题，就是最近休息不够，让我少熬夜多喝水，过两周再去复查一下。",
          "这个方案我倾向于先小范围试运行一周，确认稳定之后再推给全部用户，避免一上来就出问题。"
        ]
      }
    ];

    const samples: TtsSample[] = [];
    for (const testCase of cases) {
      console.log(`[4] ${testCase.id}`);
      for (const [index, text] of testCase.texts.entries()) {
        const sample = await synthesizeOnce(port, token, `${testCase.id}#${index + 1}`, text);
        samples.push(sample);
        console.log(
          `    ${String(sample.chars).padStart(2)} 字  TTFB ${fmt(sample.ttfbMs).padStart(8)}`
          + `  音频 ${sample.audioSeconds.toFixed(1).padStart(4)}s`
          + `  RTF ${sample.rtf.toFixed(2)}`
          + `  ${(sample.ttfbMs / sample.totalMs * 100).toFixed(1)}% 处才拿到首字节`
        );
      }
    }
    console.log("");

    // ── 缓存 ──────────────────────────────────────────────────────────
    // 用前面样本没出现过的独立句子，否则首次请求就已经命中缓存，测不到真实生成。
    const cacheText = "缓存探针独立句子，前面所有样本都没有出现过。";
    const cacheSample = await synthesizeOnce(port, token, "cache#1", cacheText);
    const cacheHitSample = await synthesizeOnce(port, token, "cache#2", cacheText);
    console.log("[5] 缓存");
    console.log(`    首次 ${fmt(cacheSample.totalMs)} / cached=${cacheSample.cached}`);
    console.log(`    再次 ${fmt(cacheHitSample.totalMs)} / cached=${cacheHitSample.cached}`);
    console.log("");

    // ── 并发：orchestrator 有 2 个 worker，Python 侧是否真的并行 ────────
    // 先用两个只跑一次的句子拿串行基线，再用另外两句同时发，对比墙钟。
    const aloneA = await synthesizeOnce(port, token, "alone#1", "我先把今天的会议纪要整理一下，再发给你确认。");
    const aloneB = await synthesizeOnce(port, token, "alone#2", "这个报错看起来是依赖版本不一致，我先核对一下锁文件。");
    const parallelStart = performance.now();
    const [left, right] = await Promise.all([
      synthesizeOnce(port, token, "parallel#1", "我在整理今天的待办事项，稍后把结果发给你。"),
      synthesizeOnce(port, token, "parallel#2", "原因已经找到了，是缓存没有及时失效导致的。")
    ]);
    const parallelWallMs = performance.now() - parallelStart;
    const serialExpectation = aloneA.totalMs + aloneB.totalMs;
    console.log("[6] 并发（2 路同时请求，模拟 STREAMING_SENTENCE_CONCURRENCY=2）");
    console.log(`    串行基线 A ${fmt(aloneA.totalMs)} / B ${fmt(aloneB.totalMs)}`);
    console.log(`    并发 A ${fmt(left.totalMs)} / B ${fmt(right.totalMs)} / 墙钟 ${fmt(parallelWallMs)}`);
    console.log(
      parallelWallMs >= serialExpectation * 0.7
        ? "    → 墙钟接近两段串行之和：Python 侧 _generate_lock 串行生成，2 个 worker 没有真正并行"
        : "    → 墙钟明显低于串行之和：存在有效并行"
    );
    console.log("");

    // ── 汇总 ──────────────────────────────────────────────────────────
    const ttfbAll = samples.map((sample) => sample.ttfbMs);
    const p50 = percentile(ttfbAll, 0.5);
    const p95 = percentile(ttfbAll, 0.95);

    console.log("=== 汇总（按档位） ===");
    console.log(`TTS 全部样本        P50 ${fmt(p50)} / P95 ${fmt(p95)}（${ttfbAll.length} 条）`);
    const bucketStats: Array<{ id: string; p50: number; p95: number; chars: number; rtf: number }> = [];
    for (const testCase of cases) {
      const bucket = samples.filter((sample) => sample.caseId.startsWith(testCase.id));
      const bucketP50 = percentile(bucket.map((sample) => sample.ttfbMs), 0.5);
      const bucketP95 = percentile(bucket.map((sample) => sample.ttfbMs), 0.95);
      const avgChars = bucket.reduce((sum, sample) => sum + sample.chars, 0) / Math.max(1, bucket.length);
      const avgRtf = bucket.reduce((sum, sample) => sum + sample.rtf, 0) / Math.max(1, bucket.length);
      bucketStats.push({ id: testCase.id, p50: bucketP50, p95: bucketP95, chars: avgChars, rtf: avgRtf });
      console.log(
        `  ${testCase.id.padEnd(14)} 均 ${avgChars.toFixed(0).padStart(2)} 字  `
        + `P50 ${fmt(bucketP50).padStart(8)} / P95 ${fmt(bucketP95).padStart(8)}`
        + `  平均 RTF ${avgRtf.toFixed(2)}`
      );
    }

    // 2 秒预算用「最短可用首块」这一档来算：产品上最激进也只能切这么短。
    const floorBucket = bucketStats[0] ?? { id: "极短", p50: 0, p95: 0, chars: 0, rtf: 0 };
    const firstP50 = floorBucket.p50;
    const firstP95 = floorBucket.p95;
    console.log("");
    console.log("=== 2 秒预算拆解（首帧出声 = 各项之和）===");
    console.log(`  LLM 首 token                : 未测（需真实供应商）`);
    console.log(`  首块到达（${floorBucket.chars.toFixed(0)} 字）             : 未测（≈ ${floorBucket.chars.toFixed(0)} / 模型出字速度）`);
    console.log(`  TTS 生成该块               : P50 ${fmt(firstP50)} / P95 ${fmt(firstP95)}（本次实测）`);
    console.log(`  播放器启动缓冲              : ${PLAYBACK_START_BUFFER_MS}ms（固定）`);
    console.log("");
    const budgetP50 = 2000 - firstP50 - PLAYBACK_START_BUFFER_MS;
    const budgetP95 = 2000 - firstP95 - PLAYBACK_START_BUFFER_MS;
    console.log(`若要端到端 P50 ≤ 2000ms，LLM 首 token + 首块到达合计必须 ≤ ${fmt(budgetP50)}`);
    console.log(`若要端到端 P95 ≤ 2000ms，LLM 首 token + 首块到达合计必须 ≤ ${fmt(budgetP95)}`);
    if (budgetP95 <= 0) {
      console.log("→ 结论：只靠当前 Qwen3（非流式）的 TTS 首块就已经吃光 2 秒预算，换播放/调度都救不回来。");
    } else {
      console.log("→ 结论：TTS 首块还留有预算，但要先测真实的 LLM 首 token 才能判断 2 秒是否可达。");
    }
    console.log("");
    // 连续性：稳态块（后续块）的 RTF 决定播放会不会断粮。
    const steadyBucket = bucketStats.find((bucket) => bucket.id.startsWith("后续块")) ?? bucketStats[0];
    console.log("=== 连续播放能力（稳态）===");
    console.log(`  稳态块平均 RTF ${steadyBucket.rtf.toFixed(2)}（>1 = 生成追不上播放）`);
    if (steadyBucket.rtf > 1) {
      console.log(
        `  → 串行生成要追平播放，至少需要 ${steadyBucket.rtf.toFixed(1)} 路真正并行的生成；`
        + `当前 Python 用 _generate_lock 串行，实际并行度 = 1。`
      );
      console.log("  → 结论：无论块切多长，口播都会累积空洞；块越长，单次空洞越大。这是当前 5–10 秒停顿的直接来源。");
    } else {
      console.log("  → 串行 RTF < 1，生成能追平播放；若仍断粮，问题在调度/播放缓冲而不是引擎速度。");
    }
    console.log("");
    console.log("=== 未测量项（必须真机跑一轮补上） ===");
    console.log("  - LLM 首 token：在模型请求发出与首个 delta 到达处打点；");
    console.log("  - 首块到达：在合成会话 push 首次收到句子的位置打点；");
    console.log("  - 播放器实际出声：worklet 的 start 事件时间。");
  } finally {
    stop();
    if (process.env.VOID_TTS_PROBE_VERBOSE === "1") {
      console.log("\n=== 引擎日志 ===");
      for (const line of engineLog) console.log(line);
    }
  }
}

main().catch((error) => {
  console.error("[probe] 失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
