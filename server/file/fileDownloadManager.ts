/**
 * 阶段 D：下载到任务临时目录 → 确认后移动到白名单目录 → 校验。
 * 不走任意 Shell；HTTP(S) 直下，路径规范化 + 白名单。
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  assertAllowedDestinationDirectory,
  createFileError,
  ensureRuntimeDirectories,
  resolveDownloadTempRoot
} from "./fileRuntimePaths";
import type {
  FileDownloadToTempData,
  FilePlaceDownloadData,
  FileVerifyData,
  OverwritePolicy
} from "./fileTypes";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50MB：样板任务上限，防误下巨大文件

function sanitizeFileName(raw: string): string {
  // 去掉 Windows 非法字符与 ASCII 控制字符（逐字符过滤，避免正则控制符转义问题）
  const cleaned = basename(raw)
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32) {
        return "_";
      }
      if ('<>:"/\\|?*'.includes(char)) {
        return "_";
      }
      return char;
    })
    .join("")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `download_${Date.now()}`;
  }
  return cleaned.slice(0, 180);
}

function guessFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = basename(parsed.pathname);
    if (last && last !== "/" && last !== ".") {
      return sanitizeFileName(last);
    }
  } catch {
    // ignore
  }
  return `download_${Date.now()}.bin`;
}

function parseContentDispositionFileName(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8Match?.[1]) {
    try {
      return sanitizeFileName(decodeURIComponent(utf8Match[1]));
    } catch {
      return sanitizeFileName(utf8Match[1]);
    }
  }
  const plainMatch = /filename="?([^";]+)"?/i.exec(header);
  if (plainMatch?.[1]) {
    return sanitizeFileName(plainMatch[1]);
  }
  return undefined;
}

function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw createFileError("INVALID_REQUEST", `非法 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createFileError("INVALID_REQUEST", `仅允许 http/https 下载：${url}`);
  }
  return parsed.toString();
}

function extensionOf(fileName: string): string {
  const ext = extname(fileName).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

/** 可执行/安装包扩展名：统一归 binary，避免被当作可直接打开的文档 */
const EXECUTABLE_EXTENSIONS = [
  "exe", "msi", "msix", "appx", "dmg", "pkg", "deb", "rpm", "appimage", "apk", "bin"
];
/** 压缩/归档扩展名 */
const ARCHIVE_EXTENSIONS = [
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"
];

function guessMediaKind(fileName: string, contentType?: string): FileVerifyData["mediaKind"] {
  const ext = extensionOf(fileName);
  const type = (contentType ?? "").toLowerCase();

  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
    return "image";
  }
  if (type.startsWith("audio/") || ["mp3", "wav", "flac", "aac", "m4a", "ogg"].includes(ext)) {
    return "audio";
  }
  if (type.startsWith("video/") || ["mp4", "webm", "mkv", "mov", "avi"].includes(ext)) {
    return "video";
  }
  if (
    type.includes("pdf")
    || type.includes("msword")
    || type.includes("officedocument")
    || ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)
  ) {
    return "document";
  }
  if (
    type.includes("zip")
    || type.includes("compressed")
    || type.includes("x-tar")
    || type.includes("gzip")
    || type.includes("bzip")
    || ARCHIVE_EXTENSIONS.includes(ext)
  ) {
    return "archive";
  }
  // 可执行/安装包类（.exe/.msi 等常为 application/octet-stream，靠扩展名兜住）
  if (
    type.includes("x-msdownload")
    || type.includes("portable-executable")
    || type.includes("x-msi")
    || type.includes("x-msdos-program")
    || type.includes("x-apple-diskimage")
    || EXECUTABLE_EXTENSIONS.includes(ext)
  ) {
    return "binary";
  }
  if (type.startsWith("text/") || ["txt", "md", "csv", "json", "html", "htm", "xml"].includes(ext)) {
    return "text";
  }
  if (ext) {
    return "binary";
  }
  return "unknown";
}

