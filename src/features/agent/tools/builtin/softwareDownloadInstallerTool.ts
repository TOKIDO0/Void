/**
 * L2：根据 resolve 产生的 resolutionId 下载官方安装包并校验落盘。
 * 模型不能传入任意 URL；服务端用 resolution 缓存里的官方地址。
 */

import {
  downloadSoftwareInstaller,
  getSoftwareBridgeErrorInfo
} from "../../software/softwareBridgeClient";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type SoftwareDownloadInstallerInput = {
  resolutionId: string;
  taskId?: string;
  destinationDirectory?: string;
  overwritePolicy?: "refuse" | "rename";
};

export type SoftwareDownloadInstallerOutput = {
  softwareId: string;
  finalPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  sourcePageUrl: string;
  finalDownloadUrl: string;
  signatureStatus: string;
  publisher?: string;
  downloadedAt: number;
};

export const softwareDownloadInstallerTool: ToolDefinition<
  SoftwareDownloadInstallerInput,
  SoftwareDownloadInstallerOutput
> = {
  name: "software.downloadInstaller",
  description:
    "下载已解析的官方软件安装包（通用能力，不是某一站专线）。必须先 software.resolveInstaller 拿到 resolutionId，再在本工具传入该 id；禁止自行拼装第三方下载 URL。服务端会做 HTTPS/域名白名单/魔数/SHA-256/Authenticode 校验后落入白名单目录。需用户确认。成功后可用 desktop.revealPath 展示位置。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["resolutionId"],
    properties: {
      resolutionId: {
        type: "string",
        minLength: 8,
        maxLength: 120,
        description: "software.resolveInstaller 返回的 resolutionId"
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      destinationDirectory: {
        type: "string",
        minLength: 3,
        maxLength: 400,
        description: "最终目录，必须在下载白名单内；默认 D:\\\\AI\\\\void-runtime\\\\downloads"
      },
      overwritePolicy: {
        type: "string",
        enum: ["refuse", "rename"]
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "softwareId",
      "finalPath",
      "fileName",
      "bytes",
      "sha256",
      "sourcePageUrl",
      "finalDownloadUrl",
      "signatureStatus",
      "downloadedAt"
    ],
    properties: {
      softwareId: { type: "string" },
      finalPath: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      sha256: { type: "string" },
      sourcePageUrl: { type: "string" },
      finalDownloadUrl: { type: "string" },
      signatureStatus: { type: "string" },
      publisher: { type: "string" },
      downloadedAt: { type: "number" }
    }
  },
  requiredResources: [
    {
      kind: "file",
      key: "software-download-pipeline",
      mode: "exclusive"
    },
    {
      kind: "network",
      key: "software-official-download",
      mode: "shared"
    }
  ],
  permissions: ["tool.software.downloadInstaller"],
  timeoutMs: 10 * 60_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token", "authorization"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const resolutionId = input.resolutionId.trim();
    if (!resolutionId) {
      throw createToolError("SCHEMA_INVALID", "resolutionId 不能为空。", {}, false);
    }

    try {
      const data = await downloadSoftwareInstaller(
        {
          taskId: input.taskId?.trim() || context.taskId,
          resolutionId,
          destinationDirectory: input.destinationDirectory?.trim(),
          overwritePolicy: input.overwritePolicy === "refuse" ? "refuse" : "rename"
        },
        context.signal
      );
      return {
        softwareId: data.softwareId,
        finalPath: data.finalPath,
        fileName: data.fileName,
        bytes: data.bytes,
        sha256: data.sha256,
        sourcePageUrl: data.sourcePageUrl,
        finalDownloadUrl: data.finalDownloadUrl,
        signatureStatus: data.signatureStatus,
        publisher: data.publisher,
        downloadedAt: data.downloadedAt
      };
    } catch (error) {
      const info = getSoftwareBridgeErrorInfo(error);
      const failureCode =
        typeof info.details?.failureCode === "string" ? info.details.failureCode : undefined;
      if (info.code === "BRIDGE_UNREACHABLE") {
        throw createToolError(
          "EXECUTION_FAILED",
          info.message,
          { ...info.details, bridgeUnreachable: true, failureCode },
          true
        );
      }
      if (info.code === "PATH_NOT_ALLOWED" || info.code === "OVERWRITE_REFUSED") {
        throw createToolError("PERMISSION_DENIED", info.message, info.details, false);
      }
      if (info.code === "TIMEOUT") {
        throw createToolError("TIMEOUT", info.message, info.details, true);
      }
      throw createToolError("EXECUTION_FAILED", info.message, { ...info.details, failureCode }, false);
    }
  }
};
