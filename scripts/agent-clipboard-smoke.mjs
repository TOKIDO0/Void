// Q4 冒烟：clipboard.write → clipboard.read 一致；超长拒绝
// 前置：npm run dev:bridge
// 用法：npx tsx scripts/agent-clipboard-smoke.mjs
// 注意：会临时覆盖本机剪贴板；结束时尽量恢复原内容

const bridgeOrigin =
  process.env.VOID_BRIDGE_ORIGIN
  ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

const MARKER = `void-clipboard-smoke-${Date.now().toString(36)}`;
const SAMPLE = `${MARKER}\n中文剪贴板测试 line-2`;

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
  return { httpStatus: response.status, payload };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  console.log(`[agent-clipboard-smoke] bridge=${bridgeOrigin}`);

  const ready = await waitForBridge();
  if (!ready) {
    console.error(
      "[agent-clipboard-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  let originalText = "";
  try {
    // 读取当前剪贴板以便恢复
    const before = await post("/void-desktop/clipboard/read", {});
    assert(before.payload?.ok, `初始 read 失败: ${JSON.stringify(before.payload)}`);
    originalText = before.payload.data.text ?? "";
    console.log(
      `[before] length=${before.payload.data.length} empty=${before.payload.data.empty}`
    );

    // write → read 一致
    const written = await post("/void-desktop/clipboard/write", { text: SAMPLE });
    assert(written.payload?.ok, `write 失败: ${JSON.stringify(written.payload)}`);
    assert(
      written.payload.data.length === SAMPLE.length,
      `write length 期望 ${SAMPLE.length} 实际 ${written.payload.data.length}`
    );
    console.log(`[write] ok length=${written.payload.data.length}`);

    const after = await post("/void-desktop/clipboard/read", {});
    assert(after.payload?.ok, `read 失败: ${JSON.stringify(after.payload)}`);
    assert(after.payload.data.text === SAMPLE, `read 文本不一致\n期望:\n${SAMPLE}\n实际:\n${after.payload.data.text}`);
    assert(after.payload.data.length === SAMPLE.length, "read length 不一致");
    assert(after.payload.data.empty === false, "read 不应 empty");
    console.log(`[read] ok match marker=${MARKER}`);

    // 超长拒绝（>20000）
    const tooLong = "x".repeat(20_001);
    const rejected = await post("/void-desktop/clipboard/write", { text: tooLong });
    assert(!rejected.payload?.ok, "超长 write 应失败");
    assert(
      rejected.payload?.error?.code === "TOO_LARGE"
      || /超过|TOO_LARGE|20000/.test(String(rejected.payload?.error?.message ?? "")),
      `超长应 TOO_LARGE，实际 ${JSON.stringify(rejected.payload?.error)}`
    );
    console.log(
      `[too large] ok code=${rejected.payload?.error?.code} msg=${rejected.payload?.error?.message}`
    );

    // 超长失败后剪贴板仍应是 SAMPLE（未写坏）
    const still = await post("/void-desktop/clipboard/read", {});
    assert(still.payload?.ok && still.payload.data.text === SAMPLE, "超长失败后内容应保持 SAMPLE");
    console.log("[still after reject] ok");

    console.log("[agent-clipboard-smoke] PASSED");
  } catch (error) {
    console.error(
      "[agent-clipboard-smoke] FAILED:",
      error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
  } finally {
    // 尽量恢复原剪贴板
    try {
      await post("/void-desktop/clipboard/write", { text: originalText });
      console.log("[restore] previous clipboard restored");
    } catch {
      console.warn("[restore] 无法恢复原剪贴板（可忽略）");
    }
  }
}

main();
