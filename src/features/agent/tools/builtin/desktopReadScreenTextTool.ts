// AQ 读屏 OCR：识别运行时目录内截图的文字（含词级坐标，可直接喂给接管点击）。
// L0 只读；自渲染应用（微信 4.x）的读字通道，不碰协议/Hook/注入。

import { ocrImageFile } from "../../desktop/desktopOcrClient";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type DesktopReadScreenTextToolInput = {
  path: string;
};

export const desktopReadScreenTextTool: ToolDefinition<DesktopReadScreenTextToolInput, Record<string, unknown>> = {
  name: "desktop.readScreenText",
  description:
    "识别指定截图图片中的文字行与词级坐标（Windows 原生 OCR，离线免费）。先 desktop.screenshot 截图再识别；自渲染窗口读字就靠它。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 300 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "lines", "lineCount", "readAt"],
    properties: {
      path: { type: "string" },
      lines: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "words"],
          properties: {
            text: { type: "string" },
            words: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "x", "y", "width", "height"],
                properties: {
                  text: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                  width: { type: "number" },
                  height: { type: "number" }
                }
              }
            }
          }
        }
      },
      lineCount: { type: "number", minimum: 0 },
      readAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.readScreenText"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const path = input.path?.trim();
    if (!path) {
      throw createToolError("SCHEMA_INVALID", "path 不能为空", undefined, false);
    }
    try {
      const lines = await ocrImageFile(path);
      return {
        path,
        lines,
        lineCount: lines.length,
        readAt: Date.now()
      } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};
