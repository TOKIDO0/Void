/**
 * 服务端官方软件目录（安全真源）。
 * 下载与域名校验只信本文件，不信前端/模型传入的域名列表。
 * 新增软件 = 追加条目 + 适配器，不改主下载管线。
 */

export type SoftwarePlatform = "windows";
export type SoftwareReadiness = "catalogued" | "adapter_ready";

export type SoftwareCatalogEntry = {
  softwareId: string;
  displayName: string;
  aliases: string[];
  supportedPlatforms: SoftwarePlatform[];
  officialPageUrls: string[];
  officialPageDomains: string[];
  allowedDownloadDomains: string[];
  expectedPublisherNames: string[];
  adapterId: string;
  maxDownloadBytes: number;
  readiness: SoftwareReadiness;
};

export const SOFTWARE_CATALOG: readonly SoftwareCatalogEntry[] = [
  {
    softwareId: "douyu",
    displayName: "斗鱼直播",
    aliases: ["斗鱼", "斗鱼直播", "douyu", "douyu live", "斗鱼客户端", "斗鱼直播客户端"],
    supportedPlatforms: ["windows"],
    officialPageUrls: ["https://www.douyu.com/client", "https://www.douyu.com/"],
    officialPageDomains: ["douyu.com", "www.douyu.com"],
    // 下载 CDN 域名在适配器探测时再收紧；此处给常见官方相关后缀留白名单入口
    allowedDownloadDomains: [
      "douyu.com",
      "www.douyu.com",
      "douyucdn.cn",
      "www.douyucdn.cn",
      "stun.douyucdn.cn",
      "sta-op.douyucdn.cn"
    ],
    expectedPublisherNames: ["Douyu", "斗鱼", "武汉斗鱼", "DouYu", "douyu"],
    adapterId: "douyu",
    maxDownloadBytes: 800 * 1024 * 1024,
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
    supportedPlatforms: ["windows"],
    officialPageUrls: ["https://app.bilibili.com/", "https://www.bilibili.com/"],
    officialPageDomains: ["bilibili.com", "www.bilibili.com", "app.bilibili.com"],
    allowedDownloadDomains: [
      "bilibili.com",
      "www.bilibili.com",
      "app.bilibili.com",
      "dl.hdslb.com",
      "i0.hdslb.com",
      "i1.hdslb.com",
      "i2.hdslb.com",
      "s1.hdslb.com"
    ],
    expectedPublisherNames: [
      "bilibili",
      "Bilibili",
      "上海幻电",
      "哔哩哔哩",
      "幻电",
      // 上海幻电信息技术有限公司统一社会信用代码（Subject SERIALNUMBER）
      "91310000MA1G8B8AXD"
    ],
    adapterId: "bilibili",
    maxDownloadBytes: 800 * 1024 * 1024,
    readiness: "adapter_ready"
  }
] as const;

export function listSoftwareCatalog(): SoftwareCatalogEntry[] {
  return SOFTWARE_CATALOG.map((entry) => ({
    ...entry,
    aliases: [...entry.aliases],
    officialPageUrls: [...entry.officialPageUrls],
    officialPageDomains: [...entry.officialPageDomains],
    allowedDownloadDomains: [...entry.allowedDownloadDomains],
    expectedPublisherNames: [...entry.expectedPublisherNames]
  }));
}

export function getSoftwareById(softwareId: string): SoftwareCatalogEntry | null {
  const normalized = softwareId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return SOFTWARE_CATALOG.find((entry) => entry.softwareId === normalized) ?? null;
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（）()【】[\]「」"'`]/g, "");
}

export function matchSoftwareByQuery(query: string): {
  kind: "matched" | "ambiguous" | "none";
  entry?: SoftwareCatalogEntry;
  candidates?: SoftwareCatalogEntry[];
  matchedAlias?: string;
} {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return { kind: "none" };
  }

  const hits: Array<{ entry: SoftwareCatalogEntry; matchedAlias: string; score: number }> = [];
  for (const entry of SOFTWARE_CATALOG) {
    const names = [entry.displayName, entry.softwareId, ...entry.aliases];
    for (const alias of names) {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias) {
        continue;
      }
      if (
        normalizedQuery === normalizedAlias
        || normalizedQuery.includes(normalizedAlias)
        || normalizedAlias.includes(normalizedQuery)
      ) {
        hits.push({ entry, matchedAlias: alias, score: normalizedAlias.length });
        break;
      }
    }
  }

  if (!hits.length) {
    return { kind: "none" };
  }

  hits.sort((a, b) => b.score - a.score);
  const best = hits[0].score;
  const top = hits.filter((item) => item.score === best);
  const unique = new Set(top.map((item) => item.entry.softwareId));
  if (unique.size > 1) {
    return { kind: "ambiguous", candidates: top.map((item) => item.entry) };
  }
  return {
    kind: "matched",
    entry: top[0].entry,
    matchedAlias: top[0].matchedAlias
  };
}
