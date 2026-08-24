/**
 * S26：扩展机制安全边界自检。
 * 先把 plugins/MCP/skills/hooks/subagents 的安全边界做成可见事实，不接执行入口。
 */

import { listToolMetadata } from "../toolRegistry";
import type { ToolDefinition } from "../toolTypes";

export type AgentInspectExtensionPolicyToolInput = Record<string, never>;

export type AgentInspectExtensionPolicyToolOutput = {
  status: "ok";
  inspectedAt: number;
  executableExtensionRuntime: "disabled";
  productionToolCount: number;
  detectedExtensionToolNames: string[];
  mcpToolExposure: "none" | "detected";
  pluginToolExposure: "none" | "detected";
  skillToolExposure: "none" | "detected";
  hookToolExposure: "none" | "detected";
  subagentToolExposure: "none" | "detected";
  blockedCapabilities: string[];
  requiredFutureBoundaries: string[];
  currentBoundaries: string[];
  notes: string[];
};

const EXTENSION_TOOL_PREFIXES = [
  "mcp.",
  "plugin.",
  "skill.",
  "hook.",
  "subagent."
];

export const agentInspectExtensionPolicyTool: ToolDefinition<
  AgentInspectExtensionPolicyToolInput,
  AgentInspectExtensionPolicyToolOutput
> = {
  name: "agent.inspectExtensionPolicy",
  description:
    "只读检查 VOID 当前扩展机制安全边界：是否已有可执行插件/MCP/skills/hooks/subagents 工具暴露、哪些扩展能力被明确禁止、未来接入扩展必须满足哪些白名单和审计条件。不加载插件、不连接 MCP、不执行 hook、不启动子 Agent、不读取文件。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "inspectedAt",
      "executableExtensionRuntime",
      "productionToolCount",
      "detectedExtensionToolNames",
      "mcpToolExposure",
      "pluginToolExposure",
      "skillToolExposure",
      "hookToolExposure",
      "subagentToolExposure",
      "blockedCapabilities",
      "requiredFutureBoundaries",
      "currentBoundaries",
      "notes"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      inspectedAt: { type: "number" },
      executableExtensionRuntime: { type: "string", enum: ["disabled"] },
      productionToolCount: { type: "number", minimum: 0 },
      detectedExtensionToolNames: { type: "array", items: { type: "string" }, maxItems: 40 },
      mcpToolExposure: { type: "string", enum: ["none", "detected"] },
      pluginToolExposure: { type: "string", enum: ["none", "detected"] },
      skillToolExposure: { type: "string", enum: ["none", "detected"] },
      hookToolExposure: { type: "string", enum: ["none", "detected"] },
      subagentToolExposure: { type: "string", enum: ["none", "detected"] },
      blockedCapabilities: { type: "array", items: { type: "string", maxLength: 220 }, maxItems: 12 },
      requiredFutureBoundaries: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 },
      currentBoundaries: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 12 },
      notes: { type: "array", items: { type: "string", maxLength: 240 }, maxItems: 8 }
    }
  },
  requiredResources: [
    {
      kind: "memory",
      key: "tool-registry",
      mode: "shared"
    }
  ],
  permissions: ["tool.agent.inspectExtensionPolicy"],
  timeoutMs: 3_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true
  },
  enabled: true,
  maxRetries: 0,
  async execute() {
    const toolNames = listToolMetadata()
      .map((tool) => tool.name)
      .sort((left, right) => left.localeCompare(right));
    const detectedExtensionToolNames = toolNames.filter(isExtensionToolName);

    return {
      status: "ok",
      inspectedAt: Date.now(),
      executableExtensionRuntime: "disabled",
      productionToolCount: toolNames.length,
      detectedExtensionToolNames,
      mcpToolExposure: hasPrefix(detectedExtensionToolNames, "mcp.") ? "detected" : "none",
      pluginToolExposure: hasPrefix(detectedExtensionToolNames, "plugin.") ? "detected" : "none",
      skillToolExposure: hasPrefix(detectedExtensionToolNames, "skill.") ? "detected" : "none",
      hookToolExposure: hasPrefix(detectedExtensionToolNames, "hook.") ? "detected" : "none",
      subagentToolExposure: hasPrefix(detectedExtensionToolNames, "subagent.") ? "detected" : "none",
      blockedCapabilities: [
        "通用 Shell 或任意命令执行。",
        "任意 app.launch / 任意程序启动。",
        "未经清单登记的动态插件执行。",
        "未审核的远端 MCP 工具直接进入模型 tools。",
        "插件临场扩大文件根、网络范围、端口监听或剪贴板写入权限。",
        "无确认地读取密钥文件、全盘扫描或批量上传本地资料。",
        "子 Agent 绕过主 Agent 的工具权限、风险等级、审计和资源锁。"
      ],
      requiredFutureBoundaries: [
        "扩展必须先有本地 manifest，声明 name/version/description/permissions/riskLevel/resources/auditPolicy。",
        "扩展工具必须注册为普通 ToolDefinition，继续走 Schema 校验、权限 grants、资源锁、超时、取消和输出 Schema 审计。",
        "MCP 或插件只允许白名单工具逐个映射，不允许把整台电脑或完整服务端能力一次性暴露给模型。",
        "扩展来源、更新和启用状态必须可审计；默认禁用，用户明确启用后才可见。",
        "高风险扩展能力必须 L2/L3 确认，不能通过 prompt 或网页内容临场放权。",
        "扩展输出若来自网页、本地文件、剪贴板或远端服务，必须标记为 untrusted 并进入回灌预算压缩。"
      ],
      currentBoundaries: [
        "当前生产工具注册表没有通用 Shell 工具。",
        "当前生产工具注册表没有任意程序启动工具。",
        "当前桌面能力仅限固定系统位置和资源管理器展示路径。",
        "当前文件能力只在允许根内工作，并对敏感路径、写入、移动、下载落盘做确认或服务端校验。",
        "当前 Agent 自检/预演工具均为只读内存元数据，不连接 bridge。"
      ],
      notes: [
        "这是安全边界自检，不是插件运行时。",
        "当前不会加载第三方插件、连接 MCP server、执行 hook 或启动子 Agent。",
        "后续若实现扩展系统，应先做只读注册表与审计 UI，再逐个映射低风险工具。"
      ]
    };
  }
};

function isExtensionToolName(toolName: string): boolean {
  return EXTENSION_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function hasPrefix(toolNames: string[], prefix: string): boolean {
  return toolNames.some((toolName) => toolName.startsWith(prefix));
}
