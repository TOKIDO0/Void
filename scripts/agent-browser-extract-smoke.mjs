// 阶段 G2 + N1 冒烟：
// 1) open example.com → browser.extract 得到标题/链接 JSON
// 2) 本地静态页：唯一选择器保留 suggestedSelector；非唯一省略
// 前置：sidecar 已启动（npm run dev:bridge）
// 用法：VOID_BROWSER_HEADLESS=1 npx tsx scripts/agent-browser-extract-smoke.mjs
// 可选：VOID_BRIDGE_PORT

import http from "node:http";

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const taskId = `extract_smoke_${Date.now().toString(36)}`;

/** 本地对照页：唯一 id / testid + 多条同文案/同路径前缀链接 */
const LOCAL_FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Extract Uniqueness Fixture</title></head>
<body>
  <h1>Extract Uniqueness Fixture</h1>
  <a id="unique-anchor" href="https://example.com/unique-path-only">Unique Path Link</a>
  <a data-testid="solo-action" href="https://example.com/solo">Solo TestId</a>
  <a href="https://example.com/shared/alpha">Shared Label</a>
  <a href="https://example.com/shared/beta">Shared Label</a>
  <a href="https://example.com/shared/gamma">Shared Label</a>
  <p>Visible paragraph for text mode.</p>
