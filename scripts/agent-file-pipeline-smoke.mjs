// Q3 冒烟：通用下载链路（任意扩展名样例，非 Python 专用）
// 1) 本地 HTTP 提供 .bin / .zip / .txt → downloadToTemp → place → verify
// 2) summary 字段含 mediaKind + bytes + fileName
// 3) 非法目录 place 失败且 failureKind/path 可读
// 前置：npm run dev:bridge
// 用法：npx tsx scripts/agent-file-pipeline-smoke.mjs

import http from "node:http";
import path from "node:path";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const taskId = `file_pipeline_${Date.now().toString(36)}`;
const finalRoot =
  process.env.VOID_DOWNLOAD_DIR?.trim()
  || "D:\\AI\\void-runtime\\downloads";
const destDir = path.join(finalRoot, `pipeline-smoke-${Date.now().toString(36)}`);

/** 多扩展名样例：通用文件，禁止写死某安装包 */
const FIXTURES = {
  "/sample.txt": {
    body: Buffer.from("void-file-pipeline-text-sample\n", "utf8"),
    contentType: "text/plain; charset=utf-8",
    expectKind: "text",
    fileName: "sample.txt"
  },
  "/sample.zip": {
    // 最小伪 zip 头（不需可解压，只测下载/分类）
    body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x76, 0x6f, 0x69, 0x64]),
    contentType: "application/zip",
    expectKind: "archive",
    fileName: "sample.zip"
  },
  "/sample.bin": {
    body: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]),
    contentType: "application/octet-stream",
    expectKind: "binary",
    fileName: "sample.bin"
  }
};

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
      const urlPath = (req.url ?? "/").split("?")[0];
      const fixture = FIXTURES[urlPath];
      if (!fixture) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": fixture.contentType,
        "Content-Length": String(fixture.body.length),
        "Content-Disposition": `attachment; filename="${fixture.fileName}"`,
        "Cache-Control": "no-store"
      });
      res.end(fixture.body);
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

async function runHappyPath(origin, routeKey) {
  const fixture = FIXTURES[routeKey];
  const url = `${origin}${routeKey}`;
  console.log(`\n[case ${fixture.fileName}] url=${url}`);

  const download = await post("/void-file/download-to-temp", {
    taskId,
    url,
    suggestedFileName: fixture.fileName
  });
  assert(download.payload?.ok, `download 失败: ${JSON.stringify(download.payload)}`);
  const d = download.payload.data;
  assert(typeof d.fileName === "string" && d.fileName.length > 0, "download 缺 fileName");
  assert(typeof d.bytes === "number" && d.bytes > 0, "download 缺 bytes");
  assert(d.mediaKind === fixture.expectKind, `download mediaKind 期望 ${fixture.expectKind} 实际 ${d.mediaKind}`);
  assert(existsSync(d.tempPath), "tempPath 应存在");
  console.log(
    `  download ok: fileName=${d.fileName} mediaKind=${d.mediaKind} bytes=${d.bytes}`
  );

  const place = await post("/void-file/place-download", {
    taskId,
    tempPath: d.tempPath,
    destinationDirectory: destDir,
    fileName: fixture.fileName,
    overwritePolicy: "rename"
  });
  assert(place.payload?.ok, `place 失败: ${JSON.stringify(place.payload)}`);
  const p = place.payload.data;
  assert(p.fileName, "place 缺 fileName");
  assert(typeof p.bytes === "number" && p.bytes > 0, "place 缺 bytes");
  assert(p.mediaKind === fixture.expectKind, `place mediaKind 期望 ${fixture.expectKind} 实际 ${p.mediaKind}`);
  assert(existsSync(p.finalPath), "finalPath 应存在");
  console.log(
    `  place ok: fileName=${p.fileName} mediaKind=${p.mediaKind} bytes=${p.bytes} → ${p.finalPath}`
  );

  const verify = await post("/void-file/verify", { path: p.finalPath });
  assert(verify.payload?.ok, `verify 失败: ${JSON.stringify(verify.payload)}`);
  const v = verify.payload.data;
  assert(v.exists === true, "verify 应存在");
  assert(v.mediaKind === fixture.expectKind, `verify mediaKind 期望 ${fixture.expectKind} 实际 ${v.mediaKind}`);
  assert(typeof v.bytes === "number" && v.bytes === p.bytes, "verify bytes 应与 place 一致");
  assert(v.fileName === p.fileName || String(v.fileName).includes(fixture.fileName.replace(/\.\w+$/, "")), "verify fileName 可读");
  console.log(
    `  verify ok: fileName=${v.fileName} mediaKind=${v.mediaKind} bytes=${v.bytes}`
  );

  // 内容完整性（二进制按长度+首字节粗检）
  const written = readFileSync(p.finalPath);
  assert(written.length === fixture.body.length, "落盘字节数应与样例一致");
  return { download: d, place: p, verify: v };
}

async function main() {
  console.log(`[agent-file-pipeline-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-file-pipeline-smoke] taskId=${taskId}`);
  console.log(`[agent-file-pipeline-smoke] destDir=${destDir}`);

  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-file-pipeline-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(destDir, { recursive: true });
  const fixture = await startFixtureServer();
  console.log(`[agent-file-pipeline-smoke] fixture=${fixture.origin}`);

  try {
    // 三种扩展名闭环
    await runHappyPath(fixture.origin, "/sample.txt");
    await runHappyPath(fixture.origin, "/sample.zip");
    await runHappyPath(fixture.origin, "/sample.bin");

    // 预检失败：非法目录 → 必须 PATH_NOT_ALLOWED（先于 temp 存在性检查）
    const badPlace = await post("/void-file/place-download", {
      taskId,
      tempPath: path.join(destDir, "no-such-temp.bin"),
      destinationDirectory: "C:\\Windows\\System32\\void-not-allowed",
      fileName: "nope.bin",
      overwritePolicy: "refuse"
    });
    assert(!badPlace.payload?.ok, "非法目录 place 应失败");
    const err = badPlace.payload?.error;
    const errCode = String(err?.code ?? "");
    const errMsg = String(err?.message ?? "");
    assert(
      errCode === "PATH_NOT_ALLOWED" || /白名单|PATH_NOT_ALLOWED/.test(errMsg),
      `非法目录错误应 PATH_NOT_ALLOWED，实际 code=${errCode} msg=${errMsg}`
    );
    console.log(`\n[precheck fail] ok code=${errCode} msg=${errMsg}`);

    // 白名单路径但 temp 不存在 → FILE_NOT_FOUND
    const missingTemp = await post("/void-file/place-download", {
      taskId,
      tempPath: path.join(destDir, "missing-temp-file.bin"),
      destinationDirectory: destDir,
      fileName: "missing.bin",
      overwritePolicy: "rename"
    });
    assert(!missingTemp.payload?.ok, "缺 temp 应失败");
    assert(
      missingTemp.payload?.error?.code === "FILE_NOT_FOUND"
      || /不存在/.test(String(missingTemp.payload?.error?.message ?? "")),
      `缺 temp 应 FILE_NOT_FOUND，实际 ${JSON.stringify(missingTemp.payload?.error)}`
    );
    console.log(
      `[missing temp] ok code=${missingTemp.payload?.error?.code}`
    );

    console.log("\n[agent-file-pipeline-smoke] PASSED");
    console.log(" - .txt/.zip/.bin 闭环；mediaKind+bytes+fileName 齐全；预检失败可读");
  } catch (error) {
    console.error(
      "[agent-file-pipeline-smoke] FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  } finally {
    await fixture.close();
    try {
      rmSync(destDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup
    }
  }
}

main();
