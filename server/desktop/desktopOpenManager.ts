import { lstatSync, statSync } from "node:fs";
import { extname } from "node:path";
import { platform } from "node:os";
import { assertAllowedFilePath } from "../file/filePathPolicy";
import { launchWindowsExplorer } from "./explorerLauncher";
import type { DesktopRevealPathData } from "./desktopTypes";

const ALLOWED_OPEN_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".json", ".log",
  ".pdf",
  ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp",
  ".xlsx", ".pptx", ".docx"
]);

const MAX_OPEN_BYTES = 12 * 1024 * 1024;

function createDesktopError(
  code: "INVALID_REQUEST" | "UNSUPPORTED_PLATFORM" | "PATH_NOT_ALLOWED" | "PATH_NOT_FOUND" | "REVEAL_FAILED" | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & { desktopCode: string; details?: Record<string, unknown> };
  error.desktopCode = code;
  error.details = details;
  return error;
}

function mapFilePolicyError(error: unknown): never {
  if (typeof error === "object" && error !== null && "fileCode" in error && typeof (error as { fileCode?: unknown }).fileCode === "string") {
    const coded = error as Error & { fileCode: string; details?: Record<string, unknown> };
    if (coded.fileCode === "PATH_NOT_ALLOWED") throw createDesktopError("PATH_NOT_ALLOWED", coded.message, coded.details);
    if (coded.fileCode === "FILE_NOT_FOUND") throw createDesktopError("PATH_NOT_FOUND", coded.message, coded.details);
    if (coded.fileCode === "INVALID_REQUEST") throw createDesktopError("INVALID_REQUEST", coded.message, coded.details);
  }
  throw createDesktopError("INTERNAL_ERROR", error instanceof Error ? error.message : "路径策略校验失败");
}

export class DesktopOpenManager {
  async openFile(pathValue: string): Promise<DesktopRevealPathData & { openedPath: string }> {
    if (platform() !== "win32") {
      throw createDesktopError("UNSUPPORTED_PLATFORM", `desktop.openFile 当前仅支持 Windows，当前平台：${platform()}`);
    }
    let allowedPath: string;
    try {
      allowedPath = assertAllowedFilePath(pathValue);
    } catch (error) {
      mapFilePolicyError(error);
    }

    // 拒绝符号链接 / junction 逃逸
    try {
      const lstat = lstatSync(allowedPath!);
      if (lstat.isSymbolicLink()) {
        throw createDesktopError("PATH_NOT_ALLOWED", "不允许打开符号链接路径");
      }
    } catch (error) {
      if (error && typeof error === "object" && "desktopCode" in error) throw error;
      throw createDesktopError("PATH_NOT_FOUND", error instanceof Error ? error.message : `路径不存在：${allowedPath!}`);
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(allowedPath!);
    } catch (error) {
      throw createDesktopError("PATH_NOT_FOUND", error instanceof Error ? error.message : `路径不存在：${allowedPath!}`);
    }

    if (!stat.isFile()) {
      throw createDesktopError("INVALID_REQUEST", "仅支持打开文件，目录请用 revealPath");
    }

    const ext = extname(allowedPath!).toLowerCase();
    if (!ALLOWED_OPEN_EXTENSIONS.has(ext)) {
      throw createDesktopError("INVALID_REQUEST", `不允许用关联应用打开该类型文件：${ext || "(无扩展名)"}。允许：${Array.from(ALLOWED_OPEN_EXTENSIONS).join(", ")}`, { extension: ext });
    }

    if (stat.size > MAX_OPEN_BYTES) {
      throw createDesktopError("INVALID_REQUEST", `文件过大（${Math.round(stat.size / 1024 / 1024)}MB），超过 ${Math.round(MAX_OPEN_BYTES / 1024 / 1024)}MB 限制`, { bytes: stat.size });
    }

    try {
      // explorer 打开文件会委派到关联应用，等效受限 open，非受控 exec
      await launchWindowsExplorer([allowedPath!]);
    } catch (error) {
      if (error && typeof error === "object" && "desktopCode" in error) throw error;
      throw createDesktopError("REVEAL_FAILED", error instanceof Error ? error.message : "打开文件失败");
    }

    return { openedPath: allowedPath!, revealedPath: allowedPath!, openMode: "open", revealedAt: Date.now() };
  }
}

export const desktopOpenManager = new DesktopOpenManager();
