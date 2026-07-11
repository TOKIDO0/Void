// 工具注册表：只解决「有哪些工具」，不负责执行。
// 设计依据：`.md/27` §5.1。

import type { ToolDefinition, ToolMetadata } from "./toolTypes";

const toolsByName = new Map<string, ToolDefinition>();

/**
 * 注册工具。同名覆盖前会抛错，避免静默替换生产工具。
 * 使用 any 入参泛型：具体工具的 TInput 比 unknown 更窄，注册表统一存宽类型。
 */
export function registerTool(definition: ToolDefinition<any, any>) {
  const name = definition.name.trim();
  if (!name) {
    throw new Error("工具 name 不能为空");
  }
  if (toolsByName.has(name)) {
    throw new Error(`工具已注册，禁止覆盖：${name}`);
  }
  if (!definition.inputSchema || typeof definition.inputSchema !== "object") {
    throw new Error(`工具 ${name} 缺少 inputSchema`);
  }
  if (typeof definition.execute !== "function") {
    throw new Error(`工具 ${name} 缺少 execute`);
  }

  toolsByName.set(name, {
    ...definition,
    name,
    enabled: definition.enabled !== false,
    maxRetries: definition.maxRetries ?? 0
  });
}

/**
 * 按名称取完整定义（含 execute）。执行器专用。
 */
export function getTool(name: string): ToolDefinition | undefined {
  return toolsByName.get(name.trim());
}

/**
 * 按名称取只读元数据（不含 execute）。
 */
export function getToolMetadata(name: string): ToolMetadata | undefined {
  const tool = getTool(name);
  if (!tool) {
    return undefined;
  }
  return toMetadata(tool);
}

/**
 * 列出全部已注册工具元数据。
 */
export function listToolMetadata(): ToolMetadata[] {
  return Array.from(toolsByName.values()).map(toMetadata);
}

/**
 * 是否已注册。
 */
export function hasTool(name: string) {
  return toolsByName.has(name.trim());
}

/**
 * 清空注册表（仅供本地自检 / 重置默认工具集时使用，不暴露给业务 UI）。
 */
export function clearToolRegistry() {
  toolsByName.clear();
}

function toMetadata(tool: ToolDefinition): ToolMetadata {
  const { execute: _execute, ...metadata } = tool;
  return metadata;
}
