/**
 * S20：Agent 能力自检。
 * 给用户一个真实、当前、可审计的能力清单，而不是让模型凭印象介绍自己。
 */

import {
  getCurrentPermissionGrants,
  hasToolPermissionGrants
} from "../../permissions";
import {
  listUntrustedOutputToolNames,
  summarizeToolOutputTrust,
  type ToolOutputTrust
} from "../../security/toolOutputTrustPolicy";
import {
  countUserFacingHiddenTools,
  isToolHiddenFromUserFacingCapabilities
} from "../../security/toolVisibilityPolicy";
import { listToolMetadata } from "../toolRegistry";
import type { RiskLevel, ToolDefinition, ToolMetadata } from "../toolTypes";

export type AgentCapabilityGroupId =
  | "agent"
  | "browser"
  | "file"
  | "software"
  | "clipboard"
  | "desktop"
  | "security";

export type AgentInspectCapabilitiesToolInput = Record<string, never>;

export type AgentInspectCapabilitiesToolOutput = {
  status: "ok";
  inspectedAt: number;
  toolCount: number;
  capabilityCount: number;
  registryAudit: {
    registeredToolCount: number;
    userVisibleToolCount: number;
    internalHiddenToolCount: number;
    disabledToolCount: number;
    missingPermissionToolCount: number;
    missingPermissionToolNames: string[];
    note: string;
  };
  capabilities: Array<{
    id: AgentCapabilityGroupId;
    label: string;
    summary: string;
    toolNames: string[];
    maxRiskLevel: RiskLevel;
    requiresBridge: boolean;
    requiresConfirmation: boolean;
    outputTrust: ToolOutputTrust;
    untrustedOutputToolNames: string[];
  }>;
  safetyBoundaries: string[];
  notes: string[];
};

type CapabilityGroupDefinition = {
  id: AgentCapabilityGroupId;
  label: string;
  summary: string;
  toolNames: string[];
  requiresBridge: boolean;
};

const RISK_ORDER: Record<RiskLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3
};

const CAPABILITY_GROUPS: CapabilityGroupDefinition[] = [
  {
    id: "agent",
    label: "Agent 自检与任务预演",
    summary: "说明当前可用能力、检查单个工具契约、查看本地技能库，或在不执行的情况下预演某个请求会使用哪些工具和确认边界。",
    requiresBridge: false,
    toolNames: [
      "agent.inspectCapabilities",
      "agent.planTaskRoute",
      "agent.inspectToolContract",
      "agent.inspectExtensionPolicy",
      "agent.inspectSafetyHooks",
      "agent.inspectPrivacyBoundaries",
      "agent.inspectTaskPlaybooks",
      "agent.inspectSkills"
    ]
  },
  {
    id: "browser",
    label: "网页与浏览器",
    summary: "搜索网页、打开页面、抽取页面内容，并在需要时点击、输入、切换标签页或用系统浏览器打开给用户看。",
    requiresBridge: true,
    toolNames: [
      "browser.open",
      "browser.search",
      "browser.selectTarget",
      "browser.revealInSystemBrowser",
      "browser.click",
      "browser.longPress",
      "browser.type",
      "browser.waitFor",
      "browser.extract",
      "browser.tabs",
      "browser.switchTab"
    ]
  },
  {
    id: "file",
    label: "本地文件",
    summary: "在允许根内列目录、预检路径元数据、按名称查找文件、查看默认目录最近产物、读取文本/PDF/DOCX、全文搜索、预检写入目标、写入文本、创建一层目录、移动/重命名和校验文件。",
    requiresBridge: true,
    toolNames: [
      "file.listDirectory",
      "file.inspectPath",
      "file.findByName",
      "file.listRecentArtifacts",
      "file.readText",
      "file.searchText",
      "file.inspectWriteTarget",
      "file.writeText",
      "file.createDirectory",
      "file.move",
      "file.verify",
      "file.downloadToTemp",
      "file.downloadMediaPage",
      "file.downloadMedia",
      "file.placeDownload"
    ]
  },
  {
    id: "software",
    label: "官方软件安装包（已降级为打开下载页）",
    summary: "白名单自动下载已降级为通用方案：搜索并打开官方下载页由用户自行下载；原目录校验链路保留作兼容，不再扩展。",
    requiresBridge: true,
    toolNames: [
      "software.listSupported",
      "software.resolveInstaller",
      "software.downloadInstaller"
    ]
  },
  {
    id: "clipboard",
    label: "剪贴板",
    summary: "读取剪贴板文本，或在用户确认后写入剪贴板。",
    requiresBridge: true,
    toolNames: ["clipboard.read", "clipboard.write"]
  },
  {
    id: "desktop",
    label: "受限桌面动作",
    summary: "打开固定系统位置、在资源管理器里展示已确认路径、列出已安装应用并启动应用；高权限模式下部分操作免确认。",
    requiresBridge: true,
    toolNames: ["desktop.openKnownLocation", "desktop.listInstalledApplications", "desktop.launchApplication", "desktop.revealPath"]
  },
  {
    id: "security",
    label: "本地安全自检",
    summary: "只读检查本机 bridge、代理并发、请求体上限、浏览器会话上限和网卡地址范围计数摘要。",
    requiresBridge: true,
    toolNames: ["security.inspectLocalRuntime"]
  }
];

