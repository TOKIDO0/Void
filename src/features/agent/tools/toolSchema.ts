// 轻量 Schema 校验器：只支持 ToolJsonSchema 子集，拦截非法参数进入工具实现。
// 设计依据：`.md/27` §4.1 / §5.3。

import type { ToolJsonSchema } from "./toolTypes";

export type SchemaValidationIssue = {
  path: string;
  message: string;
};

export type SchemaValidationResult =
  | { valid: true; value: unknown }
  | { valid: false; issues: SchemaValidationIssue[] };

/**
 * 校验并（可选）收紧输入值。
 * 失败时返回 issues，执行器不得调用工具 execute。
 */
export function validateAgainstSchema(
  schema: ToolJsonSchema,
  value: unknown,
  path = "$"
): SchemaValidationResult {
  const issues: SchemaValidationIssue[] = [];
  collectIssues(schema, value, path, issues);

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, value };
}

function collectIssues(
  schema: ToolJsonSchema,
  value: unknown,
  path: string,
  issues: SchemaValidationIssue[]
) {
  if (schema.type) {
    if (!matchesType(schema.type, value)) {
      issues.push({
        path,
        message: `期望类型 ${schema.type}，实际为 ${describeType(value)}`
      });
      return;
    }
  }

  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    issues.push({
      path,
      message: `值不在允许枚举内：${schema.enum.map(String).join(", ")}`
    });
    return;
  }

  if (schema.anyOf?.length) {
    const anyBranchValid = schema.anyOf.some((branch) => {
      const branchIssues: SchemaValidationIssue[] = [];
      collectIssues(branch, value, path, branchIssues);
      return branchIssues.length === 0;
    });
    if (!anyBranchValid) {
      issues.push({ path, message: "至少需要满足一个 anyOf 条件" });
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path, message: `字符串长度不得小于 ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path, message: `字符串长度不得大于 ${schema.maxLength}` });
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `数值不得小于 ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `数值不得大于 ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `数组元素数不得小于 ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `数组元素数不得大于 ${schema.maxItems}` });
    }
    if (schema.items) {
      value.forEach((item, index) => {
        collectIssues(schema.items as ToolJsonSchema, item, `${path}[${index}]`, issues);
      });
    }
  }

  if (
    schema.type === "object"
    || schema.properties
    || schema.required
    || schema.additionalProperties !== undefined
  ) {
    if (!isPlainObject(value)) {
      issues.push({ path, message: "期望对象" });
      return;
    }

    const objectValue = value as Record<string, unknown>;
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in objectValue) || objectValue[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: "缺少必填字段" });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (objectValue[key] === undefined) {
        continue;
      }
      collectIssues(propertySchema, objectValue[key], `${path}.${key}`, issues);
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) {
          issues.push({ path: `${path}.${key}`, message: "不允许额外字段" });
        }
      }
    }
  }
}

function matchesType(type: NonNullable<ToolJsonSchema["type"]>, value: unknown) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
