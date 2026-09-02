// 参数宽容：把 LLM 常见的 string→number/boolean/array 误吐在校验前纠正。
// 对标 Hermes `model_tools.py:coerce_tool_args`（轻量化，适配 VOID ToolJsonSchema 单 type + anyOf 形态）。
// 纯函数，无副作用；失败时原值保留，交由后续 validateAgainstSchema 报 SCHEMA_INVALID。

import { getTool } from "./toolRegistry";
import type { ToolJsonSchema } from "./toolTypes";

export function coerceToolArgs(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return args;
  }
  const tool = getTool(toolName);
  if (!tool) {
    return args;
  }
  const schema = tool.inputSchema;
  if (!schema || schema.type !== "object" || !schema.properties) {
    return args;
  }
  const input = args as Record<string, unknown>;
  const properties = schema.properties;
  let mutated = false;
  const next: Record<string, unknown> = { ...input };

  for (const [key, value] of Object.entries(input)) {
    const propSchema = properties[key];
    if (!propSchema) {
      continue;
    }
    const coerced = coerceValueForSchema(value, propSchema);
    if (coerced !== value) {
      next[key] = coerced;
      mutated = true;
    }
  }

  return mutated ? next : args;
}

function coerceValueForSchema(value: unknown, schema: ToolJsonSchema): unknown {
  // null 字符串 -> null（仅当 schema 允许 null）
  if (typeof value === "string" && value.trim().toLowerCase() === "null" && schemaAllowsNull(schema)) {
    return null;
  }

  // 显式 anyOf 包含 null 的 string "null" 亦处理（上句已覆盖单层，anyOf 递归同理）
  // 数组宽容：bare scalar -> [scalar]；JSON 字符串 -> 解析
  if (schema.type === "array" || schemaAcceptsKind(schema, "array")) {
    if (value !== null && value !== undefined && !Array.isArray(value)) {
      if (typeof value === "string") {
        const parsed = tryParseJsonArray(value, schema);
        if (parsed !== value) {
          // 解析到容器后再递归规整嵌套 JSON 字符串元素
          return normalizeJsonStringsForSchema(parsed, schema);
        }
        if (value.trim().startsWith("[")) {
          // 看似 JSON 数组但解析失败，按 Hermes 警告语义降为单元素包裹，避免静默丢弃
          return [value];
        }
        // 裸字符串按单元素包裹（对应 Hermes wrap bare string in list）
        return [value];
      }
      // 非字符串裸值（如 number/boolean/object）亦包裹
      return [value];
    }
    if (Array.isArray(value)) {
      return normalizeJsonStringsForSchema(value, schema);
    }
  }

  if (schema.type === "object" || schemaAcceptsKind(schema, "object")) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{")) {
        const parsed = tryParseJsonObject(trimmed);
        if (parsed !== value) {
          return normalizeJsonStringsForSchema(parsed, schema);
        }
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return normalizeJsonStringsForSchema(value as Record<string, unknown>, schema);
    }
  }

  if (typeof value !== "string") {
    // 已是容器但非裸值场景：递归规整嵌套 JSON 字符串
    if (Array.isArray(value) && schema.items) {
      return normalizeJsonStringsForSchema(value, schema);
    }
    if (value && typeof value === "object" && !Array.isArray(value) && (schema.type === "object" || schema.properties)) {
      return normalizeJsonStringsForSchema(value as Record<string, unknown>, schema);
    }
    return value;
  }

  // 此时 value 为 string，按目标类型尝试转换
  const expected = schema.type;
  if (expected === "number" || expected === "integer") {
    const coerced = coerceNumber(value, expected === "integer");
    if (coerced !== value) {
      return coerced;
    }
  }
  if (expected === "boolean") {
    const coerced = coerceBoolean(value);
    if (coerced !== value) {
      return coerced;
    }
  }
  if (expected === "array") {
    const coerced = tryParseJsonArray(value, schema);
    if (coerced !== value) {
      return normalizeJsonStringsForSchema(coerced, schema);
    }
  }
  if (expected === "object") {
    const parsed = tryParseJsonObject(value.trim());
    if (parsed !== value) {
      return normalizeJsonStringsForSchema(parsed as Record<string, unknown>, schema);
    }
  }
  // anyOf 含目标类型的联合：尝试分支逐一纠正（Hermes 对 union 的逻辑）
  if (schema.anyOf?.length) {
    for (const branch of schema.anyOf) {
      if (!branch.type) {
        continue;
      }
      const attempt = coerceValueForSchema(value, branch);
      if (attempt !== value) {
        return attempt;
      }
    }
  }

  return value;
}

function coerceNumber(value: string, integerOnly: boolean): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  // 仅允许纯数值字面量，避免 "12abc" 误转
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return value;
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return value;
  }
  if (integerOnly && !Number.isInteger(num)) {
    return value;
  }
  // Hermes：浮点字符串但无小数位时仍转 int
  if (Number.isInteger(num)) {
    return Math.trunc(num);
  }
  return num;
}

function coerceBoolean(value: string): unknown {
  const low = value.trim().toLowerCase();
  if (low === "true") {
    return true;
  }
  if (low === "false") {
    return false;
  }
  return value;
}

function tryParseJsonArray(value: string, _schema: ToolJsonSchema): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return value;
  } catch {
    return value;
  }
}

function tryParseJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return value;
  } catch {
    return value;
  }
}

function schemaAllowsNull(schema: ToolJsonSchema): boolean {
  if (schema.type === "null") {
    return true;
  }
  if (schema.anyOf?.some((b) => b.type === "null")) {
    return true;
  }
  return false;
}

function schemaAcceptsKind(schema: ToolJsonSchema, kind: "array" | "object"): boolean {
  if (schema.type === kind) {
    return true;
  }
  if (schema.anyOf?.some((b) => b.type === kind)) {
    return true;
  }
  return false;
}

function normalizeJsonStringsForSchema(value: unknown, schema: ToolJsonSchema): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const expectsArray = schemaAcceptsKind(schema, "array");
    const expectsObject = schemaAcceptsKind(schema, "object");
    if ((expectsArray && trimmed.startsWith("[")) || (expectsObject && trimmed.startsWith("{"))) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (expectsArray && Array.isArray(parsed)) {
          return normalizeJsonStringsForSchema(parsed, schema);
        }
        if (expectsObject && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return normalizeJsonStringsForSchema(parsed as Record<string, unknown>, schema);
        }
      } catch {
        return value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    const itemsSchema = schema.items;
    if (!itemsSchema || typeof itemsSchema !== "object") {
      return value;
    }
    let changed = false;
    const out: unknown[] = [];
    for (const item of value) {
      const next = normalizeJsonStringsForSchema(item, itemsSchema as ToolJsonSchema);
      if (next !== item) {
        changed = true;
      }
      out.push(next);
    }
    return changed ? out : value;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema as { properties?: Record<string, ToolJsonSchema> }).properties;
    if (!props || typeof props !== "object") {
      return value;
    }
    let changed = false;
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, propSchema] of Object.entries(props)) {
      if (!(k in (value as Record<string, unknown>))) {
        continue;
      }
      const next = normalizeJsonStringsForSchema((value as Record<string, unknown>)[k], propSchema as ToolJsonSchema);
      if (next !== (value as Record<string, unknown>)[k]) {
        out[k] = next;
        changed = true;
      }
    }
    return changed ? out : value;
  }

  return value;
}
