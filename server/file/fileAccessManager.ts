import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { guessMediaKind } from "./fileDownloadManager";
import {
  extractDocumentText,
  isSupportedDocumentTextPath
} from "./documentTextExtractor";
import { assertAllowedFilePath } from "./filePathPolicy";
import {
  createFileError,
  ensureRuntimeDirectories,
  resolveDownloadFinalRoot
} from "./fileRuntimePaths";
import type {
  FileFindByNameData,
  FileFindByNameMatch,
  FileFindByNameRequest,
  FileListDirectoryData,
  FileInspectPathData,
  FileListRecentArtifactsData,
  FileReadTextData,
  FileSearchTextData,
  FileSearchTextMatch,
  FileSearchTextRequest
} from "./fileTypes";

const MAX_DIRECTORY_ENTRIES = 200;
const DEFAULT_RECENT_ARTIFACT_LIMIT = 20;
const MAX_RECENT_ARTIFACT_LIMIT = 50;
const MAX_RECENT_ARTIFACT_SCAN = 1000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARACTERS = 200_000;
const DEFAULT_SEARCH_DEPTH = 4;
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCH_FILES = 600;
const DEFAULT_SEARCH_RESULTS = 40;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_SEARCH_QUERY_CHARACTERS = 200;
const MAX_SEARCH_PREVIEW_CHARACTERS = 240;
const MAX_SEARCH_EXTENSIONS = 20;
const DEFAULT_FIND_DEPTH = 4;
const MAX_FIND_DEPTH = 6;
const DEFAULT_FIND_RESULTS = 40;
const MAX_FIND_RESULTS = 100;
const MAX_FIND_ENTRIES = 2000;
const MAX_FIND_QUERY_CHARACTERS = 160;

const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  ".astro",
  ".bat",
  ".c",
  ".cjs",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".go",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".log",
  ".markdown",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);
const SEARCHABLE_EXTENSIONLESS_NAMES = new Set([
  "changelog",
  "dockerfile",
  "license",
  "makefile",
  "readme"
]);
const SEARCH_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);
const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa"
]);
const SENSITIVE_FILE_EXTENSIONS = new Set([
  ".key",
  ".p12",
  ".pem",
  ".pfx"
]);

type FileSearchTextCounters = {
  filesScanned: number;
  filesMatched: number;
  directoriesScanned: number;
  truncated: boolean;
  skipped: FileSearchTextData["skipped"];
};