</body>
</html>`;

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

/**
 * 起一个只服务对照 HTML 的临时 HTTP 服务，返回 { origin, close }。
 * 用 127.0.0.1 + 随机端口，测完即关。
 */
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(LOCAL_FIXTURE_HTML);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture server 未绑定端口"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          })
      });
    });
  });
}

async function assertExampleComExtract(opened) {
  const extracted = await post("/void-browser/extract", {
    taskId,
    pageId: opened.pageId,
    mode: "both",
    limit: 20
  });

  console.log("[agent-browser-extract-smoke] example.com structured JSON:");
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

  const blob = extracted.items.map((item) => item.text).join(" ");
  if (!/example/i.test(extracted.pageTitle) && !/example/i.test(blob)) {
    console.warn(
      "[agent-browser-extract-smoke] WARN: 未在 title/items 中看到 Example 字样，仍计通过（结构有效）"
    );
  }

  // example.com 上「More information…」类链接通常可生成唯一 suggestedSelector
  const withSelector = extracted.items.filter(
    (item) => typeof item.suggestedSelector === "string" && item.suggestedSelector.length > 0
  );
  console.log(
    `[agent-browser-extract-smoke] example.com suggestedSelector 条数=${withSelector.length}/${extracted.items.length}`
  );

  return { hasLink, hasText, count: extracted.count };
}

/**
 * N1 对照：唯一 id/testid 必须带 suggestedSelector；
 * 三条同文案 Shared Label 不得靠 a:has-text 冒充唯一（应省略或落到含不同 path 的唯一候选）。
 */
async function assertUniquenessFixture(fixtureOrigin) {
  const opened = await post("/void-browser/open", {
    taskId,
    url: fixtureOrigin
  });
  console.log(
    `[agent-browser-extract-smoke] fixture opened title=${opened.title} url=${opened.finalUrl}`
  );

  const extracted = await post("/void-browser/extract", {
    taskId,
    pageId: opened.pageId,
    mode: "links",
    limit: 20
  });

  console.log("[agent-browser-extract-smoke] fixture items:");
  console.log(JSON.stringify(extracted.items, null, 2));

  const byText = (text) =>
    extracted.items.find((item) => item.kind === "link" && item.text === text);

  const uniquePath = byText("Unique Path Link");
  const soloTestId = byText("Solo TestId");
  const sharedItems = extracted.items.filter(
    (item) => item.kind === "link" && item.text === "Shared Label"
  );

  if (!uniquePath) {
    throw new Error("fixture 缺少 Unique Path Link");
  }
  if (!soloTestId) {
    throw new Error("fixture 缺少 Solo TestId");
  }
  if (sharedItems.length < 2) {
    throw new Error(`fixture Shared Label 期望 ≥2 条，实际 ${sharedItems.length}`);
  }

  // —— 唯一对照：必须有 suggestedSelector，且应落到 id / testid / 含 unique-path 的选择器 ——
  if (!uniquePath.suggestedSelector) {
    throw new Error(
      "唯一项 Unique Path Link 缺少 suggestedSelector（期望 #unique-anchor 或含 unique-path）"
    );
  }
  if (
    !/#unique-anchor/.test(uniquePath.suggestedSelector)
    && !/unique-path-only/.test(uniquePath.suggestedSelector)
  ) {
    throw new Error(
      `唯一项选择器不符合预期：${uniquePath.suggestedSelector}`
    );
  }

  if (!soloTestId.suggestedSelector) {
    throw new Error("唯一项 Solo TestId 缺少 suggestedSelector（期望 data-testid）");
  }
  if (!/data-testid="solo-action"/.test(soloTestId.suggestedSelector)) {
    throw new Error(
      `Solo TestId 选择器不符合预期：${soloTestId.suggestedSelector}`
    );
  }

  // —— 非唯一对照：不得出现会匹配多条的 a:has-text("Shared Label") ——
  for (const item of sharedItems) {
    if (item.suggestedSelector === 'a:has-text("Shared Label")') {
      throw new Error(
        "非唯一项错误地返回了多匹配选择器 a:has-text(\"Shared Label\")"
      );
    }
    // 若返回了选择器，必须是能区分单条的（例如含不同 path 的 a[href*="..."]）
    if (item.suggestedSelector) {
      const isPathScoped =
        /a\[href\*=/.test(item.suggestedSelector)
        && (
          /shared\/alpha/.test(item.suggestedSelector)
          || /shared\/beta/.test(item.suggestedSelector)
          || /shared\/gamma/.test(item.suggestedSelector)
        );
      if (!isPathScoped) {
        throw new Error(
          `Shared Label 的 suggestedSelector 不够唯一：${item.suggestedSelector}`
        );
      }
    }
  }

  // 至少证明「省略多匹配」路径存在：若三条都靠 path 唯一，也算 N1 通过；
  // 额外用「故意宽选择器」语义——has-text 不得出现。
  const anyBareHasText = sharedItems.some(
    (item) => item.suggestedSelector === 'a:has-text("Shared Label")'
  );
  if (anyBareHasText) {
    throw new Error("非唯一 has-text 选择器未被过滤");
  }

  console.log("[agent-browser-extract-smoke] uniqueness 对照 PASSED");
  console.log(` - uniquePath.selector=${uniquePath.suggestedSelector}`);
  console.log(` - soloTestId.selector=${soloTestId.suggestedSelector}`);
  console.log(
    ` - shared selectors=${sharedItems.map((item) => item.suggestedSelector ?? "(omitted)").join(" | ")}`
  );
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

  let fixtureServer;
  try {
    await post("/void-browser/session/ensure", { taskId });

    // —— 1) 公网 example.com 结构冒烟 ——
    const opened = await post("/void-browser/open", {
      taskId,
      url: "https://example.com"
    });
    console.log(
      `[agent-browser-extract-smoke] opened title=${opened.title} url=${opened.finalUrl}`
    );
    const exampleStats = await assertExampleComExtract(opened);

    // —— 2) 本地 fixture：唯一 / 非唯一对照 ——
    fixtureServer = await startFixtureServer();
    await assertUniquenessFixture(fixtureServer.origin);

    console.log("[agent-browser-extract-smoke] PASSED");
    console.log(` - example count=${exampleStats.count}`);
    console.log(
      ` - hasLink=${exampleStats.hasLink} hasText=${exampleStats.hasText}`
    );
  } finally {
    try {
      await post("/void-browser/session/close", { taskId });
    } catch (error) {
      console.warn(
        "[agent-browser-extract-smoke] close session failed",
        error instanceof Error ? error.message : error
      );
    }
    if (fixtureServer) {
      await fixtureServer.close();
    }
  }
}

main().catch((error) => {
  console.error("[agent-browser-extract-smoke] FAILED", error);
  process.exitCode = 1;
});
