import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { assertAllowedFilePath } from "./filePathPolicy";
import { createFileError } from "./fileRuntimePaths";
import type { FileListDirectoryData, FileReadTextData } from "./fileTypes";

const MAX_DIRECTORY_ENTRIES = 200;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TEXT_CHARACTERS = 200_000;

export class FileAccessManager {
  listDirectory(pathValue: string): FileListDirectoryData {
    const path = assertAllowedFilePath(pathValue);
    const directoryStat = statSync(path);
    if (!directoryStat.isDirectory()) {
      throw createFileError("INVALID_REQUEST", `路径不是目录：${path}`);
    }

    const directoryEntries = readdirSync(path, { withFileTypes: true });
    const selectedEntries = directoryEntries.slice(0, MAX_DIRECTORY_ENTRIES);
    const entries = selectedEntries.map((entry) => {
      const entryPath = assertAllowedFilePath(join(path, entry.name));
      const entryStat = statSync(entryPath);
      return {
        name: entry.name,
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
        bytes: entry.isFile() ? entryStat.size : undefined,
        modifiedAt: entryStat.mtimeMs
      };
    });

    return {
      path,
      entries,
      count: entries.length,
      truncated: directoryEntries.length > MAX_DIRECTORY_ENTRIES
    };
  }

  readText(pathValue: string): FileReadTextData {
    const path = assertAllowedFilePath(pathValue);
    const fileStat = statSync(path);
    if (!fileStat.isFile()) {
      throw createFileError("INVALID_REQUEST", `路径不是文件：${path}`);
    }
    if (fileStat.size > MAX_TEXT_BYTES) {
      throw createFileError("FILE_TOO_LARGE", `文本文件超过 ${MAX_TEXT_BYTES} 字节上限`, {
        bytes: fileStat.size,
        maxBytes: MAX_TEXT_BYTES
      });
    }

    const bytes = readFileSync(path);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw createFileError("INVALID_UTF8", `文件不是合法 UTF-8 文本：${path}`);
    }
    if (content.includes("\0")) {
      throw createFileError("BINARY_FILE", `拒绝读取二进制文件：${path}`);
    }
    if (content.length > MAX_TEXT_CHARACTERS) {
      throw createFileError(
        "FILE_TOO_LARGE",
        `文本内容超过 ${MAX_TEXT_CHARACTERS} 字符上限`,
        { characters: content.length, maxCharacters: MAX_TEXT_CHARACTERS }
      );
    }

    return {
      path,
      fileName: basename(path),
      content: content.charCodeAt(0) === 0xfeff ? content.slice(1) : content,
      bytes: fileStat.size,
      characters: content.length,
      truncated: false
    };
  }
}

export const fileAccessManager = new FileAccessManager();
