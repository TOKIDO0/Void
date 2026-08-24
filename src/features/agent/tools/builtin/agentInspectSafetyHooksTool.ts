/**
 * S27：动态安全 hook 自检。
 * 把运行时会抬升风险/触发确认的规则暴露成只读事实，方便用户理解边界。
 */

import {
  getCurrentPermissionGrants,
  hasToolPermissionGrants,
  listToolSafetyHookDefinitions
} from "../../permissions";
import { isToolHiddenFromUserFacingCapabilities } from "../../security/toolVisibilityPolicy";
import { listToolMetadata } from "../toolRegistry";
import type { RiskLevel, ToolDefinition, ToolMetadata } from "../toolTypes";

export type AgentInspectSafetyHooksToolInput = Record<string, never>;

export type AgentInspectSafetyHooksToolOutput = {
  status: "ok";
  inspectedAt: number;
  hookCount: number;
  staticConfirmationToolCount: number;
  staticConfirmationToolNames: string[];
  hooks: Array<{
    id: string;
    label: string;
    kind: "sensitive-url" | "sensitive-path";
    riskLevel: RiskLevel;
    requiresConfirmation: boolean;
    executionToolNames: string[];
    preflightRelevantToolNames: string[];
    registeredToolNames: string[];
    missingToolNames: string[];
    authorizedToolNames: string[];
    disabledToolNames: string[];
    missingPermissionToolNames: string[];
    triggerSummary: string[];
    confirmationTitles: string[];
    boundary: string;
  }>;
  currentGuarantees: string[];
  notes: string[];
};

export const agentInspectSafetyHooksTool: ToolDefinition<
  AgentInspectSafetyHooksToolInput,
  AgentInspectSafetyHooksToolOutput
> = {
  name: "agent.inspectSafetyHooks",
  description:
    "只读列出 VOID 当前动态安全 hook：哪些 URL、路径或输入会把工具风险抬升为 L2 确认、影响哪些工具、确认标题是什么，以及这些 hook 的执行边界。不请求 URL、不读取路径、不连接 bridge、不执行被检查工具。",
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
      "hookCount",
      "staticConfirmationToolCount",
      "staticConfirmationToolNames",
      "hooks",
      "currentGuarantees",
      "notes"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      inspectedAt: { type: "number" },
      hookCount: { type: "number", minimum: 0 },
      staticConfirmationToolCount: { type: "number", minimum: 0 },
      staticConfirmationToolNames: { type: "array", items: { type: "string" }, maxItems: 40 },
      hooks: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "kind",
            "riskLevel",
            "requiresConfirmation",
            "executionToolNames",
            "preflightRelevantToolNames",
            "registeredToolNames",
            "missingToolNames",
            "authorizedToolNames",
            "disabledToolNames",
            "missingPermissionToolNames",
            "triggerSummary",
            "confirmationTitles",
            "boundary"
          ],
          properties: {
            id: { type: "string", maxLength: 80 },
            label: { type: "string", maxLength: 120 },
            kind: { type: "string", enum: ["sensitive-url", "sensitive-path"] },
            riskLevel: { type: "string", enum: ["L0", "L1", "L2", "L3"] },
            requiresConfirmation: { type: "boolean" },
            executionToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            preflightRelevantToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            registeredToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            missingToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            authorizedToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            disabledToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            missingPermissionToolNames: { type: "array", items: { type: "string" }, maxItems: 20 },
            triggerSummary: { type: "array", items: { type: "string", maxLength: 180 }, maxItems: 12 },
            confirmationTitles: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 8 },
            boundary: { type: "string", maxLength: 260 }
          }
        }
      },
      currentGuarantees: {
        type: "array",
        maxItems: 8,
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
      key: "tool-safety-policy",
      mode: "shared"
    },
    {
      kind: "memory",
      key: "tool-registry",
      mode: "shared"
    }
  ],
  permissions: ["tool.agent.inspectSafetyHooks"],
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
    const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
    const grants = getCurrentPermissionGrants();
    const hooks = listToolSafetyHookDefinitions().map((hook) =>
      buildHookSummary(hook, toolsByName, grants)
    );
    const staticConfirmationToolNames = listStaticConfirmationToolNames(allTools, grants);

    return {
      status: "ok",
      inspectedAt: Date.now(),
      hookCount: hooks.length,
      staticConfirmationToolCount: staticConfirmationToolNames.length,
      staticConfirmationToolNames,
      hooks,
      currentGuarantees: [
        "静态 L2/L3 工具默认需要用户确认；动态安全 hook 可把低风险工具按输入抬升为 L2。",
        "动态安全 hook 只会抬升风险和触发确认，不会扩大工具权限。",
        "预演阶段只分析用户请求文本，不打开 URL、不读取路径、不探测端口。",
        "执行阶段仍要先过 Schema 校验、权限 grants、资源锁和用户确认。",
        "用户拒绝确认后，被拦截的浏览器、下载或文件读取动作不会执行。"
      ],
      notes: [
        "这是安全 hook 自检，不是安全扫描。",
        "当前 hook 覆盖本地/私网 URL 与敏感凭据路径。",
        "如后续新增 hook，应先进入 toolSafetyPolicy 单一真源，再暴露给本工具。"
      ]
    };
  }
};

function buildHookSummary(
  hook: ReturnType<typeof listToolSafetyHookDefinitions>[number],
  toolsByName: ReadonlyMap<string, ToolMetadata>,
  grants: ReadonlySet<string>
): AgentInspectSafetyHooksToolOutput["hooks"][number] {
  const registeredToolNames: string[] = [];
  const missingToolNames: string[] = [];
  const authorizedToolNames: string[] = [];
  const disabledToolNames: string[] = [];
  const missingPermissionToolNames: string[] = [];

  for (const toolName of hook.executionToolNames) {
    const metadata = toolsByName.get(toolName);
    if (!metadata) {
      missingToolNames.push(toolName);
      continue;
    }

    registeredToolNames.push(toolName);
    if (metadata.enabled === false) {
      disabledToolNames.push(toolName);
      continue;
    }
    if (hasToolPermissionGrants(metadata, grants)) {
      authorizedToolNames.push(toolName);
    } else {
      missingPermissionToolNames.push(toolName);
    }
  }

  return {
    id: hook.id,
    label: hook.label,
    kind: hook.kind,
    riskLevel: hook.riskLevel,
    requiresConfirmation: hook.requiresConfirmation,
    executionToolNames: [...hook.executionToolNames],
    preflightRelevantToolNames: [...hook.preflightRelevantToolNames],
    registeredToolNames,
    missingToolNames,
    authorizedToolNames,
    disabledToolNames,
    missingPermissionToolNames,
    triggerSummary: [...hook.triggerSummary],
    confirmationTitles: [...hook.confirmationTitles],
    boundary: hook.boundary
  };
}

function listStaticConfirmationToolNames(
  tools: ToolMetadata[],
  grants: ReadonlySet<string>
): string[] {
  return tools
    .filter((tool) =>
      tool.enabled !== false
      && !isToolHiddenFromUserFacingCapabilities(tool.name)
      && hasToolPermissionGrants(tool, grants)
      && isConfirmationRiskLevel(tool.riskLevel)
    )
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
}

function isConfirmationRiskLevel(riskLevel: RiskLevel): boolean {
  return riskLevel === "L2" || riskLevel === "L3";
}
