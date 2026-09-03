/**
 * 阶段 D 文件落盘路径策略。
 * 强制优先 D 盘 AI 运行时目录，避免写满 C 盘。
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/** 运行时根目录（可用 VOID_RUNTIME_ROOT 覆盖） */
export function resolveRuntimeRoot(): string {
  const fromEnv = process.env.VOID_RUNTIME_ROOT?.trim();
  if (fromEnv) {
    return normalize(fromEnv);
  }
  return "D:\\AI\\void-runtime";
}

export function resolveDownloadTempRoot(): string {
  const fromEnv = process.env.VOID_DOWNLOAD_TEMP_DIR?.trim();
  if (fromEnv) {
    return normalize(fromEnv);
  }
  return join(resolveRuntimeRoot(), "downloads-temp");
}

export function resolveDownloadFinalRoot(): string {
  const fromEnv = process.env.VOID_DOWNLOAD_DIR?.trim();
  if (fromEnv) {
    return normalize(fromEnv);
  }
  return join(resolveRuntimeRoot(), "downloads");
}

/**
 * 允许的最终落盘根目录白名单。
 * 默认仅 D:\\AI\\void-runtime\\downloads；可用 VOID_DOWNLOAD_ALLOW_ROOTS 以 ; 分隔追加。
 */
export function listAllowedDownloadRoots(): string[] {
  const roots = [resolveDownloadFinalRoot()];
  const extra = process.env.VOID_DOWNLOAD_ALLOW_ROOTS?.trim();
  if (extra) {
    for (const item of extra.split(";")) {
      const trimmed = item.trim();
      if (trimmed) {
        roots.push(normalize(trimmed));
      }
    }
  }
  return roots.map((root) => resolve(root));
}

export function ensureRuntimeDirectories() {
  mkdirSync(resolveDownloadTempRoot(), { recursive: true });
  mkdirSync(resolveDownloadFinalRoot(), { recursive: true });
  mkdirSync(join(resolveRuntimeRoot(), "browser-screenshots"), { recursive: true });
}

/**
 * 判断 candidate 是否落在 allowedRoot 之下（规范化后，含路径分隔符边界）。
 */
export function isPathInsideRoot(candidate: string, allowedRoot: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(allowedRoot);
  if (resolvedCandidate.toLowerCase() === resolvedRoot.toLowerCase()) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  // Windows 路径比较不区分大小写
  return resolvedCandidate.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * 若路径存在，拒绝自身为符号链接/junction；并尽量 realpath 后再做白名单判断。
 */
function resolveRealIfExists(pathText: string): string {
  const resolved = resolve(pathText);
  if (!existsSync(resolved)) {
    return resolved;
  }
  try {
    const st = lstatSync(resolved);
    if (st.isSymbolicLink()) {
      throw createFileError(
        "PATH_NOT_ALLOWED",
        `拒绝符号链接/junction 路径：${resolved}`
      );
    }
  } catch (error) {
    if (typeof error === "object" && error && "fileCode" in error) {
      throw error;
    }
  }
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 校验最终目标目录是否在白名单内（含 realpath，防 symlink 逃逸）。
 */
export function assertAllowedDestinationDirectory(directoryPath: string): string {
  if (!directoryPath || !directoryPath.trim()) {
    throw createFileError("INVALID_REQUEST", "目标目录不能为空");
  }
  if (!isAbsolute(directoryPath)) {
    throw createFileError("INVALID_REQUEST", `目标目录必须是绝对路径：${directoryPath}`);
  }

  const resolved = resolveRealIfExists(directoryPath);
  const allowed = listAllowedDownloadRoots().map((root) => {
    try {
      return existsSync(root) ? realpathSync(root) : resolve(root);
    } catch {
      return resolve(root);
    }
  });
  const ok = allowed.some((root) => isPathInsideRoot(resolved, root));
  if (!ok) {
    throw createFileError(
      "PATH_NOT_ALLOWED",
      `目标目录不在白名单内：${resolved}`,
      { allowedRoots: allowed }
    );
  }
  return resolved;
}

export function createFileError(
  code:
    | "INVALID_REQUEST"
    | "PATH_NOT_ALLOWED"
    | "DOWNLOAD_BLOCKED"
    | "DOWNLOAD_FAILED"
    | "FILE_NOT_FOUND"
    | "MOVE_FAILED"
    | "WRITE_FAILED"
    | "EDIT_TARGET_NOT_FOUND"
    | "EDIT_AMBIGUOUS"
    | "OVERWRITE_REFUSED"
    | "VERIFY_FAILED"
    | "FILE_TOO_LARGE"
    | "INVALID_UTF8"
    | "BINARY_FILE"
    | "UNSUPPORTED_DOCUMENT"
    | "DESTINATION_EXISTS"
    | "CROSS_DEVICE_MOVE"
    | "MEDIA_HOST_NOT_ALLOWED"
    | "YTDLP_NOT_FOUND"
    | "FFMPEG_NOT_FOUND"
    | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    fileCode: string;
    details?: Record<string, unknown>;
  };
  error.fileCode = code;
  error.details = details;
  return error;
}

export function getFileErrorPayload(error: unknown): {
  code:
    | "INVALID_REQUEST"
    | "PATH_NOT_ALLOWED"
    | "DOWNLOAD_BLOCKED"
    | "DOWNLOAD_FAILED"
    | "FILE_NOT_FOUND"
    | "MOVE_FAILED"
    | "WRITE_FAILED"
    | "EDIT_TARGET_NOT_FOUND"
    | "EDIT_AMBIGUOUS"
    | "OVERWRITE_REFUSED"
    | "VERIFY_FAILED"
    | "FILE_TOO_LARGE"
    | "INVALID_UTF8"
    | "BINARY_FILE"
    | "UNSUPPORTED_DOCUMENT"
    | "DESTINATION_EXISTS"
    | "CROSS_DEVICE_MOVE"
    | "MEDIA_HOST_NOT_ALLOWED"
    | "YTDLP_NOT_FOUND"
    | "FFMPEG_NOT_FOUND"
    | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "fileCode" in error
    && typeof (error as { fileCode?: unknown }).fileCode === "string"
  ) {
      const coded = error as Error & {
      fileCode:
        | "INVALID_REQUEST"
        | "PATH_NOT_ALLOWED"
        | "DOWNLOAD_BLOCKED"
        | "DOWNLOAD_FAILED"
        | "FILE_NOT_FOUND"
        | "MOVE_FAILED"
        | "WRITE_FAILED"
        | "EDIT_TARGET_NOT_FOUND"
        | "EDIT_AMBIGUOUS"
        | "OVERWRITE_REFUSED"
        | "VERIFY_FAILED"
        | "FILE_TOO_LARGE"
        | "INVALID_UTF8"
        | "BINARY_FILE"
        | "UNSUPPORTED_DOCUMENT"
        | "DESTINATION_EXISTS"
        | "CROSS_DEVICE_MOVE"
        | "MEDIA_HOST_NOT_ALLOWED"
        | "YTDLP_NOT_FOUND"
        | "FFMPEG_NOT_FOUND"
        | "INTERNAL_ERROR";
      details?: Record<string, unknown>;
    };
    return {
      code: coded.fileCode,
      message: coded.message,
      details: coded.details
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "文件操作内部错误"
  };
}
