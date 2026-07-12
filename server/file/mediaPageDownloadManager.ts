/**
 * 受约束的「媒体页下载」：仅允许白名单站点视频页，固定调用本机 yt-dlp。
 * 不是任意 Shell：可执行文件路径由运行时解析，参数模板写死，pageUrl 经主机白名单校验。
 * B 站视频通常是音视频分离流，合并依赖本机 ffmpeg（由 yt-dlp 调用）。
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createFileError, resolveDownloadTempRoot } from "./fileRuntimePaths";
import { guessMediaKind } from "./fileDownloadManager";
import type { FileDownloadMediaPageData } from "./fileTypes";

/** 媒体页下载体积上限：500MB */
const MAX_MEDIA_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** yt-dlp 默认超时 */
const DEFAULT_YTDLP_TIMEOUT_MS = 15 * 60 * 1000;
const RUNTIME_BIN = join("D:\\AI\\void-runtime", "bin");

const BILIBILI_VIDEO_HOSTS = new Set([
  "www.bilibili.com",
  "bilibili.com",
  "m.bilibili.com",
  "www.b23.tv",
  "b23.tv"
]);

function sanitizeFileName(raw: string): string {
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
    return `media_${Date.now()}`;
  }
  return cleaned.slice(0, 180);
}

function taskTempDirectory(taskId: string): string {
  const dir = join(resolveDownloadTempRoot(), sanitizeFileName(taskId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 校验并归一化媒体页 URL。首期仅 B 站视频页。
 */
export function assertAllowedMediaPageUrl(rawUrl: string): {
  pageUrl: string;
  site: "bilibili";
  videoId?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw createFileError("INVALID_REQUEST", `非法媒体页 URL：${rawUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createFileError("INVALID_REQUEST", `仅允许 http/https 媒体页：${rawUrl}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!BILIBILI_VIDEO_HOSTS.has(host)) {
    throw createFileError(
      "MEDIA_HOST_NOT_ALLOWED",
      `当前仅支持 B 站视频页下载，不支持主机：${host}`,
      { host, allowedHosts: [...BILIBILI_VIDEO_HOSTS] }
    );
  }

  if (host === "b23.tv" || host === "www.b23.tv") {
    return {
      pageUrl: parsed.toString(),
      site: "bilibili"
    };
  }

  const bvMatch = parsed.pathname.match(/\/video\/(BV[\w]+)/i);
  const avMatch = parsed.pathname.match(/\/video\/(av\d+)/i);
  if (!bvMatch && !avMatch) {
    throw createFileError(
      "INVALID_REQUEST",
      "B 站下载仅接受 /video/BVxxx 或 /video/avxxx 视频页 URL",
      { pathname: parsed.pathname }
    );
  }

  const videoId = (bvMatch?.[1] || avMatch?.[1] || "").toString();
  const normalized = bvMatch
    ? `https://www.bilibili.com/video/${bvMatch[1]}`
    : `https://www.bilibili.com/video/${avMatch![1]}`;

  return {
    pageUrl: normalized,
    site: "bilibili",
    videoId
  };
}

/**
 * 解析 yt-dlp：VOID_YTDLP_PATH > 运行时 bin > PATH 常见名。
 */
export function resolveYtDlpExecutable(): string {
  const fromEnv = process.env.VOID_YTDLP_PATH?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw createFileError(
        "YTDLP_NOT_FOUND",
        `VOID_YTDLP_PATH 指向的 yt-dlp 不存在：${fromEnv}`,
        { path: fromEnv }
      );
    }
    return fromEnv;
  }

  for (const candidate of [join(RUNTIME_BIN, "yt-dlp.exe"), join(RUNTIME_BIN, "yt-dlp")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

/**
 * 解析 ffmpeg 绝对路径（B 站 dash 合并必需）。
 * VOID_FFMPEG_PATH > 运行时 bin；找不到则明确报错，禁止静默下无声轨文件。
 */
export function resolveFfmpegExecutable(): string {
  const fromEnv = process.env.VOID_FFMPEG_PATH?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw createFileError(
        "FFMPEG_NOT_FOUND",
        `VOID_FFMPEG_PATH 指向的 ffmpeg 不存在：${fromEnv}`,
        { path: fromEnv }
      );
    }
    return resolve(fromEnv);
  }

  for (const candidate of [join(RUNTIME_BIN, "ffmpeg.exe"), join(RUNTIME_BIN, "ffmpeg")]) {
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  throw createFileError(
    "FFMPEG_NOT_FOUND",
    "B 站视频需要 ffmpeg 合并音视频。请安装 ffmpeg 后设置 VOID_FFMPEG_PATH，或放到 D:\\AI\\void-runtime\\bin\\ffmpeg.exe",
    { expectedDir: RUNTIME_BIN }
  );
}

function listNewFiles(directory: string, sinceMs: number): string[] {
  return readdirSync(directory)
    .map((name) => join(directory, name))
    .filter((fullPath) => {
      try {
        const stat = statSync(fullPath);
        return stat.isFile() && stat.mtimeMs >= sinceMs - 1000;
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function runYtDlp(input: {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (
      error?: Error,
      result?: { stdout: string; stderr: string; exitCode: number | null }
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(result!);
    };

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(createFileError("DOWNLOAD_FAILED", "媒体下载已取消", { reason: "aborted" }));
    };

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(
        createFileError("DOWNLOAD_FAILED", `媒体下载超时（${input.timeoutMs}ms）`, {
          timeoutMs: input.timeoutMs
        })
      );
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stdout.length > 200_000) {
        stdout = stdout.slice(-100_000);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-100_000);
      }
    });

    child.once("error", (error) => {
      const message = error.message || String(error);
      if (/ENOENT/i.test(message)) {
        finish(
          createFileError(
            "YTDLP_NOT_FOUND",
            "未找到 yt-dlp。请安装后加入 PATH，或设置 VOID_YTDLP_PATH，或放到 D:\\AI\\void-runtime\\bin\\yt-dlp.exe",
            { executable: input.executable }
          )
        );
        return;
      }
      finish(
        createFileError("DOWNLOAD_FAILED", `启动 yt-dlp 失败：${message}`, {
          executable: input.executable
        })
      );
    });

    child.once("close", (code) => {
      finish(undefined, { stdout, stderr, exitCode: code });
    });
  });
}

export class MediaPageDownloadManager {
  async downloadMediaPage(input: {
    taskId: string;
    pageUrl: string;
    suggestedFileName?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<FileDownloadMediaPageData> {
    const taskId = input.taskId.trim();
    if (!taskId) {
      throw createFileError("INVALID_REQUEST", "taskId 不能为空");
    }

    const allowed = assertAllowedMediaPageUrl(input.pageUrl);
    const executable = resolveYtDlpExecutable();
    const ffmpegPath = resolveFfmpegExecutable();
    const tempDir = taskTempDirectory(taskId);
    const startedAt = Date.now();
    const outputTemplate = join(tempDir, `media_${startedAt}.%(ext)s`);
    const timeoutMs = input.timeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS;

    // B 站 dash：视频+音频分离；固定交给 ffmpeg 合并为 mp4
    const args = [
      "--no-playlist",
      "--no-mtime",
      "--newline",
      "--restrict-filenames",
      "-f",
      "bv*+ba/b/best",
      "--merge-output-format",
      "mp4",
      "--ffmpeg-location",
      dirname(ffmpegPath),
      "-o",
      outputTemplate,
      "--",
      allowed.pageUrl
    ];

    const result = await runYtDlp({
      executable,
      args,
      timeoutMs,
      signal: input.signal
    });

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(-1000);
      if (/ffmpeg|ffprobe/i.test(detail) && /not found|not exist|找不到|No such file/i.test(detail)) {
        throw createFileError(
          "FFMPEG_NOT_FOUND",
          "yt-dlp 需要 ffmpeg 合并音视频，但未找到可用的 ffmpeg",
          { detail: detail.slice(-400) }
        );
      }
      throw createFileError(
        "DOWNLOAD_FAILED",
        detail
          ? `yt-dlp 下载失败（exit ${result.exitCode}）：${detail}`
          : `yt-dlp 下载失败（exit ${result.exitCode}）`,
        {
          exitCode: result.exitCode,
          pageUrl: allowed.pageUrl,
          site: allowed.site
        }
      );
    }

    const candidates = listNewFiles(tempDir, startedAt).filter((path) => {
      const name = basename(path);
      return name.startsWith(`media_${startedAt}`) || name.includes(String(startedAt));
    });

    let chosen =
      candidates[0]
      || listNewFiles(tempDir, startedAt).find((path) => {
        const ext = extname(path).toLowerCase();
        return [".mp4", ".webm", ".mkv", ".flv", ".m4a", ".mp3"].includes(ext);
      });

    if (!chosen || !existsSync(chosen)) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        "yt-dlp 退出成功但未找到输出文件",
        { tempDir, pageUrl: allowed.pageUrl }
      );
    }

    const stat = statSync(chosen);
    if (stat.size <= 0) {
      try {
        unlinkSync(chosen);
      } catch {
        // ignore
      }
      throw createFileError("DOWNLOAD_FAILED", "下载文件为空", { path: chosen });
    }
    if (stat.size > MAX_MEDIA_DOWNLOAD_BYTES) {
      try {
        unlinkSync(chosen);
      } catch {
        // ignore
      }
      throw createFileError(
        "DOWNLOAD_FAILED",
        `媒体文件过大（${stat.size} bytes），超过上限 ${MAX_MEDIA_DOWNLOAD_BYTES}`,
        { bytes: stat.size }
      );
    }

    const rawBase =
      input.suggestedFileName?.trim()
      || (allowed.videoId ? `${allowed.videoId}${extname(chosen) || ".mp4"}` : basename(chosen));
    const finalName = sanitizeFileName(
      extname(rawBase) ? rawBase : `${rawBase}${extname(chosen) || ".mp4"}`
    );
    const finalTempPath = join(tempDir, `${startedAt}_${finalName}`);
    if (resolve(chosen) !== resolve(finalTempPath)) {
      if (existsSync(finalTempPath)) {
        unlinkSync(finalTempPath);
      }
      renameSync(chosen, finalTempPath);
      chosen = finalTempPath;
    }

    const finalStat = statSync(chosen);
    return {
      taskId,
      pageUrl: allowed.pageUrl,
      site: allowed.site,
      videoId: allowed.videoId,
      tempPath: chosen,
      fileName: basename(chosen),
      bytes: finalStat.size,
      mediaKind: guessMediaKind(basename(chosen)),
      downloader: "yt-dlp",
      downloadedAt: Date.now()
    };
  }
}

export const mediaPageDownloadManager = new MediaPageDownloadManager();
