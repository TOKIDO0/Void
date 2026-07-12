// Q2 冒烟：多标签页 list + switch + extract 标题不同
// 流程：open URL_A → open URL_B → tabs(count>=2) → switch 到 A → extract 标题像 A
//      → switch 到 B → extract 标题像 B
// 前置：npm run dev:bridge
// 用法：VOID_BROWSER_HEADLESS=1 npx tsx scripts/agent-browser-tabs-smoke.mjs

import http from "node:http";

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const taskId = `tabs_smoke_${Date.now().toString(36)}`;

const PAGE_A_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Tab Alpha Page</title></head>
<body><h1>Alpha Content</h1><p>page-marker-alpha</p></body></html>`;

const PAGE_B_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Tab Beta Page</title></head>
<body><h1>Beta Content</h1><p>page-marker-beta</p></body></html>`;

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

function startDualFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      const html = url.startsWith("/beta") ? PAGE_B_HTML : PAGE_A_HTML;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(html);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log(`[agent-browser-tabs-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-browser-tabs-smoke] taskId=${taskId}`);

  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-browser-tabs-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  const fixture = await startDualFixtureServer();
  const urlA = `${fixture.origin}/alpha`;
  const urlB = `${fixture.origin}/beta`;
  console.log(`[agent-browser-tabs-smoke] fixture A=${urlA}`);
  console.log(`[agent-browser-tabs-smoke] fixture B=${urlB}`);

  try {
    await post("/void-browser/session/ensure", { taskId });

    const openA = await post("/void-browser/open", { taskId, url: urlA });
    assert(openA.pageId, "open A 应返回 pageId");
    assert(/Alpha/i.test(openA.title), `A 标题应含 Alpha，实际=${openA.title}`);
    console.log("[open A]", openA.pageId, openA.title);

    const openB = await post("/void-browser/open", { taskId, url: urlB });
    assert(openB.pageId, "open B 应返回 pageId");
    assert(openB.pageId !== openA.pageId, "两次 open 应产生不同 pageId");
    assert(/Beta/i.test(openB.title), `B 标题应含 Beta，实际=${openB.title}`);
    console.log("[open B]", openB.pageId, openB.title);

    const tabs = await post("/void-browser/tabs", { taskId });
    assert(tabs.count >= 2, `tabs.count 应 >=2，实际=${tabs.count}`);
    assert(Array.isArray(tabs.tabs) && tabs.tabs.length >= 2, "tabs.tabs 长度不足");
    const pageIds = new Set(tabs.tabs.map((t) => t.pageId));
    assert(pageIds.has(openA.pageId) && pageIds.has(openB.pageId), "tabs 应包含 A/B pageId");
    // 最后一次 open 的 B 应为活动页
    assert(
      tabs.activePageId === openB.pageId
      || tabs.tabs.some((t) => t.pageId === openB.pageId && t.active),
      `活动页应是 B，activePageId=${tabs.activePageId}`
    );
    console.log("[tabs]", JSON.stringify(tabs, null, 2));

    // 切到 A，extract 标题/文案应像 Alpha
    const switchedA = await post("/void-browser/switch-tab", {
      taskId,
      pageId: openA.pageId
    });
    assert(switchedA.pageId === openA.pageId, "switch 到 A 失败");
    console.log("[switch A]", switchedA.title);

    const extractA = await post("/void-browser/extract", {
      taskId,
      mode: "text",
      limit: 20
    });
    assert(/Alpha/i.test(extractA.pageTitle), `切到 A 后 title 应含 Alpha，实际=${extractA.pageTitle}`);
    const blobA = (extractA.items ?? []).map((i) => i.text).join(" ");
    assert(
      /page-marker-alpha/i.test(blobA) || /Alpha/i.test(blobA),
      "切到 A 后 extract 应含 Alpha 内容"
    );
    console.log("[extract A] title=", extractA.pageTitle);

    // 切到 B
    const switchedB = await post("/void-browser/switch-tab", {
      taskId,
      pageId: openB.pageId
    });
    assert(switchedB.pageId === openB.pageId, "switch 到 B 失败");
    console.log("[switch B]", switchedB.title);

    const extractB = await post("/void-browser/extract", {
      taskId,
      mode: "text",
      limit: 20
    });
    assert(/Beta/i.test(extractB.pageTitle), `切到 B 后 title 应含 Beta，实际=${extractB.pageTitle}`);
    const blobB = (extractB.items ?? []).map((i) => i.text).join(" ");
    assert(
      /page-marker-beta/i.test(blobB) || /Beta/i.test(blobB),
      "切到 B 后 extract 应含 Beta 内容"
    );
    assert(
      extractA.pageTitle !== extractB.pageTitle,
      "A/B extract 标题应不同"
    );
    console.log("[extract B] title=", extractB.pageTitle);

    // 切到不存在 pageId 应失败
    let missingFailed = false;
    try {
      await post("/void-browser/switch-tab", {
        taskId,
        pageId: "page_does_not_exist_xyz"
      });
    } catch (error) {
      missingFailed = true;
      console.log("[switch missing] ok fail:", error instanceof Error ? error.message : error);
    }
    assert(missingFailed, "不存在的 pageId 应失败");

    console.log("[agent-browser-tabs-smoke] PASSED");
  } catch (error) {
    console.error(
      "[agent-browser-tabs-smoke] FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  } finally {
    try {
      await post("/void-browser/session/close", { taskId });
    } catch {
      // ignore
    }
    await fixture.close();
  }
}

main();
