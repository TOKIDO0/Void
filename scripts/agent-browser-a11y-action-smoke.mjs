// Q1 冒烟：browser.click / browser.type 支持 role+name（无障碍 getByRole）
// 1) 本地 fixture 无 CSS 也能点到 aria 按钮
// 2) 多匹配 role+name 失败可读
// 3) type 用 role=textbox + name 填入
// 前置：npm run dev:bridge
// 用法：VOID_BROWSER_HEADLESS=1 npx tsx scripts/agent-browser-a11y-action-smoke.mjs

import http from "node:http";

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const taskId = `a11y_action_smoke_${Date.now().toString(36)}`;

/** 本地对照页：无稳定 CSS 也可靠 aria 点/填；另有同名按钮测多匹配 */
const LOCAL_FIXTURE_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"/><title>A11y Action Fixture</title></head>
<body>
  <h1>A11y Action Fixture</h1>
  <button aria-label="确认提交">确认</button>
  <label for="search-box">关键词搜索</label>
  <input id="search-box" type="text" aria-label="关键词搜索" value="" />
  <p id="click-log">none</p>
  <p id="typed-log">none</p>
  <button aria-label="重复动作">A</button>
  <button aria-label="重复动作">B</button>
  <script>
    document.querySelector('button[aria-label="确认提交"]').addEventListener("click", function () {
      document.getElementById("click-log").textContent = "clicked-confirm";
    });
    document.getElementById("search-box").addEventListener("input", function (event) {
      document.getElementById("typed-log").textContent = event.target.value;
    });
  </script>
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
  return { httpStatus: response.status, payload };
}

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(LOCAL_FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fixture server 未拿到端口"));
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
    server.on("error", reject);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log(`[agent-browser-a11y-action-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-browser-a11y-action-smoke] taskId=${taskId}`);

  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-browser-a11y-action-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  const fixture = await startFixtureServer();
  console.log(`[agent-browser-a11y-action-smoke] fixture=${fixture.origin}`);

  try {
    // 确保会话
    const ensure = await post("/void-browser/session/ensure", { taskId });
    assert(ensure.payload?.ok, `session/ensure 失败: ${JSON.stringify(ensure.payload)}`);

    // 打开本地 fixture（无依赖外部网）
    const opened = await post("/void-browser/open", {
      taskId,
      url: fixture.origin + "/a11y-fixture"
    });
    assert(opened.payload?.ok, `open 失败: ${JSON.stringify(opened.payload)}`);
    const pageId = opened.payload.data.pageId;
    console.log("[open] ok pageId=", pageId, "title=", opened.payload.data.title);

    // 1) 无 CSS：role+name 点击唯一 aria 按钮
    const clickOk = await post("/void-browser/click", {
      taskId,
      pageId,
      role: "button",
      name: "确认提交"
    });
    assert(clickOk.payload?.ok, `a11y click 应成功: ${JSON.stringify(clickOk.payload)}`);
    assert(
      clickOk.payload.data.role === "button"
      && clickOk.payload.data.name === "确认提交",
      "click 结果应回填 role/name"
    );
    assert(
      String(clickOk.payload.data.selector).includes('role=button'),
      `selector 标签应含 role=button，实际=${clickOk.payload.data.selector}`
    );
    console.log("[click role+name unique] ok", clickOk.payload.data.selector);

    // 验证页面副作用：通过 extract 读 click-log
    const afterClickExtract = await post("/void-browser/extract", {
      taskId,
      pageId,
      mode: "text",
      limit: 30
    });
    assert(afterClickExtract.payload?.ok, "extract after click 失败");
    const clickLogHit = (afterClickExtract.payload.data.items ?? []).some(
      (item) => String(item.text ?? "").includes("clicked-confirm")
    );
    assert(clickLogHit, "点击后页面应出现 clicked-confirm");
    console.log("[click side-effect] ok clicked-confirm");

    // 2) 多匹配 role+name：应失败且文案可读
    const clickMulti = await post("/void-browser/click", {
      taskId,
      pageId,
      role: "button",
      name: "重复动作"
    });
    assert(!clickMulti.payload?.ok, "多匹配 click 应失败");
    const multiMessage = String(clickMulti.payload?.error?.message ?? "");
    assert(
      multiMessage.includes("匹配到")
      || multiMessage.includes("收窄")
      || multiMessage.includes("个元素"),
      `多匹配错误应可读，实际: ${multiMessage}`
    );
    assert(
      clickMulti.payload?.error?.details?.count === 2
      || multiMessage.includes("2"),
      `多匹配应提示 2 个，实际: ${JSON.stringify(clickMulti.payload?.error)}`
    );
    console.log("[click role+name multi] ok fail:", multiMessage);

    // 3) type：role=textbox + name 填入
    const typeOk = await post("/void-browser/type", {
      taskId,
      pageId,
      role: "textbox",
      name: "关键词搜索",
      text: "void-a11y",
      clear: true
    });
    assert(typeOk.payload?.ok, `a11y type 应成功: ${JSON.stringify(typeOk.payload)}`);
    assert(typeOk.payload.data.typedLength === "void-a11y".length, "typedLength 不对");
    assert(typeOk.payload.data.role === "textbox", "type 应回填 role=textbox");
    console.log("[type role+name] ok", typeOk.payload.data.selector);

    const afterTypeExtract = await post("/void-browser/extract", {
      taskId,
      pageId,
      mode: "text",
      limit: 30
    });
    assert(afterTypeExtract.payload?.ok, "extract after type 失败");
    const typedHit = (afterTypeExtract.payload.data.items ?? []).some(
      (item) => String(item.text ?? "").includes("void-a11y")
    );
    assert(typedHit, "输入后页面应出现 void-a11y");
    console.log("[type side-effect] ok void-a11y");

    // 4) 缺定位目标：应 INVALID_REQUEST
    const missingTarget = await post("/void-browser/click", {
      taskId,
      pageId
    });
    assert(!missingTarget.payload?.ok, "缺定位应失败");
    console.log("[missing target] ok", missingTarget.payload?.error?.message);

    // 5) 兼容旧路径：selector 仍可用
    const selectorClick = await post("/void-browser/click", {
      taskId,
      pageId,
      selector: 'button[aria-label="确认提交"]'
    });
    assert(selectorClick.payload?.ok, `selector click 应仍可用: ${JSON.stringify(selectorClick.payload)}`);
    console.log("[selector compat] ok", selectorClick.payload.data.selector);

    console.log("[agent-browser-a11y-action-smoke] PASSED");
  } catch (error) {
    console.error(
      "[agent-browser-a11y-action-smoke] FAILED:",
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
