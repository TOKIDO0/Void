// 阶段 C 冒烟：「搜索 X」端到端 → 结构化 JSON（标题/URL 列表）
// 前置：sidecar 已启动（npm run dev:bridge 或 tauri:dev）
// 用法：npx tsx scripts/agent-browser-search-smoke.mjs [关键词]
// 可选环境：VOID_BROWSER_HEADLESS=1 无头；VOID_BRIDGE_PORT 覆盖端口

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

async function waitForBridge(origin, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${origin}/void-bridge/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const query = (process.argv[2] ?? "Playwright browser automation").trim();
  const bridgeOrigin =
    process.env.VOID_BRIDGE_ORIGIN
    ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

  console.log(`[agent-browser-search-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-browser-search-smoke] query=${query}`);

  const ready = await waitForBridge(bridgeOrigin);
  if (!ready) {
    console.error(
      "[agent-browser-search-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  const entry = pathToFileURL(
    path.join(root, "src/features/agent/browser/runBrowserSearchTask.ts")
  ).href;
  const { runBrowserSearchTask } = await import(entry);

  const result = await runBrowserSearchTask({
    query,
    limit: 8,
    takeScreenshot: true
  });

  // 验收要求：结构化结果（标题/URL 列表），打印 JSON
  console.log("[agent-browser-search-smoke] structured JSON:");
  console.log(JSON.stringify(result.structured, null, 2));

  if (!result.ok) {
    console.error("[agent-browser-search-smoke] FAILED");
    console.error(" taskStatus=", result.structured.taskStatus);
    console.error(" report=", result.structured.reportMessage);
    if (result.structured.results.length === 0) {
      console.error(" results 为空");
    }
    process.exitCode = 1;
    return;
  }

  // 资源锁应已清空
  const locksEntry = pathToFileURL(
    path.join(root, "src/features/agent/resources/resourceLockManager.ts")
  ).href;
  const { listActiveResourceLocks } = await import(locksEntry);
  const locks = listActiveResourceLocks();
  if (locks.length > 0) {
    console.error("[agent-browser-search-smoke] FAILED: 资源锁残留", locks);
    process.exitCode = 1;
    return;
  }

  console.log("[agent-browser-search-smoke] PASSED");
  console.log(` - results=${result.structured.results.length}`);
  console.log(` - resultPageUrl=${result.structured.resultPageUrl ?? ""}`);
  console.log(` - screenshotPath=${result.structured.screenshotPath ?? ""}`);
  console.log(` - taskId=${result.structured.taskId}`);
}

main().catch((error) => {
  console.error("[agent-browser-search-smoke] crashed", error);
  process.exitCode = 1;
});
