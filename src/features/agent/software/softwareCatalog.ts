/**
 * 官方软件目录（开放集合）。
 *
 * 新增软件 = 追加一条目录 + 对应 adapter，禁止为单个软件改路由/主工作流。
 * 首批条目仅作验收种子，不代表产品只服务这些软件。
 */

import type { SoftwareCatalogEntry } from "./softwareTypes";

/**
 * 官方域名与发布者字段在适配器实装阶段须用真实安装包核验后再收紧；
 * 此处只放稳定、可复查的官方页线索，禁止填第三方下载站。
 */
export const SOFTWARE_CATALOG: readonly SoftwareCatalogEntry[] = [
  {
    softwareId: "douyu",
    displayName: "斗鱼直播",
    aliases: ["斗鱼", "斗鱼直播", "douyu", "douyu live", "斗鱼客户端", "斗鱼直播客户端"],
    category: "game_client",
    supportedPlatforms: ["windows"],
    officialPageUrls: ["https://www.douyu.com/client"],
    officialPageDomains: ["douyu.com", "www.douyu.com"],
    allowedDownloadDomains: ["douyu.com", "www.douyu.com"],
    expectedPublisherNames: [],
    adapterId: "douyu",
    maxDownloadBytes: 800 * 1024 * 1024,
    // 服务端已有官方页解析适配器；页面结构变化时会返回 DOWNLOAD_TRIGGER_NOT_FOUND
    readiness: "adapter_ready"
  },
  {
    softwareId: "bilibili",
    displayName: "哔哩哔哩",
    aliases: [
      "哔哩哔哩",
      "B站",
      "B 站",
      "bilibili",
      "b站客户端",
      "B站客户端",
      "哔哩哔哩客户端",
      "B站电脑版",
      "哔哩哔哩电脑版"
    ],
    category: "app",
    supportedPlatforms: ["windows"],
    officialPageUrls: ["https://app.bilibili.com/"],
    officialPageDomains: ["bilibili.com", "www.bilibili.com", "app.bilibili.com"],
    allowedDownloadDomains: ["bilibili.com", "www.bilibili.com", "app.bilibili.com", "dl.hdslb.com"],
    expectedPublisherNames: [],
    adapterId: "bilibili",
    maxDownloadBytes: 800 * 1024 * 1024,
    readiness: "adapter_ready"
  }
] as const;

export function listSoftwareCatalog(): SoftwareCatalogEntry[] {
  return SOFTWARE_CATALOG.map((entry) => ({ ...entry, aliases: [...entry.aliases] }));
}

export function getSoftwareById(softwareId: string): SoftwareCatalogEntry | null {
  const normalized = softwareId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return SOFTWARE_CATALOG.find((entry) => entry.softwareId === normalized) ?? null;
}