type FileFindByNameCounters = {
  entriesScanned: number;
  directoriesScanned: number;
  truncated: boolean;
  skipped: FileFindByNameData["skipped"];
};

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

  inspectPath(pathValue: string): FileInspectPathData {
    const requestedPath = resolve(pathValue);
    const requestedExists = existsSync(requestedPath);
    const linkStat = requestedExists ? lstatSync(requestedPath) : undefined;
    const inspectedPath = linkStat?.isSymbolicLink()
      ? resolve(assertAllowedFilePath(dirname(requestedPath)), basename(requestedPath))
      : assertAllowedFilePath(pathValue, { mustExist: false });
    const fileName = basename(inspectedPath);
    const parentPath = dirname(inspectedPath);
    const extension = extname(fileName).toLowerCase() || undefined;
    const sensitiveHint = isSensitiveSearchFile(fileName);

    if (!requestedExists) {
      return {
        status: "ok",
        path: inspectedPath,
        fileName,
        parentPath,
        exists: false,
        kind: "missing",
        isSymbolicLink: false,
        extension,
        mediaKind: "unknown",
        readTextLikelySupported: false,
        sensitiveHint,
        safetyNotes: buildInspectPathSafetyNotes({
          exists: false,
          kind: "missing",
          sensitiveHint
        }),
        inspectedAt: Date.now()
      };
    }

    if (linkStat?.isSymbolicLink()) {
      return {
        status: "ok",
        path: inspectedPath,
        fileName,
        parentPath,
        exists: true,
        kind: "symlink",
        isSymbolicLink: true,
        bytes: linkStat.size,
        extension,
        mediaKind: "unknown",
        modifiedAt: linkStat.mtimeMs,
        readTextLikelySupported: false,
        readTextSizeAllowed: false,
        sensitiveHint,
        safetyNotes: buildInspectPathSafetyNotes({
          exists: true,
          kind: "symlink",
          sensitiveHint
        }),
        inspectedAt: Date.now()
      };
    }

    const entryStat = statSync(inspectedPath);
    const kind = entryStat.isDirectory() ? "directory" as const : entryStat.isFile() ? "file" as const : "other" as const;
    const readText = inspectReadTextCapability(inspectedPath, fileName, kind, entryStat.size);

    return {
      status: "ok",
      path: inspectedPath,
      fileName,
      parentPath,
      exists: true,
      kind,
      isSymbolicLink: false,
      bytes: kind === "file" ? entryStat.size : undefined,
      extension,
      mediaKind: kind === "file" ? guessMediaKind(fileName) : "unknown",
      modifiedAt: entryStat.mtimeMs,
      readTextLikelySupported: readText.supported,
      readTextByteLimit: readText.byteLimit,
      readTextSizeAllowed: readText.sizeAllowed,
      sensitiveHint,
      safetyNotes: buildInspectPathSafetyNotes({
        exists: true,
        kind,
        sensitiveHint,
        readTextSupported: readText.supported,
        readTextSizeAllowed: readText.sizeAllowed
      }),
      inspectedAt: Date.now()
    };
  }

  listRecentArtifacts(limitValue?: number): FileListRecentArtifactsData {
    ensureRuntimeDirectories();
    const limit = normalizeRecentArtifactLimit(limitValue);
    const rootPath = assertAllowedFilePath(resolveDownloadFinalRoot());
    const rootStat = statSync(rootPath);
    if (!rootStat.isDirectory()) {
      throw createFileError("INVALID_REQUEST", `默认产物路径不是目录：${rootPath}`);
    }

    const directoryEntries = readdirSync(rootPath, { withFileTypes: true });
    const scannedEntries = directoryEntries.slice(0, MAX_RECENT_ARTIFACT_SCAN);
    const entries = scannedEntries
      .flatMap((entry) => {
        const candidatePath = join(rootPath, entry.name);
        const linkStat = lstatSync(candidatePath);
        if (linkStat.isSymbolicLink()) {
          return [];
        }
        const path = assertAllowedFilePath(candidatePath);
        const entryStat = statSync(path);
        const kind = entryStat.isDirectory() ? "directory" as const : entryStat.isFile() ? "file" as const : undefined;
        if (!kind) {
          return [];
        }
        const extension = kind === "file" ? extname(entry.name).toLowerCase() : undefined;
        return [{
          path,
          fileName: entry.name,
          kind,
          bytes: kind === "file" ? entryStat.size : undefined,
          extension,
          mediaKind: kind === "file" ? guessMediaKind(entry.name) : "unknown" as const,
          modifiedAt: entryStat.mtimeMs
        }];
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    const selectedEntries = entries.slice(0, limit);

    return {
      rootPath,
      entries: selectedEntries,
      count: selectedEntries.length,
      limit,
      truncated:
        directoryEntries.length > MAX_RECENT_ARTIFACT_SCAN
        || entries.length > limit,
      listedAt: Date.now()
    };
  }

  async readText(pathValue: string): Promise<FileReadTextData> {
    const path = assertAllowedFilePath(pathValue);
    const fileStat = statSync(path);
    if (!fileStat.isFile()) {
      throw createFileError("INVALID_REQUEST", `路径不是文件：${path}`);
    }

    if (isSupportedDocumentTextPath(path)) {
      if (fileStat.size > MAX_DOCUMENT_BYTES) {
        throw createFileError("FILE_TOO_LARGE", `文档文件超过 ${MAX_DOCUMENT_BYTES} 字节上限`, {
          bytes: fileStat.size,
          maxBytes: MAX_DOCUMENT_BYTES
        });
      }
      const extracted = await extractDocumentText(path, readFileSync(path));
      return {
        path,
        fileName: basename(path),
        content: extracted.content,
        bytes: fileStat.size,
        characters: extracted.characters,
        truncated: extracted.truncated,
        sourceKind: extracted.sourceKind
      };
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
    const normalizedContent = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

    return {
      path,
      fileName: basename(path),
      content: normalizedContent,
      bytes: fileStat.size,
      characters: normalizedContent.length,
      truncated: false,
      sourceKind: "text"
    };
  }

  searchText(input: FileSearchTextRequest, signal?: AbortSignal): FileSearchTextData {
    const path = assertAllowedFilePath(input.path);
    const query = normalizeSearchQuery(input.query);
    const caseSensitive = input.caseSensitive === true;
    const maxResults = normalizeSearchLimit(
      input.maxResults,
      DEFAULT_SEARCH_RESULTS,
      MAX_SEARCH_RESULTS,
      "maxResults"
    );
    const maxDepth = normalizeSearchLimit(
      input.maxDepth,
      DEFAULT_SEARCH_DEPTH,
      MAX_SEARCH_DEPTH,
      "maxDepth"
    );
    const allowedExtensions = normalizeSearchExtensions(input.extensions);
    const pathStat = statSync(path);
    const counters: FileSearchTextCounters = {
      filesScanned: 0,
      filesMatched: 0,
      directoriesScanned: 0,
      truncated: false,
      skipped: {
        directories: 0,
        files: 0,
        binaryOrInvalidUtf8: 0,
        tooLarge: 0,
        unsupportedExtension: 0,
        hiddenSensitive: 0,
        symbolicLinks: 0
      }
    };
    const matches: FileSearchTextMatch[] = [];

    if (pathStat.isFile()) {
      searchFile({
        path,
        query,
        caseSensitive,
        allowedExtensions,
        maxResults,
        matches,
        counters,
        signal
      });
    } else if (pathStat.isDirectory()) {
      scanDirectory({
        path,
        depth: 0,
        maxDepth,
        query,
        caseSensitive,
        allowedExtensions,
        maxResults,
        matches,
        counters,
        signal
      });
    } else {
      throw createFileError("INVALID_REQUEST", `路径不是文件或目录：${path}`);
    }

    return {
      path,
      query,
      caseSensitive,
      matches,
      matchCount: matches.length,
      filesScanned: counters.filesScanned,
      filesMatched: counters.filesMatched,
      directoriesScanned: counters.directoriesScanned,
      truncated: counters.truncated,
      skipped: counters.skipped,
      searchedAt: Date.now()
    };
  }

  findByName(input: FileFindByNameRequest, signal?: AbortSignal): FileFindByNameData {
    const path = assertAllowedFilePath(input.path);
    const query = normalizeFindNameQuery(input.query);
    const caseSensitive = input.caseSensitive === true;
    const kindFilter = normalizeFindKind(input.kind);
    const maxResults = normalizeSearchLimit(
      input.maxResults,
      DEFAULT_FIND_RESULTS,
      MAX_FIND_RESULTS,
      "maxResults"
    );
    const maxDepth = normalizeSearchLimit(
      input.maxDepth,
      DEFAULT_FIND_DEPTH,
      MAX_FIND_DEPTH,
      "maxDepth"
    );
    const pathStat = statSync(path);
    const counters: FileFindByNameCounters = {
      entriesScanned: 0,
      directoriesScanned: 0,
      truncated: false,
      skipped: {
        directories: 0,
        files: 0,
        symbolicLinks: 0,
        notAllowed: 0
      }
    };
    const matches: FileFindByNameMatch[] = [];

    if (pathStat.isFile()) {
      counters.entriesScanned += 1;
      maybePushFindNameMatch({
        path,
        fileName: basename(path),
        kind: "file",
        statSize: pathStat.size,
        modifiedAt: pathStat.mtimeMs,
        query,
        caseSensitive,
        kindFilter,
        maxResults,
        matches,
        counters
      });
    } else if (pathStat.isDirectory()) {
      scanFindNameDirectory({
        path,
        depth: 0,
        maxDepth,
        query,
        caseSensitive,
        kindFilter,
        maxResults,
        matches,
        counters,
        signal
      });
    } else {
      throw createFileError("INVALID_REQUEST", `路径不是文件或目录：${path}`);
    }

    return {
      path,
      query,
      caseSensitive,
      kindFilter,
      matches,
      matchCount: matches.length,
      entriesScanned: counters.entriesScanned,
      directoriesScanned: counters.directoriesScanned,
      truncated: counters.truncated,
      skipped: counters.skipped,
      searchedAt: Date.now()
    };
  }
}

function normalizeRecentArtifactLimit(limitValue?: number): number {
  if (limitValue === undefined) {
    return DEFAULT_RECENT_ARTIFACT_LIMIT;
  }
  if (!Number.isInteger(limitValue) || limitValue < 1) {
    throw createFileError("INVALID_REQUEST", "limit 必须是正整数");
  }
  return Math.min(limitValue, MAX_RECENT_ARTIFACT_LIMIT);
}

function inspectReadTextCapability(
  path: string,
  fileName: string,
  kind: FileInspectPathData["kind"],
  bytes: number
): {
  supported: boolean;
  byteLimit?: number;
  sizeAllowed?: boolean;
} {
  if (kind !== "file") {
    return { supported: false };
  }

  if (isSupportedDocumentTextPath(path)) {
    return {
      supported: true,
      byteLimit: MAX_DOCUMENT_BYTES,
      sizeAllowed: bytes <= MAX_DOCUMENT_BYTES
    };
  }

  if (isSearchableTextFile(fileName)) {
    return {
      supported: true,
      byteLimit: MAX_TEXT_BYTES,
      sizeAllowed: bytes <= MAX_TEXT_BYTES
    };
  }

  return { supported: false };
}

function buildInspectPathSafetyNotes(options: {
  exists: boolean;
  kind: FileInspectPathData["kind"];
  sensitiveHint: boolean;
  readTextSupported?: boolean;
  readTextSizeAllowed?: boolean;
}): string[] {
  const notes: string[] = [];

  if (!options.exists) {
    notes.push("路径位于允许根内，但当前不存在；本工具不会创建文件或目录。");
  }

  if (options.kind === "symlink") {
    notes.push("这是符号链接或 junction；预检只报告链接本身，不跟随目标路径。");
  }

  if (options.kind === "directory") {
    notes.push("这是目录；如需查看一层内容，使用 file.listDirectory。");
  }

  if (options.kind === "other") {
    notes.push("这不是普通文件或目录；文件读取工具不会把它当作文本读取。");
  }

  if (options.sensitiveHint) {
    notes.push("文件名像敏感凭据；实际读取会触发敏感路径确认或被安全策略阻止。");
  }

  if (options.exists && options.kind === "file" && options.readTextSupported === false) {
    notes.push("扩展名不属于常见文本/PDF/DOCX 类型；不建议用 file.readText 直接读取。");
  }

  if (options.readTextSupported && options.readTextSizeAllowed === false) {
    notes.push("文件类型可读，但大小超过 file.readText 的当前字节上限。");
  }

  return notes;
}

export const fileAccessManager = new FileAccessManager();

function normalizeSearchQuery(query: string): string {
  const trimmed = query?.trim();
  if (!trimmed) {
    throw createFileError("INVALID_REQUEST", "query 不能为空");
  }
  if (trimmed.includes("\0")) {
    throw createFileError("INVALID_REQUEST", "query 不能包含 NUL 字符");
  }
  if (trimmed.length > MAX_SEARCH_QUERY_CHARACTERS) {
    throw createFileError(
      "INVALID_REQUEST",
      `query 超过 ${MAX_SEARCH_QUERY_CHARACTERS} 字符上限`
    );
  }
  return trimmed;
}

function normalizeSearchLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw createFileError("INVALID_REQUEST", `${label} 必须是 1-${maximum} 的整数`);
  }
  return value;
}

