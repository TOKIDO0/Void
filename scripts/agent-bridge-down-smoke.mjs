// P1 冒烟：桥接不可达（sidecar 未启动）时的用户可读兜底契约。
// 目的：验证 browser.* 命中 BRIDGE_UNREACHABLE 时——
//   1) 底层桥接客户端返回 bridgeCode=BRIDGE_UNREACHABLE 且 message 含「sidecar」；
//   2) 工具层映射为 EXECUTION_FAILED 且 details.bridgeUnreachable=true（循环层据此回灌如实话术）。
// 说明：为确定性与不打断本机已跑的 bridge，这里把桥接端口指向一个无监听的死端口，
//       等价于「dev 未起 bridge」的不可达场景，无需真的关掉 17872。
// 用法：npx tsx scripts/agent-bridge-down-smoke.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

// 关键：在导入任何工具模块前，把桥接指向死端口，保证不可达。
process.env.VOID_BRIDGE_PORT = "17999";
delete process.env.VOID_BRIDGE_ORIGIN;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

function toEntry(relativePath) {
  return pathToFileURL(path.join(root, relativePath)).href;
}

function fail(message) {
  console.error(`[agent-bridge-down-smoke] FAILED: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`[agent-bridge-down-smoke] bridge 指向死端口 127.0.0.1:${process.env.VOID_BRIDGE_PORT}`);

  // 1) 底层桥接客户端：应抛出 bridgeCode=BRIDGE_UNREACHABLE，message 含 sidecar
  const { browserOpen, getBrowserBridgeErrorInfo } = await import(
    toEntry("src/features/agent/browser/browserBridgeClient.ts")
  );

  let clientInfo = null;
  try {
    await browserOpen({ taskId: "smoke_bridge_down", url: "https://example.com" });
    fail("底层 browserOpen 未按预期抛错（桥接死端口却成功）");
    return;
  } catch (error) {
    clientInfo = getBrowserBridgeErrorInfo(error);
  }

  console.log("[agent-bridge-down-smoke] 底层桥接错误：", clientInfo.code);
  console.log("[agent-bridge-down-smoke] 底层错误文案：", clientInfo.message);

  if (clientInfo.code !== "BRIDGE_UNREACHABLE") {
    fail(`底层错误码应为 BRIDGE_UNREACHABLE，实际=${clientInfo.code}`);
    return;
  }
  if (!clientInfo.message.includes("sidecar")) {
    fail("底层错误文案缺少「sidecar」启动提示");
    return;
  }

  // 2) 工具层：executeToolCall 执行 browser.open，应映射为 EXECUTION_FAILED
  //    且 details.bridgeUnreachable=true、message 含 sidecar
  const { bootstrapAgentRuntime } = await import(toEntry("src/features/agent/runtimeBootstrap.ts"));
  const { executeToolCall } = await import(toEntry("src/features/agent/execution/toolExecutor.ts"));

  bootstrapAgentRuntime();

  const result = await executeToolCall({
    taskId: "smoke_bridge_down",
    stepId: "step_open",
    toolName: "browser.open",
    input: { url: "https://example.com" },
    signal: new AbortController().signal,
    attempt: 1
  });

  if (result.ok) {
    fail("工具层 browser.open 未按预期失败");
    return;
  }

  console.log("[agent-bridge-down-smoke] 工具层错误码：", result.error.code);
  console.log(
    "[agent-bridge-down-smoke] 工具层 bridgeUnreachable：",
    result.error.details?.bridgeUnreachable
  );

  if (result.error.code !== "EXECUTION_FAILED") {
    fail(`工具层错误码应为 EXECUTION_FAILED，实际=${result.error.code}`);
    return;
  }
  if (result.error.details?.bridgeUnreachable !== true) {
    fail("工具层 details.bridgeUnreachable 未标记为 true");
    return;
  }
  if (!result.error.message.includes("sidecar")) {
    fail("工具层错误文案缺少「sidecar」启动提示");
    return;
  }

  console.log("[agent-bridge-down-smoke] PASSED");
  console.log(" - 底层 bridgeCode=BRIDGE_UNREACHABLE 且含 sidecar 提示");
  console.log(" - 工具层 EXECUTION_FAILED + details.bridgeUnreachable=true + 含 sidecar 提示");
}

main().catch((error) => {
  console.error("[agent-bridge-down-smoke] crashed", error);
  process.exitCode = 1;
});
