/**
 * 官方安装包来源解析：按 softwareId 调用适配器，不走搜索引擎。
 */

import { getSoftwareById, type SoftwareCatalogEntry } from "./softwareCatalog";
import { fetchWithDomainGuard } from "./softwareSecureDownload";
import { createFileError } from "../file/fileRuntimePaths";

export type InstallerCandidate = {
  softwareId: string;
  displayName: string;
  platform: "windows";
  architecture: string;
  sourcePageUrl: string;
  downloadUrl: string;
  fileName?: string;
  versionHint?: string;
  adapterId: string;
};

type SoftwareAdapter = {
  adapterId: string;
  resolve: (entry: SoftwareCatalogEntry, architecture: string) => Promise<InstallerCandidate>;
};

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function extractHttpUrls(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /href\s*=\s*"([^"]+)"/gi,
    /href\s*=\s*'([^']+)'/gi,
    /https?:\/\/[^\s"'<>]+/gi
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const raw = match[1] || match[0];
      if (!raw) continue;
      try {
        const absolute = new URL(raw, baseUrl).toString();
        if (absolute.startsWith("http")) {
          found.add(absolute.split("#")[0]);
        }
      } catch {
        // ignore bad url
      }
    }
  }
  return [...found];
}

function scoreInstallerUrl(urlText: string, architecture: string): number {
  const lower = urlText.toLowerCase();
  let score = 0;
  if (/\.exe(?:$|\?)/i.test(lower)) score += 50;
  if (/\.msi(?:$|\?)/i.test(lower)) score += 45;
  if (/\.zip(?:$|\?)/i.test(lower)) score += 20;
  if (/setup|installer|client|pc|desktop|windows|win/i.test(lower)) score += 15;
  if (architecture === "x64" && /x64|win64|64bit|amd64/i.test(lower)) score += 10;
  if (architecture === "x86" && /x86|win32|32bit/i.test(lower)) score += 10;
  if (/android|ios|mac|dmg|apk|google|play/i.test(lower)) score -= 40;
  return score;
}

async function resolveFromOfficialPages(
  entry: SoftwareCatalogEntry,
  architecture: string
): Promise<InstallerCandidate> {
  const pageUrls = entry.officialPageUrls.length
    ? entry.officialPageUrls
    : entry.officialPageDomains.map((domain) => `https://${domain}/`);

  const candidates: Array<{ url: string; sourcePageUrl: string; score: number }> = [];

  for (const pageUrl of pageUrls) {
    let html = "";
    try {
      const { response, finalUrl } = await fetchWithDomainGuard(
        pageUrl,
        [...entry.officialPageDomains, ...entry.allowedDownloadDomains],
        { method: "GET" }
      );
      if (!response.ok) {
        continue;
      }
      html = await response.text();
      const urls = extractHttpUrls(html, finalUrl);
      for (const url of urls) {
        const score = scoreInstallerUrl(url, architecture);
        if (score < 20) continue;
        // 链接主机必须在下载白名单或页面域名
        try {
          const host = new URL(url).hostname.toLowerCase();
          const allowed = [...entry.allowedDownloadDomains, ...entry.officialPageDomains];
          const ok = allowed.some(
            (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`)
          );
          if (!ok) continue;
          candidates.push({ url, sourcePageUrl: finalUrl, score });
        } catch {
          // ignore
        }
      }
    } catch {
      // 尝试下一页
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `未能在 ${entry.displayName} 官方页面解析到安装包下载链接（页面结构可能已变）`,
      { failureCode: "DOWNLOAD_TRIGGER_NOT_FOUND", softwareId: entry.softwareId }
    );
  }

  let fileName: string | undefined;
  try {
    fileName = decodeURIComponent(basenameSafe(new URL(best.url).pathname));
  } catch {
    fileName = undefined;
  }

  return {
    softwareId: entry.softwareId,
    displayName: entry.displayName,
    platform: "windows",
    architecture,
    sourcePageUrl: best.sourcePageUrl,
    downloadUrl: best.url,
    fileName,
    adapterId: entry.adapterId
  };
}

function basenameSafe(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

const genericPageAdapter: SoftwareAdapter = {
  adapterId: "generic-official-page",
  resolve: resolveFromOfficialPages
};

const adaptersById: Record<string, SoftwareAdapter> = {
  douyu: {
    adapterId: "douyu",
    async resolve(entry, architecture) {
      return resolveFromOfficialPages(entry, architecture);
    }
  },
  bilibili: {
    adapterId: "bilibili",
    async resolve(entry, architecture) {
      return resolveFromOfficialPages(entry, architecture);
    }
  },
  "generic-official-page": genericPageAdapter
};

export async function resolveInstallerCandidate(input: {
  softwareId: string;
  architecture?: string;
}): Promise<InstallerCandidate> {
  const entry = getSoftwareById(input.softwareId);
  if (!entry) {
    throw createFileError("DOWNLOAD_FAILED", `未登记软件：${input.softwareId}`, {
      failureCode: "UNSUPPORTED_SOFTWARE"
    });
  }
  if (entry.readiness !== "adapter_ready") {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `${entry.displayName} 已登记，但自动解析适配器未就绪`,
      { failureCode: "ADAPTER_NOT_READY", softwareId: entry.softwareId }
    );
  }
  if (!entry.supportedPlatforms.includes("windows")) {
    throw createFileError("DOWNLOAD_FAILED", "当前平台不受支持", {
      failureCode: "PLATFORM_UNSUPPORTED"
    });
  }

  const architecture = input.architecture && input.architecture !== "unknown"
    ? input.architecture
    : "x64";

  const adapter = adaptersById[entry.adapterId] || genericPageAdapter;
  return adapter.resolve(entry, architecture);
}

/** 供健康检查：确认适配器表非空 */
export function listAdapterIds(): string[] {
  return Object.keys(adaptersById);
}

// 避免未使用警告（部分环境 tree-shake 不会删）
void DEFAULT_USER_AGENT;
