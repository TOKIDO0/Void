/**
 * 官方软件安装包自动化领域（多功能助手的可扩展能力之一）。
 * 对外只导出类型、目录与意图匹配；下载工作流在阶段 D 再暴露。
 */

export type {
  SoftwareArchitecture,
  SoftwareCatalogEntry,
  SoftwareCategory,
  SoftwareFailureCode,
  SoftwareMatchResult,
  SoftwarePlatform,
  SoftwareReadiness
} from "./softwareTypes";

export {
  SOFTWARE_CATALOG,
  getSoftwareById,
  listSoftwareCatalog
} from "./softwareCatalog";

export {
  extractSoftwareQuery,
  matchSoftwareCatalog
} from "./softwareMatch";

export { isSoftwareInstallerIntent } from "./softwareDownloadIntent";

export {
  downloadSoftwareInstaller,
  getSoftwareBridgeErrorInfo,
  listSoftwareFromBridge,
  resolveSoftwareInstaller
} from "./softwareBridgeClient";
export type {
  SoftwareDownloadData,
  SoftwareResolveData
} from "./softwareBridgeClient";
