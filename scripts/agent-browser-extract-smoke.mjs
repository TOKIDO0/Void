// 阶段 G2 冒烟：open example.com → browser.extract 得到标题/链接 JSON
// 前置：sidecar 已启动（npm run dev:bridge）
// 用法：npx tsx scripts/agent-browser-extract-smoke.mjs
// 可选：VOID_BROWSER_HEADLESS=1；VOID_BRIDGE_PORT

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const taskId = `extract_smoke_${Date.now().toString(36)}`;

async function waitForBridge(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${bridgeOrigin}/void-bridge/health`);
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

async function post(pathname, body) {
  const response = await fetch(`${bridgeOrigin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!payload?.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    const code = payload?.error?.code ?? "UNKNOWN";
    throw new Error(`${code}: ${message}`);
  }
  return payload.data;
}

async function main() {
  console.log(`[agent-browser-extract-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-browser-extract-smoke] taskId=${taskId}`);

  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-browser-extract-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  try {
    await post("/void-browser/session/ensure", { taskId });
    const opened = await post("/void-browser/open", {
      taskId,
      url: "https://example.com"
    });
    console.log(
      `[agent-browser-extract-smoke] opened title=${opened.title} url=${opened.finalUrl}`
    );

    const extracted = await post("/void-browser/extract", {
      taskId,
      pageId: opened.pageId,
      mode: "both",
      limit: 20
    });

    console.log("[agent-browser-extract-smoke] structured JSON:");
    console.log(
      JSON.stringify(
        {
          pageTitle: extracted.pageTitle,
          pageUrl: extracted.pageUrl,
          mode: extracted.mode,
          count: extracted.count,
          items: extracted.items
        },
        null,
        2
      )
    );

    if (!extracted.pageTitle || typeof extracted.pageTitle !== "string") {
      throw new Error("缺少 pageTitle");
    }
    if (!Array.isArray(extracted.items) || extracted.items.length === 0) {
      throw new Error("items 为空，期望至少有一条链接或文案");
    }

    const hasLink = extracted.items.some(
      (item) => item.kind === "link" && typeof item.href === "string" && item.href.length > 0
    );
    const hasText = extracted.items.some(
      (item) => item.kind === "text" && typeof item.text === "string" && item.text.length > 0
    );
    if (!hasLink && !hasText) {
      throw new Error("items 中既无有效 link 也无有效 text");
    }

    // example.com 通常有 Example Domain 标题类文案或 More information 链接
    const blob = extracted.items.map((item) => item.text).join(" ");
    if (!/example/i.test(extracted.pageTitle) && !/example/i.test(blob)) {
      console.warn(
        "[agent-browser-extract-smoke] WARN: 未在 title/items 中看到 Example 字样，仍计通过（结构有效）"
      );
    }

    console.log("[agent-browser-extract-smoke] PASSED");
    console.log(` - count=${extracted.count}`);
    console.log(` - hasLink=${hasLink} hasText=${hasText}`);
  } finally {
    try {
      await post("/void-browser/session/close", { taskId });
    } catch (error) {
      console.warn(
        "[agent-browser-extract-smoke] close session failed",
        error instanceof Error ? error.message : error
      );
    }
  }
}

main().catch((error) => {
  console.error("[agent-browser-extract-smoke] FAILED", error);
  process.exitCode = 1;
});
