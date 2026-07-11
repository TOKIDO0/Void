/**
 * 临时联调：对话驱动 tool 循环（不入库 Key）。
 * 用法：
 *   $env:VOID_LIVE_API_KEY="sk-..."
 *   $env:VOID_BROWSER_HEADLESS="1"
 *   npx tsx scripts/agent-tool-loop-live.mjs "帮我搜索 Playwright"
 *
 * 可选：
 *   VOID_LIVE_BASE_URL  默认 https://api.deepseek.com
 *   VOID_LIVE_MODEL     默认 deepseek-chat
 *   VOID_LIVE_AUTO_APPROVE=1  自动确认 L2（默认 1，仅联调）
 */

import {
  bootstrapAgentRuntime,
  listModelToolDefinitions,
  runAgentToolLoop
} from "../src/features/agent/index.ts";

const apiKey = (process.env.VOID_LIVE_API_KEY || "").trim();
const baseUrl = (process.env.VOID_LIVE_BASE_URL || "https://api.deepseek.com").trim();
const modelName = (process.env.VOID_LIVE_MODEL || "deepseek-chat").trim();
const autoApprove = (process.env.VOID_LIVE_AUTO_APPROVE || "1") !== "0";
const userText =
  process.argv.slice(2).join(" ").trim()
  || "帮我搜索 Playwright，返回前几条结果标题和链接即可，先不要下载。";

if (!apiKey) {
  console.error("[agent-tool-loop-live] 缺少 VOID_LIVE_API_KEY");
  process.exit(1);
}

bootstrapAgentRuntime();
const tools = listModelToolDefinitions();
console.log("[agent-tool-loop-live] tools =", tools.map((t) => t.function.name).join(", "));
console.log("[agent-tool-loop-live] model =", modelName);
console.log("[agent-tool-loop-live] user  =", userText);
console.log("[agent-tool-loop-live] autoApprove =", autoApprove);

const modelConfig = {
  provider: "openai-compatible",
  presetId: "deepseek",
  apiKey,
  baseUrl,
  modelName,
  modelStrength: "middle",
  thinkingModeEnabled: false,
  temperature: 0.3,
  maxOutputTokens: 1200,
  streamEnabled: false,
  requestMode: "development-proxy"
};

const messages = [
  {
    role: "system",
    content: [
      "你是 VOID。当用户要求搜索、打开网页、下载文件时，必须调用函数工具完成，不要假装已经操作。",
      "普通聊天不要调工具。",
      "工具执行后用简洁中文汇报结果。"
    ].join("")
  },
  {
    role: "user",
    content: userText
  }
];

const result = await runAgentToolLoop({
  messages,
  modelConfig,
  tools,
  maxRounds: 6,
  onProgress: (message) => {
    if (message) {
      console.log("[progress]", message);
    }
  },
  requestConfirmation: async (request) => {
    console.log("\n[confirmation]");
    console.log(" tool:", request.toolName);
    console.log(" title:", request.title);
    console.log(" risk:", request.riskLevel);
    console.log(" description:\n" + request.description);
    if (!autoApprove) {
      return {
        requestId: request.id,
        approved: false,
        decidedAt: Date.now(),
        note: "联调关闭了自动确认"
      };
    }
    return {
      requestId: request.id,
      approved: true,
      decidedAt: Date.now(),
      note: "live smoke auto-approve"
    };
  }
});

console.log("\n[agent-tool-loop-live] RESULT");
console.log(" usedTools =", result.usedTools);
console.log(" rounds    =", result.rounds);
console.log(" taskId    =", result.taskId);
console.log(" content:\n" + result.content);

if (!result.content.trim()) {
  process.exit(2);
}
if (!result.usedTools && /搜索|search|下载|打开/i.test(userText)) {
  console.error("[agent-tool-loop-live] 期望调用工具但 usedTools=false");
  process.exit(3);
}

console.log("[agent-tool-loop-live] PASSED");
