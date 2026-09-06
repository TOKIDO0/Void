// C 用量记账冒烟：纯单元 + 端点 E2E（隔离运行时根，零触碰真实用量）。
// 用法：npx tsx scripts/agent-usage-smoke.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "void-usage-root-"));
  process.env.VOID_RUNTIME_ROOT = runtimeRoot;
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const store = await import(
      pathToFileURL(path.join(projectRoot, "server/usage/modelUsageStore.ts")).href
    );
    const { modelUsageStore, parseUsageFromText, extractRequestModel, withUsageStreamOptions } = store;

    // 解析：SSE 尾块 / 非流 JSON / 无 usage / 脏串
    const sseSample = 'data: {"id":"x","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}\n\ndata: [DONE]';
    const parsed = parseUsageFromText(sseSample);
    assert(parsed !== null && parsed.promptTokens === 120 && parsed.completionTokens === 30 && parsed.totalTokens === 150, "SSE usage 应解析");
    assert(parseUsageFromText('data: {"a":1}') === null, "无 usage 应回 null");
    assert(parseUsageFromText("{broken") === null, "脏串应回 null");
    const partial = parseUsageFromText('{"usage":{"prompt_tokens":7}}');
    assert(partial !== null && partial.promptTokens === 7 && partial.totalTokens === 7, "缺字段应补零求和");

    // 请求模型提取 + 流选项注入
    const body = Buffer.from(JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true }), "utf8");
    assert(extractRequestModel(body) === "deepseek-chat", "应提取模型名");
    assert(extractRequestModel(Buffer.from("xxx", "utf8")) === null, "脏 body 应回 null");
    const injected = withUsageStreamOptions(body);
    assert(JSON.parse(injected.toString("utf8")).stream_options?.include_usage === true, "缺 stream_options 应补");
    const nonStream = Buffer.from(JSON.stringify({ model: "m", messages: [], stream: false }), "utf8");
    assert(withUsageStreamOptions(nonStream) === nonStream, "非流不应改写");
    const legacy = Buffer.from(JSON.stringify({ model: "m", prompt: "hi" }), "utf8");
    assert(withUsageStreamOptions(legacy) === legacy, "无 messages 不应改写");

    // 记账：累积/按天/上限/熔断/裁剪
    const now = Date.now();
    modelUsageStore.recordCompletion({ model: "deepseek-chat", promptTokens: 100, completionTokens: 20, totalTokens: 120, responseBytes: 500, nowMs: now });
    modelUsageStore.recordCompletion({ model: "deepseek-chat", promptTokens: 50, completionTokens: 10, totalTokens: 60, responseBytes: 200, nowMs: now });
    const today = modelUsageStore.getToday(now);
    assert(today.calls === 2 && today.totalTokens === 180 && today.models["deepseek-chat"].calls === 2, "应当日累积");
    assert(modelUsageStore.isOverBudget(now) === false, "默认不限");
    modelUsageStore.setDailyTokenCap(100);
    assert(modelUsageStore.isOverBudget(now) === true, "180>=100 应熔断");
    modelUsageStore.setDailyTokenCap(0);
    assert(modelUsageStore.isOverBudget(now) === false, "清零恢复");
    assert(modelUsageStore.getLast7Days(now).length === 7, "近7日应7条");
    // 脏文件回退
    writeFileSync(path.join(runtimeRoot, "usage", "usage.json"), "{broken", "utf8");
    modelUsageStore.resetMemory();
    assert(modelUsageStore.getToday(now).calls === 0 && modelUsageStore.getDailyTokenCap() === 0, "脏文件回退空态");

    // 端点 E2E：summary + budget 设置/非法拒绝
    const { handleUsageHttpRequest } = await import(
      pathToFileURL(path.join(projectRoot, "server/usage/usageHttpHandlers.ts")).href
    );
    const httpServer = createServer((request, response) => {
      const pathname = (request.url ?? "").split("?")[0];
      void handleUsageHttpRequest(request, response, pathname);
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    try {
      const summary = await (await fetch(`${origin}/void-model-usage`)).json();
      assert(summary.ok === true && Array.isArray(summary.data.last7), "summary 应含近7日");
      const setCap = await (await fetch(`${origin}/void-model-usage/budget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyTokenCap: 500000 })
      })).json();
      assert(setCap.ok === true && setCap.data.dailyTokenCap === 500000, "预算设置应生效");
      const badCap = await (await fetch(`${origin}/void-model-usage/budget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyTokenCap: -1 })
      })).json();
      assert(badCap.ok === false, "负预算应拒绝");
      const unknown = await (await fetch(`${origin}/void-model-usage/nope`)).json();
      assert(unknown.ok === false, "未知端点应 404");
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }

    console.log("[agent-usage-smoke] PASSED");
    console.log(" - usage 解析/注入/累积/上限熔断/裁剪/脏回退全对；端点 summary/预算设置/非法拒绝全对");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("[agent-usage-smoke] FAILED", error);
  process.exitCode = 1;
});
