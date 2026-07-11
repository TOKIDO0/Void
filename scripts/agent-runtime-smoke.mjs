// 阶段 B 骨架冒烟：生产结构下用 echo 假工具跑通
// 计划 → 必要确认 → 执行 → 日志 → 汇报
// 用法：npx tsx scripts/agent-runtime-smoke.mjs

import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

async function main() {
  const entry = pathToFileURL(
    path.join(root, "src/features/agent/smoke/runAgentRuntimeSmoke.ts")
  ).href;
  const { runAgentRuntimeSmoke } = await import(entry);
  const result = await runAgentRuntimeSmoke();
  if (!result.ok) {
    console.error("[agent-runtime-smoke] FAILED");
    for (const line of result.failures) {
      console.error(" -", line);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[agent-runtime-smoke] PASSED");
  for (const line of result.notes) {
    console.log(" -", line);
  }
}

main().catch((error) => {
  console.error("[agent-runtime-smoke] crashed", error);
  process.exitCode = 1;
});
