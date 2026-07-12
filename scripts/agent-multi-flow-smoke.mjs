// Q6 多能力串联金样例（多场景，不是单场景产品）
// 故事①：网页 extract → a11y click → type
// 故事②：下载任意样例文件 → verify → clipboard 写入路径说明
// 前置：npm run dev:bridge
// 用法：VOID_BROWSER_HEADLESS=1 npx tsx scripts/agent-multi-flow-smoke.mjs

import http from "node:http";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const finalRoot =
  process.env.VOID_DOWNLOAD_DIR?.trim()
  || "D:\\AI\\void-runtime\\downloads";

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
    body: JSON.stringify(body ?? {})
  });
  const payload = await response.json();
  if (!payload?.ok) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    const code = payload?.error?.code ?? "UNKNOWN";
    throw new Error(`${code}: ${message}`);
  }
  return payload.data;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function startMultiFixtureServer() {
  const pageHtml = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"/><title>Multi Flow Web Story</title></head>
<body>
  <h1>Multi Flow Web Story</h1>
  <button aria-label="开始填写">开始</button>
  <label for="note">备注</label>
  <input id="note" type="text" aria-label="备注输入" value="" style="display:none" />
  <p id="status">idle</p>
  <script>
    document.querySelector('button[aria-label="开始填写"]').addEventListener("click", function () {
      document.getElementById("note").style.display = "inline-block";
      document.getElementById("status").textContent = "ready-to-type";
    });
    document.getElementById("note").addEventListener("input", function (event) {
      document.getElementById("status").textContent = "typed:" + event.target.value;
    });
  </script>
</body>
</html>`;

  const fileBody = Buffer.from("void-multi-flow-sample-payload\n", "utf8");

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0];
      if (urlPath === "/web") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        });
        res.end(pageHtml);
        return;
      }
      if (urlPath === "/sample.txt") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": String(fileBody.length),
          "Content-Disposition": 'attachment; filename="multi-flow-sample.txt"',
          "Cache-Control": "no-store"
        });
        res.end(fileBody);
        return;
      }
      res.writeHead(404).end("not found");
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

/** 故事①：网页抽取 → a11y 点击 → 输入 */
async function storyWebA11y(origin) {
  const taskId = `multi_web_${Date.now().toString(36)}`;
  console.log(`\n[story1 web] taskId=${taskId}`);
  await post("/void-browser/session/ensure", { taskId });

  try {
    const opened = await post("/void-browser/open", {
      taskId,
      url: `${origin}/web`
    });
    assert(/Multi Flow/i.test(opened.title), `打开页标题异常: ${opened.title}`);

    const extracted = await post("/void-browser/extract", {
      taskId,
      pageId: opened.pageId,
      mode: "both",
      limit: 30
    });
    assert(extracted.count > 0, "extract 应有条目");
    const hasButtonRole = (extracted.items ?? []).some(
      (item) => item.role === "button" || /开始/.test(String(item.text ?? ""))
    );
    assert(hasButtonRole, "extract 应能看到开始按钮相关语义/文案");
    console.log("[story1] extract count=", extracted.count);

    // a11y 点击：无 CSS 依赖
    const clicked = await post("/void-browser/click", {
      taskId,
      pageId: opened.pageId,
      role: "button",
      name: "开始填写"
    });
    assert(clicked.role === "button", "click 应回填 role");
    console.log("[story1] click", clicked.selector);

    // 输入
    const typed = await post("/void-browser/type", {
      taskId,
      pageId: opened.pageId,
      role: "textbox",
      name: "备注输入",
      text: "void-multi-flow",
      clear: true
    });
    assert(typed.typedLength === "void-multi-flow".length, "type 长度不对");
    console.log("[story1] type", typed.selector);

    const after = await post("/void-browser/extract", {
      taskId,
      pageId: opened.pageId,
      mode: "text",
      limit: 30
    });
    const blob = (after.items ?? []).map((i) => i.text).join(" ");
    assert(
      /typed:void-multi-flow/.test(blob) || /void-multi-flow/.test(blob),
      "页面应反映输入结果"
    );
    console.log("[story1] PASSED extract→a11y click→type");
  } finally {
    try {
      await post("/void-browser/session/close", { taskId });
    } catch {
      // ignore
    }
  }
}

/** 故事②：下载任意样例 → verify → clipboard 写入路径说明 */
async function storyFileClipboard(origin) {
  const taskId = `multi_file_${Date.now().toString(36)}`;
  const destDir = path.join(finalRoot, `multi-flow-${Date.now().toString(36)}`);
  mkdirSync(destDir, { recursive: true });
  console.log(`\n[story2 file+clipboard] taskId=${taskId}`);
  console.log(`[story2] destDir=${destDir}`);

  let previousClipboard = "";
  try {
    try {
      const before = await post("/void-desktop/clipboard/read", {});
      previousClipboard = before.text ?? "";
    } catch {
      previousClipboard = "";
    }

    const downloaded = await post("/void-file/download-to-temp", {
      taskId,
      url: `${origin}/sample.txt`,
      suggestedFileName: "multi-flow-sample.txt"
    });
    assert(downloaded.mediaKind === "text", `mediaKind 应为 text，实际 ${downloaded.mediaKind}`);
    assert(downloaded.bytes > 0, "下载 bytes 应 >0");
    console.log(
      `[story2] download fileName=${downloaded.fileName} mediaKind=${downloaded.mediaKind} bytes=${downloaded.bytes}`
    );

    const placed = await post("/void-file/place-download", {
      taskId,
      tempPath: downloaded.tempPath,
      destinationDirectory: destDir,
      fileName: "multi-flow-sample.txt",
      overwritePolicy: "rename"
    });
    assert(existsSync(placed.finalPath), "落盘路径应存在");
    assert(placed.mediaKind === "text", "place mediaKind 应为 text");
    console.log(`[story2] place ${placed.finalPath}`);

    const verified = await post("/void-file/verify", { path: placed.finalPath });
    assert(verified.exists === true, "verify 应存在");
    assert(verified.mediaKind === "text", "verify mediaKind 应为 text");
    assert(typeof verified.bytes === "number" && verified.bytes === placed.bytes, "verify bytes 一致");
    console.log(
      `[story2] verify fileName=${verified.fileName} mediaKind=${verified.mediaKind} bytes=${verified.bytes}`
    );

    // 可选：把路径说明写入剪贴板（通用说明，不是某安装包专用）
    const clipboardNote =
      `VOID 已落盘样例文件：${placed.finalPath}（${placed.mediaKind}, ${placed.bytes} bytes）`;
    const written = await post("/void-desktop/clipboard/write", {
      text: clipboardNote
    });
    assert(written.length === clipboardNote.length, "clipboard write 长度应一致");

    const readBack = await post("/void-desktop/clipboard/read", {});
    assert(readBack.text === clipboardNote, "clipboard read 应与 write 一致");
    assert(readBack.text.includes(placed.finalPath), "剪贴板应含最终路径");
    console.log("[story2] clipboard path note ok");
    console.log("[story2] PASSED download→place→verify→clipboard");
  } finally {
    try {
      await post("/void-desktop/clipboard/write", { text: previousClipboard });
    } catch {
      // ignore restore failure
    }
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function main() {
  console.log(`[agent-multi-flow-smoke] bridge=${bridgeOrigin}`);
  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-multi-flow-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  const fixture = await startMultiFixtureServer();
  console.log(`[agent-multi-flow-smoke] fixture=${fixture.origin}`);

  try {
    await storyWebA11y(fixture.origin);
    await storyFileClipboard(fixture.origin);
    console.log("\n[agent-multi-flow-smoke] PASSED");
    console.log(" - 故事① 网页 extract→a11y click→type");
    console.log(" - 故事② 下载样例→verify→clipboard 路径说明（非单场景产品）");
  } catch (error) {
    console.error(
      "[agent-multi-flow-smoke] FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  } finally {
    await fixture.close();
  }
}

main();
