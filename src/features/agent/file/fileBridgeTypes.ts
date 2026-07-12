/**
 * 文件工具与 sidecar 之间的共享类型（前端侧镜像）。
 */

export type OverwritePolicy = "refuse" | "overwrite" | "rename";

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

export type FileBridgeResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };
