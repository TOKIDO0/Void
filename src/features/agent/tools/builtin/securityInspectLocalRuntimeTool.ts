/**
 * S19：本地运行时安全自检。
 * 只读取 bridge 当前进程暴露的安全摘要，不扫描磁盘、不执行命令、不打开端口。
 */

import {
  getSecurityBridgeErrorInfo,
  inspectLocalRuntimeSecurity,
  type LocalRuntimeSecurityStatusData
} from "../../security/localRuntimeSecurityClient";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type SecurityInspectLocalRuntimeToolInput = Record<string, never>;
export type SecurityInspectLocalRuntimeToolOutput = LocalRuntimeSecurityStatusData;

export const securityInspectLocalRuntimeTool: ToolDefinition<
  SecurityInspectLocalRuntimeToolInput,
  SecurityInspectLocalRuntimeToolOutput
> = {
  name: "security.inspectLocalRuntime",
  description:
    "只读检查 VOID 本地运行时安全状态：bridge 监听地址/token/CORS、模型代理请求体与并发上限、浏览器会话上限、网卡地址范围计数摘要。不扫描全盘、不执行 Shell、不返回真实网卡 IP。",
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
    required: ["status", "overall", "inspectedAt", "bridge", "proxy", "browser", "network", "checks"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      overall: { type: "string", enum: ["healthy", "attention", "unsafe"] },
      inspectedAt: { type: "number" },
      bridge: {
        type: "object",
        additionalProperties: false,
        required: [
          "host",
          "port",
          "origin",
          "listenIsLoopback",
          "tokenRequired",
          "allowedOrigins",
          "allowedListenHosts",
          "allowedHostnames",
          "securityHeaders",
          "timeouts"
        ],
        properties: {
          host: { type: "string" },
          port: { type: "number", minimum: 0, maximum: 65535 },
          origin: { type: "string" },
          listenIsLoopback: { type: "boolean" },
          tokenRequired: { type: "boolean" },
          allowedOrigins: { type: "array", items: { type: "string" }, maxItems: 20 },
          allowedListenHosts: { type: "array", items: { type: "string" }, maxItems: 10 },
          allowedHostnames: { type: "array", items: { type: "string" }, maxItems: 10 },
          securityHeaders: { type: "array", items: { type: "string" }, maxItems: 10 },
          timeouts: {
            type: "object",
            additionalProperties: false,
            required: [
              "headersTimeoutMs",
              "requestTimeoutMs",
              "keepAliveTimeoutMs",
              "maxHeadersCount"
            ],
            properties: {
              headersTimeoutMs: { type: "number", minimum: 0 },
              requestTimeoutMs: { type: "number", minimum: 0 },
              keepAliveTimeoutMs: { type: "number", minimum: 0 },
              maxHeadersCount: { type: "number", minimum: 0 }
            }
          }
        }
      },
      proxy: {
        type: "object",
        additionalProperties: false,
        required: ["requestBodyMaxBytes", "maxConcurrentRequests", "activeRequests"],
        properties: {
          requestBodyMaxBytes: { type: "number", minimum: 0 },
          maxConcurrentRequests: { type: "number", minimum: 1 },
          activeRequests: { type: "number", minimum: 0 }
        }
      },
      browser: {
        type: "object",
        additionalProperties: false,
        required: [
          "browserReady",
          "activeSessions",
          "maxSessions",
          "sessionIdleTtlMs",
          "headless"
        ],
        properties: {
          browserReady: { type: "boolean" },
          activeSessions: { type: "number", minimum: 0 },
          maxSessions: { type: "number", minimum: 1 },
          sessionIdleTtlMs: { type: "number", minimum: 0 },
          headless: { type: "boolean" }
        }
      },
      network: {
        type: "object",
        additionalProperties: false,
        required: ["interfaceCount", "nonLoopbackAddressCount", "addressCounts"],
        properties: {
          interfaceCount: { type: "number", minimum: 0 },
          nonLoopbackAddressCount: { type: "number", minimum: 0 },
          addressCounts: {
            type: "object",
            additionalProperties: false,
            required: ["loopback", "private", "linkLocal", "uniqueLocal", "public", "other"],
            properties: {
              loopback: { type: "number", minimum: 0 },
              private: { type: "number", minimum: 0 },
              linkLocal: { type: "number", minimum: 0 },
              uniqueLocal: { type: "number", minimum: 0 },
              public: { type: "number", minimum: 0 },
              other: { type: "number", minimum: 0 }
            }
          }
        }
      },
      checks: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "ok", "severity", "message"],
          properties: {
            id: { type: "string" },
            ok: { type: "boolean" },
            severity: { type: "string", enum: ["info", "warning", "danger"] },
            message: { type: "string", maxLength: 300 }
          }
        }
      }
    }
  },
  requiredResources: [
    {
      kind: "runtime",
      key: "local-security-status",
      mode: "shared"
    }
  ],
  permissions: ["tool.security.inspectLocalRuntime"],
  timeoutMs: 5_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true
  },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await inspectLocalRuntimeSecurity(context.signal);
    } catch (error) {
      throw mapSecurityErrorToToolError(error);
    }
  }
};

function mapSecurityErrorToToolError(error: unknown) {
  const info = getSecurityBridgeErrorInfo(error);
  const details = {
    ...(info.details ?? {}),
    failureKind: info.code.toLowerCase(),
    securityCode: info.code
  };

  if (info.code === "TIMEOUT") {
    return createToolError("TIMEOUT", info.message, details, true);
  }

  if (info.code === "BRIDGE_UNREACHABLE") {
    return createToolError(
      "EXECUTION_FAILED",
      info.message,
      { ...details, bridgeUnreachable: true },
      true
    );
  }

  return createToolError("EXECUTION_FAILED", info.message, details, false);
}