function normalizeSearchExtensions(extensions: string[] | undefined): Set<string> | undefined {
  if (extensions === undefined) {
    return undefined;
  }
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw createFileError("INVALID_REQUEST", "extensions 至少包含一个扩展名");
  }
  if (extensions.length > MAX_SEARCH_EXTENSIONS) {
    throw createFileError(
      "INVALID_REQUEST",
      `extensions 最多允许 ${MAX_SEARCH_EXTENSIONS} 项`
    );
  }

  const normalized = new Set<string>();
  for (const item of extensions) {
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) {
      throw createFileError("INVALID_REQUEST", "extensions 不能包含空值");
    }
    const extension = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
    if (!SEARCHABLE_TEXT_EXTENSIONS.has(extension)) {
      throw createFileError("INVALID_REQUEST", `不支持全文搜索扩展名：${item}`);
    }
    normalized.add(extension);
  }
  return normalized;
}

function normalizeFindNameQuery(query: string): string {
  const trimmed = query?.trim();
  if (!trimmed) {
    throw createFileError("INVALID_REQUEST", "query 不能为空");
  }
  if (trimmed.includes("\0")) {
    throw createFileError("INVALID_REQUEST", "query 不能包含 NUL 字符");
  }
  if (trimmed.length > MAX_FIND_QUERY_CHARACTERS) {
    throw createFileError(
      "INVALID_REQUEST",
      `query 超过 ${MAX_FIND_QUERY_CHARACTERS} 字符上限`
    );
  }
  return trimmed;
}

