/**
 * S29：任务 Playbook 自检。
 * 把常用组合任务做成可审计的只读目录，帮助用户知道怎么把 Agent 用起来。
 */

import {
  getCurrentPermissionGrants,
  hasToolPermissionGrants
} from "../../permissions";
import {
  listAgentTaskPlaybooks,
  type AgentTaskPlaybookCategory
} from "../../planning/taskPlaybookPolicy";
import {
  listUntrustedOutputToolNames,
  summarizeToolOutputTrust,
  type ToolOutputTrust
} from "../../security/toolOutputTrustPolicy";
import { isToolHiddenFromUserFacingCapabilities } from "../../security/toolVisibilityPolicy";
import { listToolMetadata } from "../toolRegistry";
import type { RiskLevel, ToolDefinition, ToolMetadata } from "../toolTypes";

export type AgentInspectTaskPlaybooksToolInput = Record<string, never>;

export type AgentInspectTaskPlaybooksToolOutput = {
  status: "ok";
  inspectedAt: number;
  playbookCount: number;
  availablePlaybookCount: number;
  playbooks: Array<{
    id: string;
    category: AgentTaskPlaybookCategory;
    label: string;
    summary: string;
    userValue: string;
    exampleRequests: string[];
    requiredToolNames: string[];
    optionalToolNames: string[];
    available: boolean;
    unavailableToolNames: string[];
    requiresBridge: boolean;
    requiresConfirmation: boolean;
    maxRiskLevel: RiskLevel;
    outputTrust: ToolOutputTrust;
    untrustedOutputToolNames: string[];
    safetyBoundaries: string[];
  }>;
  safetyBoundaries: string[];
  notes: string[];
};

const PLAYBOOK_CATEGORY_VALUES: AgentTaskPlaybookCategory[] = [
  "agent",
  "browser",
  "file",
  "software",
  "clipboard",
  "security"
];

const RISK_ORDER: Record<RiskLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3
};

export const agentInspectTaskPlaybooksTool: ToolDefinition<
  AgentInspectTaskPlaybooksToolInput,
  AgentInspectTaskPlaybooksToolOutput