export const agentInspectCapabilitiesTool: ToolDefinition<
  AgentInspectCapabilitiesToolInput,
  AgentInspectCapabilitiesToolOutput
> = {
  name: "agent.inspectCapabilities",
  description:
    "只读列出 VOID 当前已启用、用户可直接请求的 Agent 能力、对应工具、最高风险等级、是否依赖本机 bridge、是否会触发用户确认，以及关键安全边界。不读取本地文件、不连接 bridge、不执行任何外部操作。",
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
      "toolCount",
      "capabilityCount",
      "registryAudit",
      "capabilities",
      "safetyBoundaries",
      "notes"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      inspectedAt: { type: "number" },
      toolCount: { type: "number", minimum: 0 },
      capabilityCount: { type: "number", minimum: 0 },
      registryAudit: {
        type: "object",
        additionalProperties: false,
        required: [
          "registeredToolCount",
          "userVisibleToolCount",
          "internalHiddenToolCount",
          "disabledToolCount",
          "missingPermissionToolCount",
          "missingPermissionToolNames",
          "note"
        ],
        properties: {
          registeredToolCount: { type: "number", minimum: 0 },
          userVisibleToolCount: { type: "number", minimum: 0 },
          internalHiddenToolCount: { type: "number", minimum: 0 },
          disabledToolCount: { type: "number", minimum: 0 },
          missingPermissionToolCount: { type: "number", minimum: 0 },
          missingPermissionToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
          note: { type: "string", maxLength: 240 }
        }
      },
      capabilities: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "summary",
            "toolNames",
            "maxRiskLevel",
            "requiresBridge",
            "requiresConfirmation",
            "outputTrust",
            "untrustedOutputToolNames"
          ],
          properties: {
            id: {
              type: "string",
              enum: ["agent", "browser", "file", "software", "clipboard", "desktop", "security"]
            },
            label: { type: "string" },
            summary: { type: "string", maxLength: 300 },
            toolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            maxRiskLevel: { type: "string", enum: ["L0", "L1", "L2", "L3"] },
            requiresBridge: { type: "boolean" },
            requiresConfirmation: { type: "boolean" },
            outputTrust: { type: "string", enum: ["trusted", "untrusted", "mixed"] },
            untrustedOutputToolNames: { type: "array", items: { type: "string" }, maxItems: 20 }
          }
        }
      },
      safetyBoundaries: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 240 }
      },
      notes: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 240 }
      }
    }
  },
  requiredResources: [
    {
      kind: "memory",
      key: "tool-registry",
      mode: "shared"
    }
  ],
  permissions: ["tool.agent.inspectCapabilities"],
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
    const allTools = listToolMetadata();
    const availableTools = listUserFacingTools(allTools);
    const toolsByName = new Map(availableTools.map((tool) => [tool.name, tool]));
    const capabilities = CAPABILITY_GROUPS
      .map((group) => buildCapabilitySummary(group, toolsByName))
      .filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));

    return {
      status: "ok",
      inspectedAt: Date.now(),
      toolCount: availableTools.length,
      capabilityCount: capabilities.length,
      registryAudit: buildRegistryAudit(allTools, availableTools),
      capabilities,
      safetyBoundaries: [
        "没有通用 Shell、任意命令执行或任意程序启动能力。",
        "文件能力只在允许根内工作；写入、移动、下载落盘等敏感步骤会请求确认。",
        "访问 localhost、私网或单标签内网主机时，会动态升为 L2 确认。",
        "读取 .env、SSH 私钥、证书私钥、云凭据等敏感路径时，会动态升为 L2 确认。",
        "任务预演会提前标记请求文本中的 localhost/私网 URL 和敏感文件路径，帮助执行前判断风险。",
        "bridge token 只附加到 127.0.0.1 / localhost / ::1 回环请求，不外发远端。",
        "工具结果进入模型前会做脱敏、外部内容标记、来源信任分级和大结果预算压缩。"
      ],
      notes: [
        "普通闲聊不会暴露工具；只有命中明确动作意图时才进入对应工具组。",
        "本清单来自当前运行时工具注册表和权限 grants，不是静态宣传文案。"
      ]
    };
  }
};

