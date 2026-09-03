import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, parse } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError } from "./fileRuntimePaths";
import { guessMediaKind } from "./fileDownloadManager";
import type {
  FileCreateDirectoryData,
  FileEditTextData,
  FileInspectWriteTargetData,
  FileMoveData,
  FileWriteTextData,
  MoveConflictPolicy
} from "./fileTypes";
import type { TextWriteConflictPolicy } from "./fileTypes";

const MAX_TEXT_WRITE_CHARACTERS = 200_000;
const MAX_TEXT_WRITE_BYTES = 512 * 1024;
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".log",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".sql",
  ".xml",
  ".svg",
  ".yaml",
  ".yml"
]);

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

function assertTextLikePath(pathValue: string): void {
  const extension = extname(pathValue).toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(extension)) {
    throw createFileError(
      "INVALID_REQUEST",
      `文本写入只支持常见文本扩展名：${Array.from(TEXT_FILE_EXTENSIONS).join(", ")}`
    );
  }
}

function assertTextWriteContent(content: string): Buffer {
  if (content.length > MAX_TEXT_WRITE_CHARACTERS) {
    throw createFileError(
      "FILE_TOO_LARGE",
      `文本内容不能超过 ${MAX_TEXT_WRITE_CHARACTERS} 字符`
    );
  }
  if (content.includes("\0")) {
    throw createFileError("BINARY_FILE", "文本写入拒绝包含 NUL 字符的内容");
  }
  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > MAX_TEXT_WRITE_BYTES) {
    throw createFileError(
      "FILE_TOO_LARGE",
      `文本内容不能超过 ${MAX_TEXT_WRITE_BYTES} bytes`
    );
  }
  return buffer;
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

  writeText(
    pathValue: string,
    content: string,
    conflictPolicy: TextWriteConflictPolicy
  ): FileWriteTextData {
    let destinationPath = assertAllowedFilePath(pathValue, { mustExist: false });
    assertTextLikePath(destinationPath);

    const destinationParent = assertAllowedFilePath(dirname(destinationPath));
    if (!statSync(destinationParent).isDirectory()) {
      throw createFileError("INVALID_REQUEST", `目标父路径不是目录：${destinationParent}`);
    }

    const buffer = assertTextWriteContent(content);
    let created = true;
    let overwritten = false;
    let renamedForConflict = false;

    if (existsSync(destinationPath)) {
      const existingStat = statSync(destinationPath);
      if (!existingStat.isFile()) {
        throw createFileError("INVALID_REQUEST", `目标路径不是文件：${destinationPath}`);
      }
      if (conflictPolicy === "refuse") {
        throw createFileError("DESTINATION_EXISTS", `目标文件已存在：${destinationPath}`);
      }
      if (conflictPolicy === "rename") {
        destinationPath = resolveRenameConflict(destinationPath);
        renamedForConflict = true;
      } else {
        created = false;
        overwritten = true;
      }
    }

    try {
      writeFileSync(destinationPath, buffer, { flag: overwritten ? "w" : "wx" });
    } catch (error) {
      throw createFileError(
        "WRITE_FAILED",
        error instanceof Error ? error.message : "文本写入失败",
        { destinationPath }
      );
    }

    return {
      path: destinationPath,
      fileName: basename(destinationPath),
      bytes: buffer.byteLength,
      characters: content.length,
      conflictPolicy,
      created,
      overwritten,
      renamedForConflict,
      writtenAt: Date.now()
    };
  }

  /**
   * 行级编辑：oldText 必须在文件中恰好出现一次，否则拒绝（0 次报 EDIT_TARGET_NOT_FOUND，
   * 多次报 EDIT_AMBIGUOUS 并给出命中数）。只改一处，不做模糊匹配。
   */
  editText(pathValue: string, oldText: string, newText: string): FileEditTextData {
    const path = assertAllowedFilePath(pathValue);
    assertTextLikePath(path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw createFileError("FILE_NOT_FOUND", `文件不存在：${path}`);
    }
    if (!oldText) {
      throw createFileError("INVALID_REQUEST", "oldText 不能为空");
    }
    if (oldText.length > 20_000 || newText.length > 200_000) {
      throw createFileError("INVALID_REQUEST", "oldText 不得超过 20000 字符，newText 不得超过 200000 字符");
    }
    if (newText.includes("\0")) {
      throw createFileError("BINARY_FILE", "文本写入拒绝包含 NUL 字符的内容");
    }
    const stat = statSync(path);
    if (stat.size > MAX_TEXT_WRITE_BYTES) {
      throw createFileError("FILE_TOO_LARGE", `文件过大（${stat.size} bytes），拒绝行级编辑`);
    }
    const content = readFileSync(path, "utf8");
    if (content.includes("\0")) {
      throw createFileError("BINARY_FILE", "二进制文件拒绝行级编辑");
    }
    const hits = content.split(oldText).length - 1;
    if (hits === 0) {
      throw createFileError("EDIT_TARGET_NOT_FOUND", "oldText 在文件中没有命中，请先 readText 确认原文");
    }
    if (hits > 1) {
      throw createFileError("EDIT_AMBIGUOUS", `oldText 命中 ${hits} 处，请加长上下文使之唯一`, { hits });
    }
    const next = content.replace(oldText, () => newText);
    const buffer = Buffer.from(next, "utf8");
    if (buffer.byteLength > MAX_TEXT_WRITE_BYTES) {
      throw createFileError("FILE_TOO_LARGE", "编辑后内容超过 512KB 上限");
    }
    try {
      writeFileSync(path, buffer);
    } catch (error) {
      throw createFileError("WRITE_FAILED", error instanceof Error ? error.message : "文本写入失败", { destinationPath: path });
    }
    return {
      path,
      fileName: basename(path),
      bytes: buffer.byteLength,
      characters: next.length,
      replacements: 1,
      editedAt: Date.now()
    };
  }

  inspectTextWriteTarget(
    pathValue: string,
    conflictPolicy: TextWriteConflictPolicy
  ): FileInspectWriteTargetData {
    const destinationPath = assertAllowedFilePath(pathValue, { mustExist: false });
    assertTextLikePath(destinationPath);

    const destinationParent = assertAllowedFilePath(dirname(destinationPath));
    if (!statSync(destinationParent).isDirectory()) {
      throw createFileError("INVALID_REQUEST", `目标父路径不是目录：${destinationParent}`);
    }

    const extension = extname(destinationPath).toLowerCase();
    const targetExists = existsSync(destinationPath);
    let targetKind: FileInspectWriteTargetData["targetKind"] = "missing";
    let targetBytes: number | undefined;
    let resolvedPath = destinationPath;
    let wouldCreate = true;
    let wouldOverwrite = false;
    let wouldRename = false;
    let writable = true;
    let blockingCode: FileInspectWriteTargetData["blockingCode"];
    let blockingReason: string | undefined;

    if (targetExists) {
      const targetStat = statSync(destinationPath);
      if (targetStat.isFile()) {
        targetKind = "file";
        targetBytes = targetStat.size;
        if (conflictPolicy === "refuse") {
          writable = false;
          blockingCode = "DESTINATION_EXISTS";
          blockingReason = `目标文件已存在：${destinationPath}`;
        } else if (conflictPolicy === "rename") {
          resolvedPath = resolveRenameConflict(destinationPath);
          wouldRename = true;
        } else {
          wouldCreate = false;
          wouldOverwrite = true;
        }
      } else if (targetStat.isDirectory()) {
        targetKind = "directory";
        writable = false;
        blockingCode = "INVALID_REQUEST";
        blockingReason = `目标路径是目录，不是文件：${destinationPath}`;
      } else {
        targetKind = "other";
        writable = false;
        blockingCode = "INVALID_REQUEST";
        blockingReason = `目标路径不是普通文件：${destinationPath}`;
      }
    }

    return {
      status: "ok",
      path: destinationPath,
      fileName: basename(destinationPath),
      parentPath: destinationParent,
      extension,
      conflictPolicy,
      targetExists,
      targetKind,
      targetBytes,
      resolvedPath,
      resolvedFileName: basename(resolvedPath),
      wouldCreate,
      wouldOverwrite,
      wouldRename,
      writable,
      blockingCode,
      blockingReason,
      requiresConfirmation: true,
      inspectedAt: Date.now()
    };
  }
}

export const fileMutationManager = new FileMutationManager();
