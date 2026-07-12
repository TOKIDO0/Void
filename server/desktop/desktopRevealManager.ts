/**
 * 在系统资源管理器中安全展示允许根内的路径。
 * Windows 仅调用固定 explorer.exe；绝不执行目标文件，禁止 shell=true。
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { platform } from "node:os";
import { assertAllowedFilePath } from "../file/filePathPolicy";
import type { DesktopRevealPathData, DesktopRevealOpenMode } from "./desktopTypes";

function createDesktopError(
  code:
    | "INVALID_REQUEST"
    | "UNSUPPORTED_PLATFORM"
    | "PATH_NOT_ALLOWED"
    | "PATH_NOT_FOUND"
    | "REVEAL_FAILED"
    | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    desktopCode: string;
    details?: Record<string, unknown>;
  };
  error.desktopCode = code;
  error.details = details;
  return error;
}

function mapFilePolicyError(error: unknown): never {
  if (
    typeof error === "object"
    && error !== null
    && "fileCode" in error
    && typeof (error as { fileCode?: unknown }).fileCode === "string"
  ) {
    const coded = error as Error & {
      fileCode: string;
      details?: Record<string, unknown>;
    };
    if (coded.fileCode === "PATH_NOT_ALLOWED") {
      throw createDesktopError("PATH_NOT_ALLOWED", coded.message, coded.details);
    }
    if (coded.fileCode === "FILE_NOT_FOUND") {
      throw createDesktopError("PATH_NOT_FOUND", coded.message, coded.details);
    }
    if (coded.fileCode === "INVALID_REQUEST") {
      throw createDesktopError("INVALID_REQUEST", coded.message, coded.details);
    }
  }
  throw createDesktopError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "路径策略校验失败"
  );
}

function launchExplorer(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // 固定可执行名 + 结构化参数；不走 shell，避免把目标当命令执行
    const child = spawn("explorer.exe", args, {
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    child.on("error", (error) => {
      reject(
        createDesktopError(
          "REVEAL_FAILED",
          error instanceof Error ? error.message : "无法启动资源管理器"
        )
      );
    });
    // explorer 会立刻脱离；不把其退出码当失败依据
    resolve();
  });
}

export class DesktopRevealManager {
  async revealPath(pathValue: string): Promise<DesktopRevealPathData> {
    if (platform() !== "win32") {
      throw createDesktopError(
        "UNSUPPORTED_PLATFORM",
        `desktop.revealPath 当前仅支持 Windows，当前平台：${platform()}`
      );
    }

    let revealedPath: string;
    try {
      revealedPath = assertAllowedFilePath(pathValue);
    } catch (error) {
      mapFilePolicyError(error);
    }

    let openMode: DesktopRevealOpenMode;
    try {
      const stat = statSync(revealedPath);
      openMode = stat.isDirectory() ? "open" : "select";
    } catch (error) {
      throw createDesktopError(
        "PATH_NOT_FOUND",
        error instanceof Error ? error.message : `路径不存在：${revealedPath}`
      );
    }

    try {
      if (openMode === "open") {
        await launchExplorer([revealedPath]);
      } else {
        // /select,<path> 为 explorer 选中文件的固定参数形态
        await launchExplorer([`/select,${revealedPath}`]);
      }
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "desktopCode" in error
      ) {
        throw error;
      }
      throw createDesktopError(
        "REVEAL_FAILED",
        error instanceof Error ? error.message : "资源管理器展示失败"
      );
    }

    return {
      revealedPath,
      openMode,
      revealedAt: Date.now()
    };
  }
}

export const desktopRevealManager = new DesktopRevealManager();
