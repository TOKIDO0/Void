/**
 * 文件下载 / 落盘 / 校验 的 sidecar 契约。
 */

export type OverwritePolicy = "refuse" | "overwrite" | "rename";

export type FileDownloadToTempRequest = {
  taskId: string;
  url: string;
  /** 可选建议文件名；缺省从 URL / Content-Disposition 推断 */
  suggestedFileName?: string;
};

export type FileDownloadToTempData = {
  taskId: string;
  url: string;
  tempPath: string;
  fileName: string;
  bytes: number;
  contentType?: string;
  /** 结合 Content-Type + 扩展名的媒体类别（如安装包=binary、压缩包=archive） */
  mediaKind?: FileVerifyData["mediaKind"];
  downloadedAt: number;
};

export type FilePlaceDownloadRequest = {
  taskId: string;
  tempPath: string;
  /** 最终目录（必须在白名单内） */
  destinationDirectory: string;
  /** 可选最终文件名；缺省沿用临时文件名 */
  fileName?: string;
  overwritePolicy: OverwritePolicy;
};

export type FilePlaceDownloadData = {
  taskId: string;
  tempPath: string;
  finalPath: string;
  fileName: string;
  bytes: number;
  overwritePolicy: OverwritePolicy;
  renamed: boolean;
  movedAt: number;
};

export type FileVerifyRequest = {
  path: string;
};

export type FileVerifyData = {
  path: string;
  exists: boolean;
  bytes?: number;
  fileName?: string;
  extension?: string;
  mediaKind: "image" | "audio" | "video" | "document" | "archive" | "text" | "binary" | "unknown";
  contentTypeGuess?: string;
  verifiedAt: number;
};

export type FileApiSuccess<T> = { ok: true; data: T };
export type FileApiFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
export type FileApiResponse<T> = FileApiSuccess<T> | FileApiFailure;
