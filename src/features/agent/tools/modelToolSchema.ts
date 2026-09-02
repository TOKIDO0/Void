// 把内部工具元数据映射为模型可消费的 OpenAI tools schema。
// 模型只看 name / description / parameters；execute 永不下发。
// 注意：OpenAI/DeepSeek 要求 function.name 匹配 ^[a-zA-Z0-9_-]+$
// 内部工具名含点号（browser.search），下发时转成 browser_search，回写时再映射回。

import type { ProviderToolDefinition } from "../../../lib/model-providers/providerContract";
import { listToolMetadata } from "./toolRegistry";
import type { ToolJsonSchema, ToolMetadata } from "./toolTypes";
import {
  getCurrentPermissionGrants,
  hasToolPermissionGrants,
  type PermissionGrants
} from "../permissions";
import { sanitizeParametersSchema } from "./sanitizeToolSchemas";

/**
 * 不暴露给模型的工具：
 * - echo：冒烟专用
 * - browser.screenshot / browser.readResult：易诱使模型空转截图/重读，
 *   当前产品主路径是 search → open/select → revealInSystemBrowser
 */
const MODEL_HIDDEN_TOOLS = new Set([
  "echo",
  "browser.screenshot",
  "browser.readResult"
]);

/**
 * 内部工具名 → 模型可见名（点号改下划线）。
 */
export function toModelToolName(internalName: string) {
  return internalName.trim().replace(/\./g, "_");
}

/**
 * 模型可见名 → 内部工具名。
 * 优先精确匹配已注册工具；否则把末尾常见分段还原为点号形式。
 */
export function fromModelToolName(modelName: string) {
  const trimmed = modelName.trim();
  if (!trimmed) {
    return trimmed;
  }

  // 已是内部名（含点）
  if (trimmed.includes(".")) {
    return trimmed;
  }

  const metadata = listToolMetadata();
  const exact = metadata.find((tool) => toModelToolName(tool.name) === trimmed);
  if (exact) {
    return exact.name;
  }

  // 兜底：browser_search → browser.search（仅当注册表里存在）
  const withDots = trimmed.replace(/_/g, ".");
  if (metadata.some((tool) => tool.name === withDots)) {
    return withDots;
  }

  return trimmed;
}

/**
 * 列出当前应对模型可见的工具定义。
 */
export function listModelToolDefinitions(
  grants: PermissionGrants = getCurrentPermissionGrants()
): ProviderToolDefinition[] {
  return listToolMetadata()
    .filter((tool) =>
      tool.enabled !== false
      && !MODEL_HIDDEN_TOOLS.has(tool.name)
      && hasToolPermissionGrants(tool, grants)
    )
    .map(toProviderToolDefinition);
}

function toProviderToolDefinition(tool: ToolMetadata): ProviderToolDefinition {
  return {
    type: "function",
    function: {
      name: toModelToolName(tool.name),
      description: buildModelFacingDescription(tool),
      parameters: toolJsonSchemaToParameters(tool.inputSchema)
    }
  };
}

/**
 * 描述里附带风险等级，帮助模型在敏感步骤前先说明意图。
 */
function buildModelFacingDescription(tool: ToolMetadata) {
  const riskHint =
    tool.riskLevel === "L0" || tool.riskLevel === "L1"
      ? "可自动执行"
      : "敏感操作，执行前会请用户确认";
  return `${tool.description}（风险 ${tool.riskLevel}，${riskHint}）`;
}

/**
 * 内部 ToolJsonSchema → 模型 parameters（保持 object 形态）。
 */
function toolJsonSchemaToParameters(schema: ToolJsonSchema): Record<string, unknown> {
  // 模型侧参数根类型必须是 object
  if (!schema || schema.type !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: false
    };
  }

  const cloned = cloneSchema(schema);
  // 下发前最小净化：多后端兼容（llama.cpp/Anthropic 严格校验），不改 registry 真源
  try {
    return sanitizeParametersSchema(cloned as ToolJsonSchema);
  } catch {
    return cloned as Record<string, unknown>;
  }
}

function cloneSchema(schema: ToolJsonSchema): unknown {
  const next: Record<string, unknown> = {};
  if (schema.type) {
    next.type = schema.type;
  }
  if (schema.description) {
    next.description = schema.description;
  }
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = cloneSchema(value);
    }
    next.properties = properties;
  }
  if (schema.required) {
    next.required = [...schema.required];
  }
  if (schema.anyOf) {
    next.anyOf = schema.anyOf.map((item) => cloneSchema(item));
  }
  if (schema.additionalProperties !== undefined) {
    next.additionalProperties = schema.additionalProperties;
  }
  if (schema.items) {
    next.items = cloneSchema(schema.items);
  }
  if (schema.enum) {
    next.enum = [...schema.enum];
  }
  if (schema.minLength !== undefined) {
    next.minLength = schema.minLength;
  }
  if (schema.maxLength !== undefined) {
    next.maxLength = schema.maxLength;
  }
  if (schema.minimum !== undefined) {
    next.minimum = schema.minimum;
  }
  if (schema.maximum !== undefined) {
    next.maximum = schema.maximum;
  }
  if (schema.minItems !== undefined) {
    next.minItems = schema.minItems;
  }
  if (schema.maxItems !== undefined) {
    next.maxItems = schema.maxItems;
  }
  return next;
}
