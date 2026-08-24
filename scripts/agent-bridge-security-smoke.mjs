import { request as httpRequest } from "node:http";

const externalBridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;
const BRIDGE_TOKEN_HEADER = "X-VOID-Bridge-Token";
const EXTERNAL_BRIDGE_MODE = process.env.VOID_BRIDGE_SMOKE_EXTERNAL === "1";

let bridgeOrigin = externalBridgeOrigin;
let bridgeToken = process.env.VOID_BRIDGE_TOKEN?.trim() ?? "";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function withBridgeToken(headers = {}) {
  if (!bridgeToken) {
    return headers;
  }
  return {
    ...headers,
    [BRIDGE_TOKEN_HEADER]: bridgeToken
  };
}

function hasKeyDeep(value, key) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, key));
  }
  return Object.values(value).some((item) => hasKeyDeep(item, key));
}

async function request(pathname, options = {}, auth = true) {
  const response = await fetch(`${bridgeOrigin}${pathname}`, {
    ...options,
    headers: auth ? withBridgeToken(options.headers) : options.headers
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined
  };
}

async function rawRequestWithHost(pathname, hostHeader) {
  const target = new URL(bridgeOrigin);
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        method: "GET",
        headers: { Host: hostHeader }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode,
            body: text ? JSON.parse(text) : undefined
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function runSecuritySuite(label, token) {
  bridgeToken = token;
  if (token) {
    process.env.VOID_BRIDGE_TOKEN = token;
  } else {
    delete process.env.VOID_BRIDGE_TOKEN;
  }

  console.log(`[agent-bridge-security-smoke] ${label} bridge=${bridgeOrigin}`);

  if (bridgeToken) {
    const missingToken = await request("/void-bridge/health", {}, false);
    assert(missingToken.status === 403, "开启 token 后，缺失 token 必须返回 403");
    assert(
      missingToken.body?.error?.code === "BRIDGE_TOKEN_FORBIDDEN",
      "缺失 token 必须返回稳定错误码"
    );

    const wrongToken = await request(
      "/void-bridge/health",
      { headers: { [BRIDGE_TOKEN_HEADER]: "invalid-token" } },
      false
    );
    assert(wrongToken.status === 403, "开启 token 后，错误 token 必须返回 403");
    assert(
      wrongToken.body?.error?.code === "BRIDGE_TOKEN_FORBIDDEN",
      "错误 token 必须返回稳定错误码"
    );
  }

  const noOrigin = await request("/void-bridge/health");
  assert(noOrigin.status === 200, "无 Origin 的本地 health 应通过");
  assert(
    noOrigin.body?.tokenRequired === Boolean(bridgeToken),
    "health 必须准确报告 tokenRequired"
  );

  const securityStatus = await request("/void-bridge/security-status");
  assert(securityStatus.status === 200, "security-status 应返回 200");
  assert(securityStatus.body?.ok === true, "security-status 必须使用 { ok: true, data } 响应结构");
  assert(
    securityStatus.body?.data?.bridge?.listenIsLoopback === true,
    "security-status 必须报告 bridge 仅监听回环地址"
  );
  assert(
    securityStatus.body?.data?.bridge?.tokenRequired === Boolean(bridgeToken),
    "security-status 必须准确报告 tokenRequired"
  );
  assert(
    securityStatus.body?.data?.checks?.some?.((check) => check.id === "bridge.listenLoopback"),
    "security-status checks 必须包含 bridge.listenLoopback"
  );
  assert(
    !hasKeyDeep(securityStatus.body?.data?.network, "address"),
    "security-status network 摘要不得返回真实网卡 IP address 字段"
  );

  const devOrigin = await request("/void-bridge/health", {
    headers: { Origin: "http://localhost:5173" }
  });
  assert(devOrigin.status === 200, "合法 Vite Origin 应通过");
  assert(
    devOrigin.headers.get("access-control-allow-origin") === "http://localhost:5173",
    "合法 Origin 必须精确回显"
  );
  assert(
    devOrigin.headers.get("x-content-type-options") === "nosniff",
    "bridge 响应必须带 nosniff"
  );
  assert(
    devOrigin.headers.get("cache-control") === "no-store",
    "bridge health 响应必须禁止缓存"
  );
  assert(
    devOrigin.headers.get("access-control-allow-headers")?.toLowerCase().includes("x-void-bridge-token"),
    "CORS 预检允许头必须包含 bridge token header"
  );

  const tauriOrigin = await request("/void-bridge/health", {
    headers: { Origin: "http://tauri.localhost" }
  });
  assert(tauriOrigin.status === 200, "合法 Tauri Origin 应通过");

  const rejectedHost = await rawRequestWithHost("/void-bridge/health", "evil.example");
  assert(rejectedHost.status === 403, "恶意 Host 必须返回 403");
  assert(
    rejectedHost.body?.error?.code === "HOST_FORBIDDEN",
    "恶意 Host 必须返回稳定错误码"
  );

  const maliciousOrigin = "https://malicious.example";
  const rejectedPreflight = await request("/void-browser/session/ensure", {
    method: "OPTIONS",
    headers: {
      Origin: maliciousOrigin,
      "Access-Control-Request-Method": "POST"
    }
  });
  assert(rejectedPreflight.status === 403, "恶意 Origin 的预检必须返回 403");

  const rejectedPost = await request("/void-browser/session/ensure", {
    method: "POST",
    headers: { Origin: maliciousOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: "r1-malicious-origin" })
  });
  assert(rejectedPost.status === 403, "恶意 Origin 的 POST 必须返回 403");

  const afterRejectedPost = await request("/void-bridge/health");
  assert(
    afterRejectedPost.body.activeBrowserSessions === 0,
    "恶意 Origin 请求不得创建 BrowserContext"
  );

  const oversizedBody = JSON.stringify({ text: "x".repeat(70 * 1024) });
  for (const pathname of [
    "/void-browser/session/ensure",
    "/void-file/verify",
    "/void-desktop/clipboard/write"
  ]) {
    const oversized = await request(pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedBody
    });
    assert(oversized.status === 413, `${pathname} 超长请求体必须返回 413`);
    assert(
      oversized.body?.error?.code === "REQUEST_BODY_TOO_LARGE",
      `${pathname} 必须返回稳定错误码`
    );
  }

  const oversizedProxy = await request("/void-model-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-VOID-Target-URL": "https://example.com/v1/chat/completions"
    },
    body: JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) })
  });
  assert(oversizedProxy.status === 413, "模型代理超长请求体必须返回 413");
  assert(
    oversizedProxy.body?.error?.code === "REQUEST_BODY_TOO_LARGE",
    "模型代理超长请求体必须返回稳定错误码"
  );

  const finalHealth = await request("/void-bridge/health");
  assert(finalHealth.body.activeBrowserSessions === 0, "R1 smoke 结束后不得残留浏览器会话");
}