function normalizeFindKind(kind: FileFindByNameRequest["kind"]): FileFindByNameData["kindFilter"] {
  if (kind === undefined || kind === "any") {
    return "any";
  }
  if (kind === "file" || kind === "directory") {
    return kind;
  }
  throw createFileError("INVALID_REQUEST", "kind 必须是 any | file | directory");
}

function scanFindNameDirectory(options: {
  path: string;
  depth: number;
  maxDepth: number;
  query: string;
  caseSensitive: boolean;
  kindFilter: FileFindByNameData["kindFilter"];
  maxResults: number;
  matches: FileFindByNameMatch[];
  counters: FileFindByNameCounters;
  signal?: AbortSignal;
}) {
  throwIfSearchAborted(options.signal);
  if (options.matches.length >= options.maxResults || options.counters.truncated) {
    return;
  }

  options.counters.directoriesScanned += 1;
  const entries = readdirSync(options.path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    throwIfSearchAborted(options.signal);
    if (options.matches.length >= options.maxResults) {
      options.counters.truncated = true;
      return;
    }
    if (options.counters.entriesScanned >= MAX_FIND_ENTRIES) {
      options.counters.truncated = true;
      return;
    }

    options.counters.entriesScanned += 1;
    const rawEntryPath = join(options.path, entry.name);
    if (isSymbolicLinkPath(rawEntryPath)) {
      options.counters.skipped.symbolicLinks += 1;
      continue;
    }

    let entryPath: string;
    try {
      entryPath = assertAllowedFilePath(rawEntryPath);
    } catch {
      options.counters.skipped.notAllowed += 1;
      continue;
    }

    const entryStat = statSync(entryPath);
    const kind = entryStat.isDirectory()
      ? "directory" as const
      : entryStat.isFile()
        ? "file" as const
        : undefined;
    if (!kind) {
      options.counters.skipped.files += 1;
      continue;
    }

    maybePushFindNameMatch({
      path: entryPath,
      fileName: entry.name,
      kind,
      statSize: entryStat.size,
      modifiedAt: entryStat.mtimeMs,
      query: options.query,
      caseSensitive: options.caseSensitive,
      kindFilter: options.kindFilter,
      maxResults: options.maxResults,
      matches: options.matches,
      counters: options.counters
    });

    if (kind !== "directory") {
      continue;
    }
    if (
      SEARCH_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())
      || options.depth >= options.maxDepth
    ) {
      options.counters.skipped.directories += 1;
      continue;
    }
    scanFindNameDirectory({ ...options, path: entryPath, depth: options.depth + 1 });
  }
}

