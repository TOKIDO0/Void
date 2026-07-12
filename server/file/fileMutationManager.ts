import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, parse } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError } from "./fileRuntimePaths";
import { guessMediaKind } from "./fileDownloadManager";
import type {
  FileCreateDirectoryData,
  FileMoveData,
  MoveConflictPolicy
} from "./fileTypes";

function sameVolume(sourcePath: string, destinationPath: string): boolean {
  const sourceRoot = parse(sourcePath).root;
  const destinationRoot = parse(destinationPath).root;
  return process.platform === "win32"
    ? sourceRoot.toLowerCase() === destinationRoot.toLowerCase()
    : sourceRoot === destinationRoot;
}

function resolveRenameConflict(destinationPath: string): string {
  const extension = extname(destinationPath);
  const stem = basename(destinationPath, extension);
  const parent = dirname(destinationPath);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = assertAllowedFilePath(
      join(parent, `${stem} (${index})${extension}`),
      { mustExist: false }
    );
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  throw createFileError("MOVE_FAILED", "无法生成不冲突的目标名称");
}

export class FileMutationManager {
  createDirectory(pathValue: string): FileCreateDirectoryData {
    const path = assertAllowedFilePath(pathValue, { mustExist: false });
    if (existsSync(path)) {
      throw createFileError("DESTINATION_EXISTS", `目标目录已存在：${path}`);
    }
    const parentPath = assertAllowedFilePath(dirname(path));
    if (!statSync(parentPath).isDirectory()) {
      throw createFileError("INVALID_REQUEST", `父路径不是目录：${parentPath}`);
    }
    mkdirSync(path, { recursive: false });
    return { path, created: true, createdAt: Date.now() };
  }

  move(
    sourceValue: string,
    destinationValue: string,
    conflictPolicy: MoveConflictPolicy
  ): FileMoveData {
    const sourcePath = assertAllowedFilePath(sourceValue);
    let destinationPath = assertAllowedFilePath(destinationValue, { mustExist: false });
    const destinationParent = assertAllowedFilePath(dirname(destinationPath));
    if (!statSync(destinationParent).isDirectory()) {
      throw createFileError("INVALID_REQUEST", `目标父路径不是目录：${destinationParent}`);
    }
    if (!sameVolume(sourcePath, destinationPath)) {
      throw createFileError(
        "CROSS_DEVICE_MOVE",
        `不支持跨盘移动：${sourcePath} → ${destinationPath}`
      );
    }

    let renamedForConflict = false;
    if (existsSync(destinationPath)) {
      if (conflictPolicy === "refuse") {
        throw createFileError("DESTINATION_EXISTS", `目标已存在：${destinationPath}`);
      }
      destinationPath = resolveRenameConflict(destinationPath);
      renamedForConflict = true;
    }

    const sourceStat = statSync(sourcePath);
    try {
      renameSync(sourcePath, destinationPath);
    } catch (error) {
      throw createFileError(
        "MOVE_FAILED",
        error instanceof Error ? error.message : "移动失败",
        { sourcePath, destinationPath }
      );
    }

    return {
      sourcePath,
      destinationPath,
      mediaKind: sourceStat.isFile() ? guessMediaKind(destinationPath) : "unknown",
      bytes: sourceStat.isFile() ? sourceStat.size : 0,
      conflictPolicy,
      renamedForConflict,
      movedAt: Date.now()
    };
  }
}

export const fileMutationManager = new FileMutationManager();
