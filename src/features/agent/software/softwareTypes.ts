/**
 * 官方软件安装包自动化 — 通用类型。
 *
 * 产品口径：这是多功能助手的一个可扩展领域，不是某一两个软件的专线。
 * 目录项（如斗鱼/B站）仅为样例与验收种子，可随时增删。
 */

export type SoftwarePlatform = "windows";

export type SoftwareCategory =
  | "app"
  | "runtime"
  | "tool"
  | "game_client"
  | "browser"
  | "other";

/** catalogued=已登记、自动解析未就绪；adapter_ready=可走自动 resolve/download */
export type SoftwareReadiness = "catalogued" | "adapter_ready";

export type SoftwareCatalogEntry = {
  softwareId: string;
  displayName: string;
  aliases: string[];
  category: SoftwareCategory;
  supportedPlatforms: SoftwarePlatform[];
  officialPageUrls: string[];
  officialPageDomains: string[];
  allowedDownloadDomains: string[];
  expectedPublisherNames: string[];
  adapterId: string;
  maxDownloadBytes: number;
  readiness: SoftwareReadiness;
};

export type SoftwareArchitecture = "x64" | "x86" | "arm64" | "unknown";

export type SoftwareFailureCode =
  | "UNSUPPORTED_SOFTWARE"
  | "ADAPTER_NOT_READY"
  | "PLATFORM_UNSUPPORTED"
  | "ARCH_UNSUPPORTED"
  | "OFFICIAL_SOURCE_UNAVAILABLE"
  | "DOWNLOAD_TRIGGER_NOT_FOUND"
  | "DOWNLOAD_REDIRECT_NOT_ALLOWED"
  | "HTML_INSTEAD_OF_INSTALLER"
  | "FILE_TOO_LARGE"
  | "SIGNATURE_INVALID"
  | "PUBLISHER_MISMATCH"
  | "DOWNLOAD_TIMEOUT"
  | "PATH_NOT_ALLOWED"
  | "AMBIGUOUS_SOFTWARE";

export type SoftwareMatchResult =
  | {
      kind: "matched";
      entry: SoftwareCatalogEntry;
      matchedAlias: string;
    }
  | {
      kind: "ambiguous";
      candidates: SoftwareCatalogEntry[];
      query: string;
    }
  | {
      kind: "none";
      query: string;
    };