function maybePushFindNameMatch(options: {
  path: string;
  fileName: string;
  kind: FileFindByNameMatch["kind"];
  statSize: number;
  modifiedAt: number;
  query: string;
  caseSensitive: boolean;
  kindFilter: FileFindByNameData["kindFilter"];
  maxResults: number;
  matches: FileFindByNameMatch[];
  counters: FileFindByNameCounters;
}) {
  if (
    options.kindFilter !== "any"
    && options.kindFilter !== options.kind
  ) {
    return;
  }
  if (!doesFileNameMatchQuery(options.fileName, options.query, options.caseSensitive)) {
    return;
  }
  if (options.matches.length >= options.maxResults) {
    options.counters.truncated = true;
    return;
  }

  const extension = options.kind === "file"
    ? extname(options.fileName).toLowerCase() || undefined
    : undefined;
  options.matches.push({
    path: options.path,
    fileName: options.fileName,
    kind: options.kind,
    bytes: options.kind === "file" ? options.statSize : undefined,
    extension,
    mediaKind: options.kind === "file" ? guessMediaKind(options.fileName) : "unknown",
    modifiedAt: options.modifiedAt
  });
}

function doesFileNameMatchQuery(
  fileName: string,
  query: string,
  caseSensitive: boolean
): boolean {
  if (caseSensitive) {
    return fileName.includes(query);
  }
  return fileName.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function scanDirectory(options: {
  path: string;
  depth: number;
  maxDepth: number;
  query: string;
  caseSensitive: boolean;
  allowedExtensions?: Set<string>;
  maxResults: number;
  matches: FileSearchTextMatch[];
  counters: FileSearchTextCounters;
  signal?: AbortSignal;
}) {
  throwIfSearchAborted(options.signal);
  if (options.matches.length >= options.maxResults || options.counters.truncated) {
    return;
  }

  options.counters.directoriesScanned += 1;
  const entries = readdirSync(options.path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    throwIfSearchAborted(options.signal);
    if (options.matches.length >= options.maxResults || options.counters.truncated) {
      options.counters.truncated = true;
      return;
    }

    const rawEntryPath = join(options.path, entry.name);
    if (isSymbolicLinkPath(rawEntryPath)) {
      options.counters.skipped.symbolicLinks += 1;
      continue;
    }

    let entryPath: string;
    try {
      entryPath = assertAllowedFilePath(rawEntryPath);
    } catch {
      options.counters.skipped.files += 1;
      continue;
    }

    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory()) {
      if (
        SEARCH_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())
        || options.depth >= options.maxDepth
      ) {
        options.counters.skipped.directories += 1;
        continue;
      }
      scanDirectory({ ...options, path: entryPath, depth: options.depth + 1 });
      continue;
    }

    if (!entryStat.isFile()) {
      options.counters.skipped.files += 1;
      continue;
    }
    if (options.counters.filesScanned >= MAX_SEARCH_FILES) {
      options.counters.truncated = true;
      return;
    }

    searchFile({
      path: entryPath,
      query: options.query,
      caseSensitive: options.caseSensitive,
      allowedExtensions: options.allowedExtensions,
      maxResults: options.maxResults,
      matches: options.matches,
      counters: options.counters,
      signal: options.signal
    });
  }
}