function listUserFacingTools(tools: ToolMetadata[]): ToolMetadata[] {
  const grants = getCurrentPermissionGrants();
  return tools
    .filter((tool) =>
      tool.enabled !== false
      && !isToolHiddenFromUserFacingCapabilities(tool.name)
      && hasToolPermissionGrants(tool, grants)
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildRegistryAudit(
  allTools: ToolMetadata[],
  userVisibleTools: ToolMetadata[]
): AgentInspectCapabilitiesToolOutput["registryAudit"] {
  const grants = getCurrentPermissionGrants();
  const missingPermissionToolNames = allTools
    .filter((tool) =>
      tool.enabled !== false
      && !isToolHiddenFromUserFacingCapabilities(tool.name)
      && !hasToolPermissionGrants(tool, grants)
    )
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));

  return {
    registeredToolCount: allTools.length,
    userVisibleToolCount: userVisibleTools.length,
    internalHiddenToolCount: countUserFacingHiddenTools(allTools.map((tool) => tool.name)),
    disabledToolCount: allTools.filter((tool) => tool.enabled === false).length,
    missingPermissionToolCount: missingPermissionToolNames.length,
    missingPermissionToolNames: missingPermissionToolNames.slice(0, 20),
    note: "内部隐藏工具不会作为普通能力展示；缺少权限 grants 的工具不会暴露给模型或用户任务路线。"
  };
}

function buildCapabilitySummary(
  group: CapabilityGroupDefinition,
  toolsByName: Map<string, ToolMetadata>
): AgentInspectCapabilitiesToolOutput["capabilities"][number] | null {
  const tools = group.toolNames
    .map((toolName) => toolsByName.get(toolName))
    .filter((tool): tool is ToolMetadata => Boolean(tool));
  if (tools.length === 0) {
    return null;
  }

  const maxRiskLevel = tools.reduce<RiskLevel>(
    (highest, tool) => (
      RISK_ORDER[tool.riskLevel] > RISK_ORDER[highest] ? tool.riskLevel : highest
    ),
    "L0"
  );

  const toolNames = tools.map((tool) => tool.name);
  return {
    id: group.id,
    label: group.label,
    summary: group.summary,
    toolNames,
    maxRiskLevel,
    requiresBridge: group.requiresBridge,
    requiresConfirmation: tools.some((tool) => RISK_ORDER[tool.riskLevel] >= RISK_ORDER.L2),
    outputTrust: summarizeToolOutputTrust(toolNames),
    untrustedOutputToolNames: listUntrustedOutputToolNames(toolNames)
  };
}
