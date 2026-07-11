// 运行时启动：幂等注册内置工具。UI 或冒烟入口调用一次即可。

import { registerBuiltinTools } from "./tools";

/**
 * 初始化 Agent 工具运行时（目前仅注册内置工具）。
 * registerBuiltinTools 本身幂等，可重复调用。
 */
export function bootstrapAgentRuntime() {
  registerBuiltinTools();
}