function searchFile(options: {
  path: string;
  query: string;
  caseSensitive: boolean;
  allowedExtensions?: Set<string>;
  maxResults: number;
  matches: FileSearchTextMatch[];
  counters: FileSearchTextCounters;
  signal?: AbortSignal;
}) {
  throwIfSearchAborted(options.signal);
  const fileName = basename(options.path);
  if (isSensitiveSearchFile(fileName)) {
    options.counters.skipped.hiddenSensitive += 1;
    return;
  }
  if (!isSearchableTextFile(fileName, options.allowedExtensions)) {
    options.counters.skipped.unsupportedExtension += 1;
    return;
  }

  const fileStat = statSync(options.path);
  if (fileStat.size > MAX_SEARCH_FILE_BYTES) {
    options.counters.skipped.tooLarge += 1;
    return;
  }

  options.counters.filesScanned += 1;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(options.path));
  } catch {
    options.counters.skipped.binaryOrInvalidUtf8 += 1;
    return;
  }
  if (content.includes("\0")) {
    options.counters.skipped.binaryOrInvalidUtf8 += 1;
    return;
  }

  const searchableContent = options.caseSensitive ? content : content.toLocaleLowerCase();
  const searchableQuery = options.caseSensitive
    ? options.query
    : options.query.toLocaleLowerCase();
  const lines = content.split(/\r\n|\n|\r/);
  const searchableLines = searchableContent.split(/\r\n|\n|\r/);
  let fileMatched = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    throwIfSearchAborted(options.signal);
    const searchableLine = searchableLines[lineIndex] ?? "";
    let matchIndex = searchableLine.indexOf(searchableQuery);
    while (matchIndex >= 0) {
      if (options.matches.length >= options.maxResults) {
        options.counters.truncated = true;
        return;
      }
      options.matches.push({
        path: options.path,
        fileName,
        lineNumber: lineIndex + 1,
        column: matchIndex + 1,
        preview: buildSearchPreview(lines[lineIndex] ?? "", matchIndex, options.query.length)
      });
      fileMatched = true;
      matchIndex = searchableLine.indexOf(searchableQuery, matchIndex + searchableQuery.length);
    }
  }

  if (fileMatched) {
    options.counters.filesMatched += 1;
  }
}

