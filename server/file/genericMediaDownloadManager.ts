/**
 * 通用媒体下载（阶段 AE-P1）：任意 https URL 走 yt-dlp，不限 B 站白名单。
 * 安全：公网 URL 才允许；本地/私网/内网域名/单标签主机一律拒绝（复用 classifySensitiveHttpUrl）。
 * 体积与 yt-dlp/ffmpeg 解析复用 B 站专线的实现与错误分类。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createFileError, resolveDownloadTempRoot } from "./fileRuntimePaths";
import { guessMediaKind } from "./fileDownloadManager";
import type { FileDownloadMediaPageData } from "./fileTypes";

const MAX_MEDIA_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DEFAULT_YTDLP_TIMEOUT_MS = 15 * 60 * 1000;
const RUNTIME_BIN = join("D:\\AI\\void-runtime", "bin");

function isPrivateMediaHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h.startsWith("127.")) return "回环地址";
  if (h === "0.0.0.0") return "本地地址";
  if (/^10\./.test(h)) return "10.0.0.0/8 私有地址";
  if (/^192\.168\./.test(h)) return "192.168.0.0/16 私有地址";
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return "172.16.0.0/12 私有地址";
  if (/^169\.254\./.test(h)) return "链路本地地址";
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return "内网域名";
  if (!h.includes(".") && !h.includes(":")) return "单标签主机";
  return null;
}

function sanitizeFileName(raw: string): string {
  const cleaned = basename(raw)
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32) return "_";
      if ('<>:"/\\|?*'.includes(char)) return "_";
      return char;
    })
    .join("")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return `media_${Date.now()}`;
  return cleaned.slice(0, 180);
}

function taskTempDirectory(taskId: string): string {
  const dir = join(resolveDownloadTempRoot(), sanitizeFileName(taskId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function assertAllowedGenericMediaUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw createFileError("INVALID_REQUEST", `非法媒体 URL：${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createFileError("INVALID_REQUEST", `仅允许 http/https 媒体 URL：${rawUrl}`);
  }
  const reason = isPrivateMediaHost(parsed.hostname);
  if (reason) {
    throw createFileError("MEDIA_HOST_NOT_ALLOWED", `不允许的内网/本地媒体地址：${reason}（${parsed.hostname}）`, { host: parsed.hostname, reason });
  }
  return parsed.toString();
}

export function resolveYtDlpExecutable(): string {
  const fromEnv = process.env.VOID_YTDLP_PATH?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw createFileError("YTDLP_NOT_FOUND", `VOID_YTDLP_PATH 指向的 yt-dlp 不存在：${fromEnv}`, { path: fromEnv });
    return fromEnv;
  }
  for (const c of [join(RUNTIME_BIN, "yt-dlp.exe"), join(RUNTIME_BIN, "yt-dlp")]) if (existsSync(c)) return c;
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

export function resolveFfmpegExecutable(): string {
  const fromEnv = process.env.VOID_FFMPEG_PATH?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw createFileError("FFMPEG_NOT_FOUND", `VOID_FFMPEG_PATH 指向的 ffmpeg 不存在：${fromEnv}`, { path: fromEnv });
    return resolve(fromEnv);
  }
  for (const c of [join(RUNTIME_BIN, "ffmpeg.exe"), join(RUNTIME_BIN, "ffmpeg")]) if (existsSync(c)) return resolve(c);
  throw createFileError("FFMPEG_NOT_FOUND", "媒体下载需要 ffmpeg。请安装后设置 VOID_FFMPEG_PATH，或放到 D:\\AI\\void-runtime\\bin\\ffmpeg.exe", { expectedDir: RUNTIME_BIN });
}

function listNewFiles(dir: string, sinceMs: number): string[] {
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        const s = statSync(p);
        return s.isFile() && s.mtimeMs >= sinceMs - 1000;
      } catch { return false; }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function runYtDlp(input: { executable: string; args: string[]; timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.executable, input.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (err?: Error, res?: { stdout: string; stderr: string; exitCode: number | null }) => {
      if (settled) return; settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err); else resolvePromise(res!);
    };
    const onAbort = () => { try { child.kill(); } catch {} finish(createFileError("DOWNLOAD_FAILED", "媒体下载已取消", { reason: "aborted" })); };
    if (input.signal) {
      if (input.signal.aborted) { onAbort(); return; }
      input.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(createFileError("DOWNLOAD_FAILED", `媒体下载超时（${input.timeoutMs}ms）`, { timeoutMs: input.timeoutMs })); }, input.timeoutMs);
    child.stdout?.on("data", (c: Buffer | string) => { stdout += typeof c === "string" ? c : c.toString("utf8"); if (stdout.length > 200_000) stdout = stdout.slice(-100_000); });
    child.stderr?.on("data", (c: Buffer | string) => { stderr += typeof c === "string" ? c : c.toString("utf8"); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.once("error", (e) => {
      const m = e.message || String(e);
      if (/ENOENT/i.test(m)) finish(createFileError("YTDLP_NOT_FOUND", "未找到 yt-dlp。请安装后加入 PATH，或设置 VOID_YTDLP_PATH，或放到 D:\\AI\\void-runtime\\bin\\yt-dlp.exe", { executable: input.executable }));
      else finish(createFileError("DOWNLOAD_FAILED", `启动 yt-dlp 失败：${m}`, { executable: input.executable }));
    });
    child.once("close", (code) => finish(undefined, { stdout, stderr, exitCode: code }));
  });
}

export class GenericMediaDownloadManager {
  async downloadGenericMedia(input: { taskId: string; pageUrl: string; extractAudio?: boolean; suggestedFileName?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<FileDownloadMediaPageData> {
    const taskId = input.taskId.trim();
    if (!taskId) throw createFileError("INVALID_REQUEST", "taskId 不能为空");
    const pageUrl = assertAllowedGenericMediaUrl(input.pageUrl);
    const executable = resolveYtDlpExecutable();
    const ffmpegPath = resolveFfmpegExecutable();
    const tempDir = taskTempDirectory(taskId);
    const startedAt = Date.now();
    const outputTemplate = join(tempDir, `media_${startedAt}.%(ext)s`);
    const timeoutMs = input.timeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS;
    const args = [
      "--no-playlist", "--no-mtime", "--newline", "--restrict-filenames",
      "-f", "bv*+ba/b/best",
      "--merge-output-format", "mp4",
      "--ffmpeg-location", dirname(ffmpegPath),
      "-o", outputTemplate,
    ];
    if (input.extractAudio) {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
    }
    args.push("--", pageUrl);
    const result = await runYtDlp({ executable, args, timeoutMs, signal: input.signal });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(-1000);
      if (/ffmpeg|ffprobe/i.test(detail) && /not found|not exist|找不到|No such file/i.test(detail)) {
        throw createFileError("FFMPEG_NOT_FOUND", "yt-dlp 需要 ffmpeg，但未找到可用的 ffmpeg", { detail: detail.slice(-400) });
      }
      // yt-dlp 不支持的站点通常 exit 非 0 且 stderr 含 "Unsupported URL" / "No video formats"
      if (/Unsupported URL|No video formats|Video unavailable/i.test(detail)) {
        throw createFileError("SITE_UNSUPPORTED", `该站点或链接暂不支持下载：${detail.slice(0, 300)}`, { pageUrl, detail: detail.slice(0, 400) });
      }
      throw createFileError("DOWNLOAD_FAILED", detail ? `yt-dlp 下载失败（exit ${result.exitCode}）：${detail}` : `yt-dlp 下载失败（exit ${result.exitCode}）`, { exitCode: result.exitCode, pageUrl });
    }
    const candidates = listNewFiles(tempDir, startedAt).filter((p) => basename(p).startsWith(`media_${startedAt}`) || basename(p).includes(String(startedAt)));
    let chosen = candidates[0] || listNewFiles(tempDir, startedAt).find((p) => [".mp4", ".webm", ".mkv", ".flv", ".m4a", ".mp3", ".mp3", ".opus"].includes(extname(p).toLowerCase()));
    if (!chosen || !existsSync(chosen)) throw createFileError("DOWNLOAD_FAILED", "yt-dlp 退出成功但未找到输出文件", { tempDir, pageUrl });
    const stat = statSync(chosen);
    if (stat.size <= 0) { try { unlinkSync(chosen); } catch {} throw createFileError("DOWNLOAD_FAILED", "下载文件为空", { path: chosen }); }
    if (stat.size > MAX_MEDIA_DOWNLOAD_BYTES) { try { unlinkSync(chosen); } catch {} throw createFileError("DOWNLOAD_FAILED", `媒体文件过大（${stat.size} bytes）`, { bytes: stat.size }); }
    const rawBase = input.suggestedFileName?.trim() || basename(chosen);
    const finalName = sanitizeFileName(extname(rawBase) ? rawBase : `${rawBase}${extname(chosen) || ".mp4"}`);
    const finalTempPath = join(tempDir, `${startedAt}_${finalName}`);
    if (resolve(chosen) !== resolve(finalTempPath)) {
      if (existsSync(finalTempPath)) unlinkSync(finalTempPath);
      renameSync(chosen, finalTempPath);
      chosen = finalTempPath;
    }
    const finalStat = statSync(chosen);
    return {
      taskId,
      pageUrl,
      site: new URL(pageUrl).hostname,
      videoId: undefined,
      tempPath: chosen,
      fileName: basename(chosen),
      bytes: finalStat.size,
      mediaKind: guessMediaKind(basename(chosen)),
      downloader: "yt-dlp",
      downloadedAt: Date.now()
    };
  }
}

export const genericMediaDownloadManager = new GenericMediaDownloadManager();