async function withInProcessBridge(run) {
  const previousAutostart = process.env.VOID_BRIDGE_DISABLE_AUTOSTART;
  process.env.VOID_BRIDGE_DISABLE_AUTOSTART = "1";
  const { startBridgeServer } = await import("../server/voidBridgeServer.ts");
  await assertUnsafeListenHostRejected(startBridgeServer);
  const bridge = await startBridgeServer({
    port: 0,
    exitOnError: false,
    installSignalHandlers: false
  });
  bridgeOrigin = bridge.origin;
  try {
    await run();
  } finally {
    if (previousAutostart === undefined) {
      delete process.env.VOID_BRIDGE_DISABLE_AUTOSTART;
    } else {
      process.env.VOID_BRIDGE_DISABLE_AUTOSTART = previousAutostart;
    }
    await bridge.close();
  }
}

async function assertUnsafeListenHostRejected(startBridgeServer) {
  try {
    await startBridgeServer({
      port: 0,
      host: "0.0.0.0",
      exitOnError: false,
      installSignalHandlers: false
    });
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("只允许监听本机回环地址"),
      "非回环监听必须返回明确拒绝原因"
    );
    return;
  }
  throw new Error("bridge 不应允许监听 0.0.0.0");
}

async function main() {
  const originalToken = process.env.VOID_BRIDGE_TOKEN;

  try {
    if (EXTERNAL_BRIDGE_MODE) {
      await runSecuritySuite("external", bridgeToken);
    } else {
      await withInProcessBridge(async () => {
        await runSecuritySuite("in-process/no-token", "");
        await runSecuritySuite("in-process/token", "smoke-token");
      });
    }

    console.log("[agent-bridge-security-smoke] PASSED");
  } finally {
    if (originalToken === undefined) {
      delete process.env.VOID_BRIDGE_TOKEN;
    } else {
      process.env.VOID_BRIDGE_TOKEN = originalToken;
    }
  }
}

main().catch((error) => {
  console.error("[agent-bridge-security-smoke] FAILED", error);
  process.exitCode = 1;
});