> = {
  name: "agent.inspectTaskPlaybooks",
  description:
    "只读列出 VOID 当前可直接使用的组合任务 Playbook：网页检索并保存、本地资料检索并保存、官方安装包下载、剪贴板链接下载、网页抽取、文本产物保存、文件名定位、最近产物定位、路径元数据预检、本地安全自检、任务预演、隐私/扩展边界说明等。只读取内置 playbook 策略和工具注册表，不执行任务、不连接 bridge、不读取文件、不发网络请求。",
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
      "playbookCount",
      "availablePlaybookCount",
      "playbooks",
      "safetyBoundaries",
      "notes"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      inspectedAt: { type: "number" },
      playbookCount: { type: "number", minimum: 0 },
      availablePlaybookCount: { type: "number", minimum: 0 },
      playbooks: {
        type: "array",
        maxItems: 16,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "category",
            "label",
            "summary",
            "userValue",
            "exampleRequests",
            "requiredToolNames",
            "optionalToolNames",
            "available",
            "unavailableToolNames",
            "requiresBridge",
            "requiresConfirmation",
            "maxRiskLevel",
            "outputTrust",
            "untrustedOutputToolNames",
            "safetyBoundaries"
          ],
          properties: {
            id: { type: "string", maxLength: 80 },
            category: { type: "string", enum: PLAYBOOK_CATEGORY_VALUES },
            label: { type: "string", maxLength: 120 },
            summary: { type: "string", maxLength: 260 },
            userValue: { type: "string", maxLength: 240 },
            exampleRequests: { type: "array", items: { type: "string", maxLength: 180 }, maxItems: 4 },
            requiredToolNames: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
            optionalToolNames: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 12 },
            available: { type: "boolean" },
            unavailableToolNames: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 16 },
            requiresBridge: { type: "boolean" },
            requiresConfirmation: { type: "boolean" },
            maxRiskLevel: { type: "string", enum: ["L0", "L1", "L2", "L3"] },
            outputTrust: { type: "string", enum: ["trusted", "untrusted", "mixed"] },
            untrustedOutputToolNames: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 16 },
            safetyBoundaries: { type: "array", items: { type: "string", maxLength: 220 }, maxItems: 8 }
          }
        }
      },
      safetyBoundaries: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        maxItems: 8
      },
      notes: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        maxItems: 8
      }
    }
  },
  requiredResources: [
    {
      kind: "memory",
      key: "task-playbook-policy",
      mode: "shared"
    },
    {
      kind: "memory",
      key: "tool-registry",
      mode: "shared"
    }
  ],
  permissions: ["tool.agent.inspectTaskPlaybooks"],
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
    const toolMap = new Map(listToolMetadata().map((tool) => [tool.name, tool]));
    const grants = getCurrentPermissionGrants();
    const playbooks = listAgentTaskPlaybooks().map((playbook) => {
      const allToolNames = [...playbook.requiredToolNames, ...playbook.optionalToolNames];
      const unavailableToolNames = playbook.requiredToolNames.filter(
        (toolName) => !isToolAvailable(toolMap.get(toolName), grants)
      );
      const availableToolNames = allToolNames.filter(
        (toolName) => isToolAvailable(toolMap.get(toolName), grants)
      );
      const maxRiskLevel = resolveMaxRiskLevel(
        playbook.expectedMaxRiskLevel,
        availableToolNames
          .map((toolName) => toolMap.get(toolName)?.riskLevel)
          .filter((riskLevel): riskLevel is RiskLevel => Boolean(riskLevel))
      );

      return {
        id: playbook.id,
        category: playbook.category,
        label: playbook.label,
        summary: playbook.summary,
        userValue: playbook.userValue,
        exampleRequests: playbook.exampleRequests,
        requiredToolNames: playbook.requiredToolNames,
        optionalToolNames: playbook.optionalToolNames,
        available: unavailableToolNames.length === 0,
        unavailableToolNames,
        requiresBridge: playbook.requiresBridge,
        requiresConfirmation:
          playbook.requiresConfirmation
          || RISK_ORDER[maxRiskLevel] >= RISK_ORDER.L2,
        maxRiskLevel,
        outputTrust: summarizeToolOutputTrust(availableToolNames),
        untrustedOutputToolNames: listUntrustedOutputToolNames(availableToolNames),
        safetyBoundaries: playbook.safetyBoundaries
      };
    });

    return {
      status: "ok",
      inspectedAt: Date.now(),
      playbookCount: playbooks.length,
      availablePlaybookCount: playbooks.filter((playbook) => playbook.available).length,
      playbooks,
      safetyBoundaries: [
        "Playbook 是只读组合任务目录，不是插件执行器、脚本引擎或远端 MCP。",
        "本工具不会执行任务、读取文件、打开网页、连接 bridge 或发网络请求。",
        "真实执行仍必须走当前工具白名单、Schema 校验、权限 grants、资源锁、动态安全 hook、确认和审计。",
        "如果某个必需工具未注册或缺授权，对应 playbook 会标记为 unavailable。"
      ],
      notes: [
        "这些 playbook 只覆盖 VOID 当前已经落地且可审计的组合任务。",
        "用户问某个具体任务能不能做时，可结合 agent.planTaskRoute 做单任务预演。"
      ]
    };
  }
};

function isToolAvailable(
  tool: ToolMetadata | undefined,
  grants: ReadonlySet<string>
): tool is ToolMetadata {
  return Boolean(
    tool
    && tool.enabled !== false
    && !isToolHiddenFromUserFacingCapabilities(tool.name)
    && hasToolPermissionGrants(tool, grants)
  );
}

function resolveMaxRiskLevel(
  fallback: RiskLevel,
  riskLevels: RiskLevel[]
): RiskLevel {
  return riskLevels.reduce<RiskLevel>(
    (highest, riskLevel) => (
      RISK_ORDER[riskLevel] > RISK_ORDER[highest] ? riskLevel : highest
    ),
    fallback
  );
}
