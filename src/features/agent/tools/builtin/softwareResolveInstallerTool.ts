/**
 * L0：解析「用户想下哪款官方软件」并生成服务端 resolutionId。
 * 真实 URL 解析在 sidecar；前端只拿展示信息 + resolutionId。
 */

import {
  getSoftwareBridgeErrorInfo,
  resolveSoftwareInstaller
} from "../../software/softwareBridgeClient";
import { matchSoftwareCatalog } from "../../software/softwareMatch";
import type { SoftwareFailureCode } from "../../software/softwareTypes";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type SoftwareResolveInstallerInput = {
  query: string;
  platform?: "windows";
  architecture?: "x64" | "x86" | "arm64" | "unknown";
};

export type SoftwareResolveInstallerOutput = {
  softwareId: string;
  displayName: string;
  matchedAlias: string;
  readiness: string;
  platform: string;
  architecture: string;
  officialPageUrls: string[];
  allowedDownloadDomains: string[];
  resolutionId: string;
  canAutoDownload: boolean;
  sourcePageUrl?: string;
  downloadHost?: string;
  fileName?: string;
  nextStep: string;
  failureCode?: string;
};

function detectArchitecture(input?: SoftwareResolveInstallerInput["architecture"]) {
  if (input && input !== "unknown") {
    return input;
  }
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/arm64|aarch64/i.test(ua)) return "arm64";
  if (/wow64|win64|x64|amd64/i.test(ua)) return "x64";
  return "unknown";
}

export const softwareResolveInstallerTool: ToolDefinition<
  SoftwareResolveInstallerInput,
  SoftwareResolveInstallerOutput
> = {
  name: "software.resolveInstaller",
  description:
    "解析用户想下载的「官方软件安装包」（通用能力，不是斗鱼/B站专线）。匹配官方软件目录并在本机服务解析官方下载候选，返回 resolutionId。不写文件。未登记返回失败；禁止用 browser 乱点或 file.downloadMediaPage 代替处理客户端/安装包。",
  version: "1.1.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "软件名、别名或用户原句中的产品指称"
      },
      platform: {
        type: "string",
        enum: ["windows"]
      },
      architecture: {
        type: "string",
        enum: ["x64", "x86", "arm64", "unknown"]
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "softwareId",
      "displayName",
      "matchedAlias",
      "readiness",
      "platform",
      "architecture",
      "officialPageUrls",
      "allowedDownloadDomains",
      "resolutionId",
      "canAutoDownload",
      "nextStep"
    ],
    properties: {
      softwareId: { type: "string" },
      displayName: { type: "string" },
      matchedAlias: { type: "string" },
      readiness: { type: "string" },
      platform: { type: "string" },
      architecture: { type: "string" },
      officialPageUrls: { type: "array", items: { type: "string" } },
      allowedDownloadDomains: { type: "array", items: { type: "string" } },
      resolutionId: { type: "string" },
      canAutoDownload: { type: "boolean" },
      sourcePageUrl: { type: "string" },
      downloadHost: { type: "string" },
      fileName: { type: "string" },
      nextStep: { type: "string" },
      failureCode: { type: "string" }
    }
  },
  requiredResources: [
    {
      kind: "network",
      key: "software-official-resolve",
      mode: "shared"
    },
    {
      kind: "memory",
      key: "software-catalog",
      mode: "shared"
    }
  ],
  permissions: ["tool.software.resolveInstaller"],
  timeoutMs: 60_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const query = input.query.trim();
    if (!query) {
      throw createToolError("SCHEMA_INVALID", "query 不能为空。", {}, false);
    }

    // 先本地快速匹配，减少 bridge 空转
    const localMatch = matchSoftwareCatalog(query);
    if (localMatch.kind === "none") {
      throw createToolError(
        "EXECUTION_FAILED",
        `未登记软件「${query}」。可用 software.listSupported 查看目录，或提供官方直链后走通用文件下载。`,
        {
          failureCode: "UNSUPPORTED_SOFTWARE" satisfies SoftwareFailureCode,
          query
        },
        false
      );
    }
    if (localMatch.kind === "ambiguous") {
      throw createToolError(
        "EXECUTION_FAILED",
        `「${query}」匹配到多个软件：${localMatch.candidates.map((item) => item.displayName).join("、")}。请确认具体产品名。`,
        {
          failureCode: "AMBIGUOUS_SOFTWARE" satisfies SoftwareFailureCode,
          candidates: localMatch.candidates.map((item) => item.softwareId)
        },
        false
      );
    }

    try {
      const data = await resolveSoftwareInstaller(
        {
          query,
          softwareId: localMatch.entry.softwareId,
          architecture: detectArchitecture(input.architecture)
        },
        context.signal
      );
      return {
        softwareId: data.softwareId,
        displayName: data.displayName,
        matchedAlias: data.matchedAlias || localMatch.matchedAlias,
        readiness: data.readiness,
        platform: data.platform,
        architecture: data.architecture,
        officialPageUrls: data.officialPageUrls ?? [],
        allowedDownloadDomains: data.allowedDownloadDomains ?? [],
        resolutionId: data.resolutionId || "",
        canAutoDownload: data.canAutoDownload === true,
        sourcePageUrl: data.sourcePageUrl,
        downloadHost: data.downloadHost,
        fileName: data.fileName,
        nextStep: data.nextStep,
        failureCode: data.failureCode
      };
    } catch (error) {
      const info = getSoftwareBridgeErrorInfo(error);
      if (info.code === "BRIDGE_UNREACHABLE") {
        throw createToolError(
          "EXECUTION_FAILED",
          info.message,
          { bridgeUnreachable: true, ...(info.details ?? {}) },
          true
        );
      }
      throw createToolError(
        "EXECUTION_FAILED",
        info.message,
        info.details,
        false
      );
    }
  }
};