function taskTempDirectory(taskId: string): string {
  const dir = join(resolveDownloadTempRoot(), sanitizeFileName(taskId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveUniquePath(directory: string, fileName: string): { path: string; renamed: boolean } {
  const safeName = sanitizeFileName(fileName);
  const first = join(directory, safeName);
  if (!existsSync(first)) {
    return { path: first, renamed: false };
  }

  const ext = extname(safeName);
  const stem = basename(safeName, ext);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = join(directory, `${stem} (${index})${ext}`);
    if (!existsSync(candidate)) {
      return { path: candidate, renamed: true };
    }
  }

  throw createFileError("MOVE_FAILED", "无法生成不冲突的文件名");
}

export class FileDownloadManager {
  constructor() {
    ensureRuntimeDirectories();
  }

  async downloadToTemp(input: {
    taskId: string;
    url: string;
    suggestedFileName?: string;
  }): Promise<FileDownloadToTempData> {
    const taskId = input.taskId.trim();
    if (!taskId) {
      throw createFileError("INVALID_REQUEST", "taskId 不能为空");
    }

    const url = assertHttpUrl(input.url);
    const tempDir = taskTempDirectory(taskId);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      });
    } catch (error) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        error instanceof Error ? `下载失败：${error.message}` : "下载失败",
        { url }
      );
    }

    if (!response.ok) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        `下载 HTTP ${response.status}`,
        { url, status: response.status }
      );
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
        throw createFileError(
          "DOWNLOAD_FAILED",
          `文件过大（${contentLength} bytes），超过上限 ${MAX_DOWNLOAD_BYTES}`,
          { url, contentLength }
        );
      }
    }

    const fromHeader = parseContentDispositionFileName(
      response.headers.get("content-disposition")
    );
    const fileName = sanitizeFileName(
      input.suggestedFileName?.trim()
      || fromHeader
      || guessFileNameFromUrl(url)
    );
    const tempPath = join(tempDir, `${Date.now()}_${fileName}`);

    if (!response.body) {
      throw createFileError("DOWNLOAD_FAILED", "响应无正文", { url });
    }

    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    let written = 0;
    nodeStream.on("data", (chunk: Buffer | string) => {
      written += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (written > MAX_DOWNLOAD_BYTES) {
        nodeStream.destroy(createFileError(
          "DOWNLOAD_FAILED",
          `下载中止：超过大小上限 ${MAX_DOWNLOAD_BYTES} bytes`,
          { url }
        ));
      }
    });

    try {
      await pipeline(nodeStream, createWriteStream(tempPath));
    } catch (error) {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // ignore cleanup failure
        }
      }
      if (
        typeof error === "object"
        && error !== null
        && "fileCode" in error
      ) {
        throw error;
      }
      throw createFileError(
        "DOWNLOAD_FAILED",
        error instanceof Error ? error.message : "写入临时文件失败",
        { url }
      );
    }

    const stat = statSync(tempPath);
    return {
      taskId,
      url,
      tempPath,
      fileName,
      bytes: stat.size,
      contentType,
      // 结合响应 Content-Type 与扩展名给出媒体类别（通用文件能力，非某场景专用）
      mediaKind: guessMediaKind(fileName, contentType),
      downloadedAt: Date.now()
    };
  }

  placeDownload(input: {
    taskId: string;
    tempPath: string;
    destinationDirectory: string;
    fileName?: string;
    overwritePolicy: OverwritePolicy;
  }): FilePlaceDownloadData {
    const taskId = input.taskId.trim();
    if (!taskId) {
      throw createFileError("INVALID_REQUEST", "taskId 不能为空");
    }

    // 预检顺序：先白名单目标目录（分类清晰），再查 temp 存在性，避免非法目录被 FILE_NOT_FOUND 盖住
    const destinationDirectory = assertAllowedDestinationDirectory(input.destinationDirectory);

    const tempPath = resolve(input.tempPath);
    if (!existsSync(tempPath)) {
      throw createFileError("FILE_NOT_FOUND", `临时文件不存在：${tempPath}`);
    }

    // 临时文件必须在 downloads-temp 下，防止把任意路径当下载源移动
    const tempRoot = resolve(resolveDownloadTempRoot());
    if (!tempPath.startsWith(tempRoot)) {
      throw createFileError(
        "PATH_NOT_ALLOWED",
        `临时路径不在允许的 temp 目录：${tempPath}`,
        { tempRoot }
      );
    }

    mkdirSync(destinationDirectory, { recursive: true });

    const fileName = sanitizeFileName(input.fileName?.trim() || basename(tempPath));
    const policy = input.overwritePolicy;
    let finalPath = join(destinationDirectory, fileName);
    let renamed = false;

    if (existsSync(finalPath)) {
      if (policy === "refuse") {
        throw createFileError(
          "OVERWRITE_REFUSED",
          `目标已存在且策略为拒绝覆盖：${finalPath}`
        );
      }
      if (policy === "overwrite") {
        try {
          unlinkSync(finalPath);
        } catch (error) {
          throw createFileError(
            "MOVE_FAILED",
            error instanceof Error ? error.message : "无法覆盖已有文件",
            { finalPath }
          );
        }
      } else if (policy === "rename") {
        const unique = resolveUniquePath(destinationDirectory, fileName);
        finalPath = unique.path;
        renamed = unique.renamed;
      } else {
        throw createFileError("INVALID_REQUEST", `未知覆盖策略：${String(policy)}`);
      }
    }

    try {
      renameSync(tempPath, finalPath);
    } catch {
      // 跨盘符时 rename 可能失败：读改写不在此阶段引入；明确报错
      throw createFileError(
        "MOVE_FAILED",
        `移动失败（可能跨盘）：${tempPath} → ${finalPath}`
      );
    }

    const stat = statSync(finalPath);
    const finalFileName = basename(finalPath);
    return {
      taskId,
      tempPath,
      finalPath,
      fileName: finalFileName,
      bytes: stat.size,
      // 落盘结果同样带 mediaKind，便于 summary/确认链路统一可读
      mediaKind: guessMediaKind(finalFileName),
      overwritePolicy: policy,
      renamed,
      movedAt: Date.now()
    };
  }

  verify(pathValue: string): FileVerifyData {
    if (!pathValue?.trim()) {
      throw createFileError("INVALID_REQUEST", "path 不能为空");
    }
    const path = resolve(pathValue);
    if (!existsSync(path)) {
      return {
        path,
        exists: false,
        mediaKind: "unknown",
        verifiedAt: Date.now()
      };
    }

    const stat = statSync(path);
    if (!stat.isFile()) {
      throw createFileError("VERIFY_FAILED", `路径不是文件：${path}`);
    }

    const fileName = basename(path);
    const extension = extensionOf(fileName) || undefined;
    const mediaKind = guessMediaKind(fileName);
    const contentTypeGuess = guessContentType(fileName, mediaKind);

    return {
      path,
      exists: true,
      bytes: stat.size,
      fileName,
      extension,
      mediaKind,
      contentTypeGuess,
      verifiedAt: Date.now()
    };
  }
}

function guessContentType(
  fileName: string,
  mediaKind: FileVerifyData["mediaKind"]
): string | undefined {
  const ext = extensionOf(fileName);
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    tar: "application/x-tar",
    gz: "application/gzip",
    tgz: "application/gzip",
    exe: "application/x-msdownload",
    msi: "application/x-msi",
    mp3: "audio/mpeg",
    mp4: "video/mp4"
  };
  if (ext && map[ext]) {
    return map[ext];
  }
  if (mediaKind === "text") {
    return "text/plain";
  }
  if (mediaKind === "binary") {
    return "application/octet-stream";
  }
  return undefined;
}

export const fileDownloadManager = new FileDownloadManager();
