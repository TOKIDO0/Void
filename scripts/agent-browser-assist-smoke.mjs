// 阶段 D 冒烟：搜索→确认目标→打开→下载临时→确认落盘→校验
// 前置：sidecar 已启动（npm run dev:bridge）
// 用法：
//   npx tsx scripts/agent-browser-assist-smoke.mjs [关键词]
//   npx tsx scripts/agent-browser-assist-smoke.mjs --fail-path   # 人为失败：非法目录

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

async function waitForBridge(origin, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${origin}/void-bridge/health`);
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

function autoApprove(request) {
  // 记录并批准；验收要求描述含目标/目录上下文
  console.log("\n[confirmation]");
  console.log(" tool:", request.toolName);
  console.log(" title:", request.title);
  console.log(" risk:", request.riskLevel);
  console.log(" description:\n" + request.description);
  return {
    requestId: request.id,
    approved: true,
    decidedAt: Date.now(),
    note: "smoke-auto-approve"
  };
}

async function main() {
  const args = process.argv.slice(2);
  const failPath = args.includes("--fail-path");
  const query = (args.find((item) => !item.startsWith("--")) ?? "W3C accessibility").trim();
  const bridgeOrigin =
    process.env.VOID_BRIDGE_ORIGIN
    ?? `http://127.0.0.1:${process.env.VOID_BRIDGE_PORT ?? "17872"}`;

  console.log(`[agent-browser-assist-smoke] bridge=${bridgeOrigin}`);
  console.log(`[agent-browser-assist-smoke] query=${query}`);
  console.log(`[agent-browser-assist-smoke] mode=${failPath ? "fail-path" : "happy-path"}`);

  const ready = await waitForBridge(bridgeOrigin);
  if (!ready) {
    console.error(
      "[agent-browser-assist-smoke] FAILED: sidecar 未就绪。请先运行 npm run dev:bridge"
    );
    process.exitCode = 1;
    return;
  }

  const entry = pathToFileURL(
    path.join(root, "src/features/agent/browser/runBrowserAssistSampleTask.ts")
  ).href;
  const { runBrowserAssistSampleTask } = await import(entry);

  const result = await runBrowserAssistSampleTask({
    query,
    selectedRank: 1,
    destinationDirectory: failPath
      ? "C:\\Windows\\System32\\void-not-allowed"
      : "D:\\AI\\void-runtime\\downloads",
    overwritePolicy: "rename",
    requestConfirmation: autoApprove
  });

  console.log("\n[agent-browser-assist-smoke] structured JSON:");
  console.log(JSON.stringify(result.structured, null, 2));

  if (failPath) {
    // 失败恢复：下载应成功，落盘因白名单被分类拒绝，且不得 ok
    const downloadOk = Boolean(result.structured.download?.tempPath);
    const placeFailed = !result.structured.placed;
    const messageBlob = [
      result.structured.failure?.code,
      result.structured.failure?.message,
      result.structured.reportMessage
    ].filter(Boolean).join(" | ");
    const whitelistRejected =
      messageBlob.includes("白名单")
      || messageBlob.includes("PATH_NOT_ALLOWED")
      || messageBlob.includes("PERMISSION_DENIED")
      || messageBlob.includes("不在白名单");

    if (!result.ok && downloadOk && placeFailed && whitelistRejected) {
      console.log("[agent-browser-assist-smoke] PASSED (fail-path)");
      console.log(" - 临时下载成功，非法最终目录被分类拒绝");
      console.log(" - failure=", result.structured.failure ?? result.structured.reportMessage);
      return;
    }

    console.error("[agent-browser-assist-smoke] FAILED: fail-path 未按预期在落盘白名单失败");
    console.error(" ok=", result.ok, " downloadOk=", downloadOk, " placeFailed=", placeFailed);
    console.error(" message=", messageBlob);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    console.error("[agent-browser-assist-smoke] FAILED");
    console.error(" report=", result.structured.reportMessage);
    console.error(" failure=", result.structured.failure);
    process.exitCode = 1;
    return;
  }

  const verified = result.structured.verified;
  const placed = result.structured.placed;
  if (!placed?.finalPath || !verified?.exists || typeof verified.bytes !== "number") {
    console.error("[agent-browser-assist-smoke] FAILED: 缺少路径/大小校验数据");
    process.exitCode = 1;
    return;
  }

  if (!existsSync(placed.finalPath)) {
    console.error("[agent-browser-assist-smoke] FAILED: 最终文件不存在", placed.finalPath);
    process.exitCode = 1;
    return;
  }

  const stat = statSync(placed.finalPath);
  if (stat.size !== verified.bytes) {
    console.error(
      `[agent-browser-assist-smoke] FAILED: 大小不一致 disk=${stat.size} verified=${verified.bytes}`
    );
    process.exitCode = 1;
    return;
  }

  // 确认文案上下文检查
  const selectConfirm = result.structured.confirmations.find(
    (item) => item.toolName === "browser.selectTarget" && item.approved
  );
  const placeConfirm = result.structured.confirmations.find(
    (item) => item.toolName === "file.placeDownload" && item.approved
  );
  if (!selectConfirm || !placeConfirm) {
    console.error("[agent-browser-assist-smoke] FAILED: 缺少 L2 确认记录");
    process.exitCode = 1;
    return;
  }
  if (!selectConfirm.description.includes("URL") && !selectConfirm.description.includes("标题")) {
    console.error("[agent-browser-assist-smoke] FAILED: 目标确认文案缺少上下文");
    process.exitCode = 1;
    return;
  }
  if (!placeConfirm.description.includes("目标目录")) {
    console.error("[agent-browser-assist-smoke] FAILED: 落盘确认文案缺少目标目录");
    process.exitCode = 1;
    return;
  }

  console.log("[agent-browser-assist-smoke] PASSED");
  console.log(` - finalPath=${placed.finalPath}`);
  console.log(` - bytes=${verified.bytes}`);
  console.log(` - mediaKind=${verified.mediaKind}`);
  console.log(` - confirmations=${result.structured.confirmations.length}`);
}

main().catch((error) => {
  console.error("[agent-browser-assist-smoke] crashed", error);
  process.exitCode = 1;
});
