// P6 高权限接管：原始键鼠输入（L1，会话 scope 内自动；scope 由 L3 开启时授予，Rust 侧逐次核验）。
// 文本走审计脱敏（text 不进日志），反作弊黑名单无豁免。

import { takeoverInput } from "../../takeover/takeoverBridgeClient";
import { TAKEOVER_INPUT_RESOURCES, throwAsTakeoverToolError } from "../../takeover/takeoverToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type DesktopTakeoverInputToolInput = {
  kind: "keyTap" | "keyDown" | "keyUp" | "typeText" | "mouseMove" | "mouseClick";
  key?: string;
  text?: string;
  button?: string;
  x?: number;
  y?: number;
};

const INPUT_KINDS = ["keyTap", "keyDown", "keyUp", "typeText", "mouseMove", "mouseClick"];

export const desktopTakeoverInputTool: ToolDefinition<DesktopTakeoverInputToolInput, Record<string, unknown>> = {
  name: "desktop.takeoverInput",
  description:
    "接管会话内的原始键鼠输入（按键/按住/松开/打字≤200字/鼠标移动/点击）；仅会话有效且前台命中白名单时执行，反作弊进程永远拒绝。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: INPUT_KINDS },
      key: { type: "string", minLength: 1, maxLength: 16 },
      text: { type: "string", minLength: 1, maxLength: 200 },
      button: { type: "string", enum: ["left", "right", "middle"] },
      x: { type: "number", minimum: -10000, maximum: 10000 },
      y: { type: "number", minimum: -10000, maximum: 10000 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ok", "foregroundExe", "at"],
    properties: {
      ok: { type: "boolean" },
      foregroundExe: { type: "string" },
      at: { type: "number" }
    }
  },
  requiredResources: TAKEOVER_INPUT_RESOURCES,
  permissions: ["tool.desktop.takeoverInput"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["text"],
    redactOutputKeys: []
  },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    if (!INPUT_KINDS.includes(input.kind)) {
      throw createToolError("SCHEMA_INVALID", "kind 非法", undefined, false);
    }
    if ((input.kind === "keyTap" || input.kind === "keyDown" || input.kind === "keyUp") && !input.key?.trim()) {
      throw createToolError("SCHEMA_INVALID", "按键类输入必须给 key", undefined, false);
    }
    if (input.kind === "typeText" && !input.text?.trim()) {
      throw createToolError("SCHEMA_INVALID", "打字输入必须给 text", undefined, false);
    }
    if (input.kind === "mouseMove" && (input.x === undefined || input.y === undefined)) {
      throw createToolError("SCHEMA_INVALID", "鼠标移动必须给 x/y", undefined, false);
    }
    if (input.kind === "mouseClick" && !input.button) {
      throw createToolError("SCHEMA_INVALID", "鼠标点击必须给 button", undefined, false);
    }
    try {
      return await takeoverInput({
        kind: input.kind,
        key: input.key?.trim(),
        text: input.text,
        button: input.button,
        x: input.x,
        y: input.y
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsTakeoverToolError(error);
    }
  }
};
