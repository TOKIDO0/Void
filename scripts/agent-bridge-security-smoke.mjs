const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${bridgeOrigin}${pathname}`, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : undefined
  };
}

async function main() {
  console.log(`[agent-bridge-security-smoke] bridge=${bridgeOrigin}`);

  const noOrigin = await request("/void-bridge/health");
  assert(noOrigin.status === 200, "无 Origin 的本地 health 应通过");

  const devOrigin = await request("/void-bridge/health", {
    headers: { Origin: "http://localhost:5173" }
  });
  assert(devOrigin.status === 200, "合法 Vite Origin 应通过");
  assert(
    devOrigin.headers.get("access-control-allow-origin") === "http://localhost:5173",
    "合法 Origin 必须精确回显"
  );

  const tauriOrigin = await request("/void-bridge/health", {
    headers: { Origin: "http://tauri.localhost" }
  });
  assert(tauriOrigin.status === 200, "合法 Tauri Origin 应通过");

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

  const finalHealth = await request("/void-bridge/health");
  assert(finalHealth.body.activeBrowserSessions === 0, "R1 smoke 结束后不得残留浏览器会话");
  console.log("[agent-bridge-security-smoke] PASSED");
}

main().catch((error) => {
  console.error("[agent-bridge-security-smoke] FAILED", error);
  process.exitCode = 1;
});
