// 下发前 schema 宽容净化，对标 Hermes tools/schema_sanitizer.py 最小集。
// 目标：多后端兼容（llama.cpp/Anthropic/Gemini 严格校验）+ 防畸形 anyOf/空 object 导致 400。
// 仅在 modelToolSchema 产出 parameters 时做深拷贝层清洗，不改 registry 真源。

import type { ToolJsonSchema } from "./toolTypes";

export function sanitizeParametersSchema(schema: ToolJsonSchema): Record<string, unknown> {
  const cloned = cloneForSanitize(schema);
  const sanitized = sanitizeNode(cloned as Record<string, unknown>);
  return sanitized as Record<string, unknown>;
}

function cloneForSanitize(schema: ToolJsonSchema): ToolJsonSchema {
  return JSON.parse(JSON.stringify(schema)) as ToolJsonSchema;
}

function sanitizeNode(node: Record<string, unknown>): Record<string, unknown> {
  if (!node || typeof node !== "object") {
    return node;
  }

  // 1) type 数组归一：["string","null"] -> anyOf:[{type:string},{type:null}]，避免 Gemini/llama 拒 type 数组
  if (Array.isArray(node.type)) {
    const types = (node.type as unknown[]).filter((t) => typeof t === "string") as string[];
    if (types.length > 1) {
      const anyOf = types.map((t) => ({ type: t }));
      delete node.type;
      node.anyOf = [...((node.anyOf as unknown[]) ?? []), ...anyOf];
    } else if (types.length === 1) {
      node.type = types[0];
    }
  }

  // 2) 空 object 补 properties：llama.cpp 拒 {"type":"object"} 无 properties
  if (node.type === "object" && !node.properties) {
    node.properties = {};
  }

  // 3) required 修剪：仅保留 properties 中真实存在的 key
  if (Array.isArray(node.required) && node.properties && typeof node.properties === "object") {
    const propKeys = new Set(Object.keys(node.properties as Record<string, unknown>));
    const trimmed = (node.required as string[]).filter((k) => propKeys.has(k));
    if (trimmed.length === 0) {
      delete node.required;
    } else {
      node.required = trimmed;
    }
  }

  // 4) nullable anyOf 折叠：anyOf:[{type:string},{type:null}] 保留（Anthropic 需 anyOf），但剥离无意义分支
  if (Array.isArray(node.anyOf)) {
    const branches = (node.anyOf as Record<string, unknown>[]).filter((b) => b && typeof b === "object");
    // 去重与剔除空分支
    const deduped: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const b of branches) {
      const key = JSON.stringify(b);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(b);
      }
    }
    if (deduped.length === 0) {
      delete node.anyOf;
    } else if (deduped.length === 1) {
      // 单分支 anyOf 提升为顶层（化简）
      const sole = deduped[0];
      delete node.anyOf;
      for (const [k, v] of Object.entries(sole)) {
        if (!(k in node)) {
          (node as Record<string, unknown>)[k] = v;
        }
      }
    } else {
      node.anyOf = deduped;
    }
  }

  // 5) 递归子节点
  if (node.properties && typeof node.properties === "object") {
    for (const [k, v] of Object.entries(node.properties as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        (node.properties as Record<string, unknown>)[k] = sanitizeNode(v as Record<string, unknown>);
      }
    }
  }
  if (node.items && typeof node.items === "object") {
    node.items = sanitizeNode(node.items as Record<string, unknown>);
  }
  if (Array.isArray(node.anyOf)) {
    node.anyOf = (node.anyOf as Record<string, unknown>[]).map((b) => sanitizeNode(b));
  }

  // 6) 去除非标准畸形：additionalProperties 若为 "object" 字符串（MCP 畸形）则删
  if (typeof node.additionalProperties === "string") {
    delete node.additionalProperties;
  }

  return node;
}