function isSearchableTextFile(fileName: string, allowedExtensions?: Set<string>): boolean {
  const lowerName = fileName.toLowerCase();
  const extension = extname(lowerName);
  if (allowedExtensions) {
    return allowedExtensions.has(extension);
  }
  return SEARCHABLE_TEXT_EXTENSIONS.has(extension)
    || SEARCHABLE_EXTENSIONLESS_NAMES.has(lowerName)
    || lowerName === ".gitignore";
}

function isSensitiveSearchFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return SENSITIVE_FILE_NAMES.has(lowerName)
    || lowerName.startsWith(".env.")
    || SENSITIVE_FILE_EXTENSIONS.has(extname(lowerName));
}

function isSymbolicLinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function buildSearchPreview(line: string, matchIndex: number, queryLength: number): string {
  const before = Math.max(0, matchIndex - 90);
  const after = Math.min(line.length, matchIndex + queryLength + 90);
  const head = before > 0 ? "..." : "";
  const tail = after < line.length ? "..." : "";
  const preview = `${head}${line.slice(before, after)}${tail}`
    .replace(/\s+/g, " ")
    .trim();
  if (preview.length <= MAX_SEARCH_PREVIEW_CHARACTERS) {
    return preview;
  }
  return `${preview.slice(0, MAX_SEARCH_PREVIEW_CHARACTERS - 3)}...`;
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createFileError("INTERNAL_ERROR", "文件搜索已取消");
  }
}
