/**
 * L0：列出已登记官方软件目录。
 * 多功能助手边界：模型与用户都能知道「当前支持哪些软件自动化」，而不是假装万能下载器。
 */

import { listSoftwareCatalog } from "../../software/softwareCatalog";
import type { SoftwareCatalogEntry } from "../../software/softwareTypes";
import type { ToolDefinition } from "../toolTypes";

export type SoftwareListSupportedInput = {
  /** 仅返回 adapter_ready 项时为 true；默认列出全部已登记项 */
  onlyReady?: boolean;
};

export type SoftwareListSupportedOutput = {
  count: number;
  softwares: Array<{
    softwareId: string;
    displayName: string;
    aliases: string[];
    category: SoftwareCatalogEntry["category"];
    readiness: SoftwareCatalogEntry["readiness"];
    officialPageUrls: string[];
  }>;
  note: string;
};

export const softwareListSupportedTool: ToolDefinition<
  SoftwareListSupportedInput,
  SoftwareListSupportedOutput
> = {
  name: "software.listSupported",
  description:
    "列出当前已登记的官方软件安装包目录（通用软件自动化能力，不是某一站专线）。返回 softwareId/显示名/别名/readiness/官网。readiness=catalogued 表示已登记但自动下载适配器尚未就绪；adapter_ready 表示可自动解析官方安装包。未知软件不会出现在列表中。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      onlyReady: {
        type: "boolean",
        description: "为 true 时只返回 adapter_ready 的软件"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["count", "softwares", "note"],
    properties: {
      count: { type: "number", minimum: 0 },
      softwares: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "softwareId",
            "displayName",
            "aliases",
            "category",
            "readiness",
            "officialPageUrls"
          ],
          properties: {
            softwareId: { type: "string" },
            displayName: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
            category: { type: "string" },
            readiness: { type: "string" },
            officialPageUrls: { type: "array", items: { type: "string" } }
          }
        }
      },
      note: { type: "string" }
    }
  },
  requiredResources: [
    {
      kind: "memory",
      key: "software-catalog",
      mode: "shared"
    }
  ],
  permissions: ["tool.software.listSupported"],
  timeoutMs: 3000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true
  },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const onlyReady = input.onlyReady === true;
    const softwares = listSoftwareCatalog()
      .filter((entry) => (onlyReady ? entry.readiness === "adapter_ready" : true))
      .map((entry) => ({
        softwareId: entry.softwareId,
        displayName: entry.displayName,
        aliases: [...entry.aliases],
        category: entry.category,
        readiness: entry.readiness,
        officialPageUrls: [...entry.officialPageUrls]
      }));

    return {
      count: softwares.length,
      softwares,
      note:
        "这是多功能助手的官方软件目录，可扩展；未登记软件不会自动从第三方站下载。"
    };
  }
};
