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

export type FileDownloadMediaPageData = {
  taskId: string;
  pageUrl: string;
  site: "bilibili";
  videoId?: string;
  tempPath: string;
  fileName: string;
  bytes: number;
  mediaKind?: FileVerifyData["mediaKind"];
  downloader: "yt-dlp";
  downloadedAt: number;
};

export type FilePlaceDownloadData = {
  taskId: string;
  tempPath: string;
  finalPath: string;
  fileName: string;
  bytes: number;
  /** 落盘后按文件名推断的媒体类别（通用） */
  mediaKind?: FileVerifyData["mediaKind"];
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

export type FileListDirectoryData = {
  path: string;
  entries: Array<{
    name: string;
    kind: "file" | "directory";
    bytes?: number;
    modifiedAt: number;
  }>;
  count: number;
  truncated: boolean;
};

export type FileInspectPathData = {
  status: "ok";
  path: string;
  fileName: string;
  parentPath: string;
  exists: boolean;
  kind: "file" | "directory" | "missing" | "symlink" | "other";
  isSymbolicLink: boolean;
  bytes?: number;
  extension?: string;
  mediaKind: FileVerifyData["mediaKind"];
  modifiedAt?: number;
  readTextLikelySupported: boolean;
  readTextByteLimit?: number;
  readTextSizeAllowed?: boolean;
  sensitiveHint: boolean;
  safetyNotes: string[];
  inspectedAt: number;
};

export type FileListRecentArtifactsData = {
  rootPath: string;
  entries: Array<{
    path: string;
    fileName: string;
    kind: "file" | "directory";
    bytes?: number;
    extension?: string;
    mediaKind: FileVerifyData["mediaKind"];
    modifiedAt: number;
  }>;
  count: number;
  limit: number;
  truncated: boolean;
  listedAt: number;
};

export type FileReadTextData = {
  path: string;
  fileName: string;
  content: string;
  bytes: number;
  characters: number;
  truncated: boolean;
  sourceKind?: "text" | "pdf" | "docx" | "excel";
};

export type FileSearchTextRequest = {
  path: string;
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  maxDepth?: number;
  extensions?: string[];
};

export type FileFindByNameRequest = {
  path: string;
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
  maxDepth?: number;
  kind?: "any" | "file" | "directory";
};

export type FileSearchTextMatch = {
  path: string;
  fileName: string;
  lineNumber: number;
  column: number;
  preview: string;
};

export type FileFindByNameMatch = {
  path: string;
  fileName: string;
  kind: "file" | "directory";
  bytes?: number;
  extension?: string;
  mediaKind: FileVerifyData["mediaKind"];
  modifiedAt: number;
};

export type FileSearchTextData = {
  path: string;
  query: string;
  caseSensitive: boolean;
  matches: FileSearchTextMatch[];
  matchCount: number;
  filesScanned: number;
  filesMatched: number;
  directoriesScanned: number;
  truncated: boolean;
  skipped: {
    directories: number;
    files: number;
    binaryOrInvalidUtf8: number;
    tooLarge: number;
    unsupportedExtension: number;
    hiddenSensitive: number;
    symbolicLinks: number;
  };
  searchedAt: number;
};

export type FileFindByNameData = {
  path: string;
  query: string;
  caseSensitive: boolean;
  kindFilter: "any" | "file" | "directory";
  matches: FileFindByNameMatch[];
  matchCount: number;
  entriesScanned: number;
  directoriesScanned: number;
  truncated: boolean;
  skipped: {
    directories: number;
    files: number;
    symbolicLinks: number;
    notAllowed: number;
  };
  searchedAt: number;
};

export type MoveConflictPolicy = "refuse" | "rename";

export type FileCreateDirectoryData = {
  path: string;
  created: boolean;
  createdAt: number;
};

export type FileMoveData = {
  sourcePath: string;
  destinationPath: string;
  mediaKind: FileVerifyData["mediaKind"];
  bytes: number;
  conflictPolicy: MoveConflictPolicy;
  renamedForConflict: boolean;
  movedAt: number;
};

export type TextWriteConflictPolicy = "refuse" | "overwrite" | "rename";

export type FileInspectWriteTargetData = {
  status: "ok";
  path: string;
  fileName: string;
  parentPath: string;
  extension: string;
  conflictPolicy: TextWriteConflictPolicy;
  targetExists: boolean;
  targetKind: "file" | "directory" | "other" | "missing";
  targetBytes?: number;
  resolvedPath: string;
  resolvedFileName: string;
  wouldCreate: boolean;
  wouldOverwrite: boolean;
  wouldRename: boolean;
  writable: boolean;
  blockingCode?: "DESTINATION_EXISTS" | "INVALID_REQUEST";
  blockingReason?: string;
  requiresConfirmation: boolean;
  inspectedAt: number;
};

export type FileWriteTextData = {
  path: string;
  fileName: string;
  bytes: number;
  characters: number;
  conflictPolicy: TextWriteConflictPolicy;
  created: boolean;
  overwritten: boolean;
  renamedForConflict: boolean;
  writtenAt: number;
};

export type FileOrganizeDirectoryData = {
  path: string;
  strategy: "byExtension";
  dryRun: boolean;
  totalFiles: number;
  movedCount: number;
  skippedCount: number;
  categories: Array<{ category: string; count: number; targetDir: string }>;
  moves: Array<{ from: string; to: string; category: string }>;
  skipped: Array<{ path: string; reason: string }>;
  organizedAt: number;
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
