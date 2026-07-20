/**
 * 官方软件安装包安全下载核心。
 * - HTTPS + 域名白名单 + 解析后公网 IP 校验
 * - .part 流式写入 + 大小上限 + 总超时
 * - PE/MSI 魔数（含 PE 签名位）
 * - SHA-256（摘要回传；目录未登记期望哈希时不伪称「校验通过」）
 * - Windows Authenticode：必须 Valid，路径经 -File/-ArgumentList 传入，禁止拼进脚本源码
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  assertAllowedDestinationDirectory,
  createFileError,
  ensureRuntimeDirectories,
  isPathInsideRoot,
  listAllowedDownloadRoots,
  resolveDownloadFinalRoot,
  resolveDownloadTempRoot
} from "../file/fileRuntimePaths";
import type { SoftwareCatalogEntry } from "./softwareCatalog";

const execFileAsync = promisify(execFile);

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** 整次下载（含校验）硬超时，防止挂死 */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
/** 单次 HTTP 请求超时 */
const HTTP_REQUEST_TIMEOUT_MS = 60_000;

export type SoftwareDownloadResult = {
  softwareId: string;
  finalPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  sourcePageUrl: string;
  finalDownloadUrl: string;
  contentType?: string;
  /** 成功落盘时 Windows 上必为 valid */
  signatureStatus: "valid";
  publisher?: string;
  downloadedAt: number;
};

/** taskId / 文件名片段：只允许安全字符，杜绝路径与 PowerShell 元字符 */
function sanitizeToken(raw: string, fallback: string): string {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

function sanitizeFileName(raw: string): string {
  const base = basename(String(raw || "").replace(/\\/g, "/"));
  const cleaned = base
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32) return "_";
      if ('<>:"/\\|?*`$(){};&|'.includes(char)) return "_";
      return char;
    })
    .join("")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return `installer_${Date.now()}.bin`;
  }
  return cleaned.slice(0, 160);
}

function hostAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase().replace(/^\./, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

/**
 * 拒绝非公网地址（字面量 + 常见私网/链路本地/元数据）。
 * DNS 解析后再次调用，降低 SSRF。
 */
function isBlockedIpLiteral(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "0.0.0.0") return true;
  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6 粗粒度
  if (v.startsWith("fc") || v.startsWith("fd")) return true; // ULA
  if (v.startsWith("fe80")) return true; // link-local
  if (v === "::" || v.startsWith("::ffff:127.")) return true;
  if (v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.")) return true;
  return false;
}

async function assertHostnameResolvesPublic(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host)) {
    if (isBlockedIpLiteral(host)) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        `拒绝非公网地址：${host}`,
        { failureCode: "DOWNLOAD_REDIRECT_NOT_ALLOWED" }
      );
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `无法解析主机：${host}`,
      { failureCode: "OFFICIAL_SOURCE_UNAVAILABLE" }
    );
  }
  if (!records.length) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `主机无解析结果：${host}`,
      { failureCode: "OFFICIAL_SOURCE_UNAVAILABLE" }
    );
  }
  for (const record of records) {
    if (isBlockedIpLiteral(record.address)) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        `拒绝解析到非公网地址：${host} → ${record.address}`,
        { failureCode: "DOWNLOAD_REDIRECT_NOT_ALLOWED", ip: record.address }
      );
    }
  }
}

async function assertPublicHttpUrl(
  urlText: string,
  allowedDomains: string[]
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    throw createFileError("INVALID_REQUEST", `非法 URL：${urlText}`);
  }
  if (parsed.protocol !== "https:") {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `官方安装包仅允许 HTTPS：${urlText}`,
      { failureCode: "DOWNLOAD_REDIRECT_NOT_ALLOWED" }
    );
  }
  if (
    parsed.hostname === "localhost"
    || parsed.hostname.endsWith(".local")
    || parsed.hostname.endsWith(".localhost")
  ) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `拒绝本机地址：${parsed.hostname}`,
      { failureCode: "DOWNLOAD_REDIRECT_NOT_ALLOWED" }
    );
  }
  if (!hostAllowed(parsed.hostname, allowedDomains)) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `域名不在该软件官方下载白名单：${parsed.hostname}`,
      { failureCode: "DOWNLOAD_REDIRECT_NOT_ALLOWED", host: parsed.hostname }
    );
  }
  await assertHostnameResolvesPublic(parsed.hostname);
  return parsed;
}

async function cancelBody(response: Response | null | undefined) {
  try {
    await response?.body?.cancel();
  } catch {
    // ignore
  }
}

/**
 * 手动跟随重定向，每跳校验域名白名单与解析 IP；带超时；释放中间响应体。
 */
export async function fetchWithDomainGuard(
  startUrl: string,
  allowedDomains: string[],
  options?: {
    method?: "GET" | "HEAD";
    maxRedirects?: number;
    signal?: AbortSignal;
  }
): Promise<{ response: Response; finalUrl: string; redirectChain: string[] }> {
  const maxRedirects = options?.maxRedirects ?? 8;
  let current = (await assertPublicHttpUrl(startUrl, allowedDomains)).toString();
  const redirectChain: string[] = [current];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options?.signal?.aborted) {
      throw createFileError("DOWNLOAD_FAILED", "下载已取消", {
        failureCode: "OFFICIAL_SOURCE_UNAVAILABLE"
      });
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), HTTP_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(current, {
        method: options?.method ?? "GET",
        redirect: "manual",
        headers: { "User-Agent": DEFAULT_USER_AGENT },
        signal: controller.signal
      });
    } catch (error) {
      throw createFileError(
        "DOWNLOAD_FAILED",
        error instanceof Error ? `请求失败：${error.message}` : "请求失败",
        { failureCode: "OFFICIAL_SOURCE_UNAVAILABLE", url: current }
      );
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location) {
        throw createFileError(
          "DOWNLOAD_FAILED",
          `重定向缺少 Location（HTTP ${response.status}）`,
          { url: current }
        );
      }
      const next = new URL(location, current).toString();
      await assertPublicHttpUrl(next, allowedDomains);
      redirectChain.push(next);
      current = next;
      continue;
    }

    return { response, finalUrl: current, redirectChain };
  }

  throw createFileError("DOWNLOAD_FAILED", "重定向次数过多", { startUrl });
}

function readFileHead(filePath: string, length: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

/**
 * 严格安装包魔数：
 * - EXE：MZ + e_lfanew 处 PE\0\0
 * - MSI：完整 8 字节 OLE 复合文档头
 */
function detectInstallerMagic(filePath: string): "exe" | "msi" | "unknown" {
  const head = readFileHead(filePath, 512);
  // MSI: D0 CF 11 E0 A1 B1 1A E1
  if (
    head.length >= 8
    && head[0] === 0xd0
    && head[1] === 0xcf
    && head[2] === 0x11
    && head[3] === 0xe0
    && head[4] === 0xa1
    && head[5] === 0xb1
    && head[6] === 0x1a
    && head[7] === 0xe1
  ) {
    return "msi";
  }
  // PE: MZ
  if (head.length >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
    const eLfanew = head.readUInt32LE(0x3c);
    if (eLfanew + 4 <= head.length) {
      if (
        head[eLfanew] === 0x50
        && head[eLfanew + 1] === 0x45
        && head[eLfanew + 2] === 0x00
        && head[eLfanew + 3] === 0x00
      ) {
        return "exe";
      }
    } else if (eLfanew > 0 && eLfanew < 4 * 1024 * 1024) {
      // e_lfanew 超出 head：再读一次定点
      try {
        const fd = openSync(filePath, "r");
        try {
          const pe = Buffer.alloc(4);
          const n = readSync(fd, pe, 0, 4, eLfanew);
          if (
            n === 4
            && pe[0] === 0x50
            && pe[1] === 0x45
            && pe[2] === 0x00
            && pe[3] === 0x00
          ) {
            return "exe";
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        return "unknown";
      }
    }
  }
  return "unknown";
}

function looksLikeHtml(filePath: string, contentType?: string): boolean {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("text/html") || type.includes("application/json")) {
    return true;
  }
  const head = readFileHead(filePath, 256).toString("utf8").toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function assertTempPathSafe(filePath: string): string {
  const safePath = resolve(filePath);
  const tempRoot = resolve(resolveDownloadTempRoot());
  if (!isPathInsideRoot(safePath, tempRoot)) {
    throw createFileError(
      "PATH_NOT_ALLOWED",
      "签名校验路径不在临时目录",
      { path: safePath, tempRoot }
    );
  }
  // 拒绝符号链接目标文件
  try {
    const st = lstatSync(safePath);
    if (st.isSymbolicLink()) {
      throw createFileError("PATH_NOT_ALLOWED", "拒绝校验符号链接文件");
    }
  } catch (error) {
    if (typeof error === "object" && error && "fileCode" in error) {
      throw error;
    }
    throw createFileError("FILE_NOT_FOUND", `临时文件不存在：${safePath}`);
  }
  return safePath;
}

/**
 * Windows Authenticode：路径通过独立参数传入，禁止拼进 -Command 字符串。
 * 非 Windows / 非 Valid / 调用失败 → 一律失败（调用方负责删临时文件）。
 */
async function verifyAuthenticode(filePath: string): Promise<{
  status: "valid";
  publisher?: string;
  detail?: string;
}> {
  if (process.platform !== "win32") {
    throw createFileError(
      "DOWNLOAD_FAILED",
      "官方安装包下载仅在 Windows 上执行 Authenticode 校验；当前平台禁止落盘",
      { failureCode: "SIGNATURE_INVALID", platform: process.platform }
    );
  }

  const safePath = assertTempPathSafe(filePath);
  const tempRoot = resolve(resolveDownloadTempRoot());
  const scriptPath = join(
    tempRoot,
    `_auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`
  );

  // 脚本只读 $args[0]，路径不进脚本源码
  const scriptBody = [
    "$ErrorActionPreference = 'Stop'",
    "if ($args.Count -lt 1) { throw 'missing path' }",
    "$p = [string]$args[0]",
    "$s = Get-AuthenticodeSignature -LiteralPath $p",
    "$pub = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }",
    "Write-Output (($s.Status.ToString()) + '|' + $pub)"
  ].join("\r\n");

  try {
    writeFileSync(scriptPath, scriptBody, { encoding: "utf8" });
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        safePath
      ],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const [statusRaw, publisher = ""] = line.split("|");
    const status = (statusRaw || "").trim();
    if (status === "Valid") {
      return {
        status: "valid",
        publisher: publisher.trim() || undefined
      };
    }
    throw createFileError(
      "DOWNLOAD_FAILED",
      `安装包签名无效：Authenticode 状态=${status || "unknown"}`,
      {
        failureCode: "SIGNATURE_INVALID",
        publisher: publisher.trim() || undefined
      }
    );
  } catch (error) {
    if (typeof error === "object" && error && "fileCode" in error) {
      throw error;
    }
    throw createFileError(
      "DOWNLOAD_FAILED",
      error instanceof Error
        ? `Authenticode 校验失败：${error.message}`
        : "Authenticode 校验失败",
      { failureCode: "SIGNATURE_INVALID" }
    );
  } finally {
    try {
      if (existsSync(scriptPath)) unlinkSync(scriptPath);
    } catch {
      // ignore
    }
  }
}

/** 从 Subject 抽出 CN= / O= 字段做规范化精确比较（不再 substring 整串） */
function extractSubjectFields(subject: string): string[] {
  const fields: string[] = [];
  for (const part of subject.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().toUpperCase();
    const value = trimmed.slice(eq + 1).trim();
    if ((key === "CN" || key === "O") && value) {
      fields.push(value);
    }
  }
  if (!fields.length && subject.trim()) {
    fields.push(subject.trim());
  }
  return fields;
}

function normalizePublisherToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/["'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function publisherMatches(
  publisher: string | undefined,
  expected: string[]
): boolean {
  if (!expected.length) {
    // 目录未登记发布者：仅依赖 Authenticode Valid
    return true;
  }
  if (!publisher) {
    return false;
  }
  const fields = extractSubjectFields(publisher).map(normalizePublisherToken);
  const expectedNorm = expected.map(normalizePublisherToken).filter(Boolean);
  // 精确匹配 CN/O；允许「字段等于期望」或「字段为期望的完整词边界包含」避免 substring 误放行
  return expectedNorm.some((item) =>
    fields.some((field) => {
      if (field === item) return true;
      // 仅当期望本身足够长，且以独立片段出现（前后非字母数字）
      if (item.length < 3) return false;
      const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(field);
    })
  );
}

function taskTempDirectory(taskId: string): string {
  const safeTask = sanitizeToken(taskId, `task_${Date.now()}`);
  const dir = join(resolveDownloadTempRoot(), safeTask);
  mkdirSync(dir, { recursive: true });
  // 创建后 realpath 必须仍在 temp 根下
  let realDir = dir;
  try {
    realDir = realpathSync(dir);
  } catch {
    realDir = resolve(dir);
  }
  if (!isPathInsideRoot(realDir, resolveDownloadTempRoot())) {
    throw createFileError(
      "PATH_NOT_ALLOWED",
      "任务临时目录不在允许的临时根下"
    );
  }
  return realDir;
}

function resolveUniquePath(directory: string, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  const first = join(directory, safeName);
  if (!existsSync(first)) {
    return first;
  }
  const ext = extname(safeName);
  const stem = basename(safeName, ext);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = join(directory, `${stem}_${index}${ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  throw createFileError("MOVE_FAILED", "无法生成不冲突的文件名");
}

function safeUnlink(path: string | undefined) {
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}

export async function downloadOfficialInstaller(input: {
  taskId: string;
  entry: SoftwareCatalogEntry;
  downloadUrl: string;
  sourcePageUrl: string;
  suggestedFileName?: string;
  destinationDirectory?: string;
  overwritePolicy?: "refuse" | "rename";
  signal?: AbortSignal;
}): Promise<SoftwareDownloadResult> {
  ensureRuntimeDirectories();
  const taskId = sanitizeToken(input.taskId, "");
  if (!taskId) {
    throw createFileError("INVALID_REQUEST", "taskId 不能为空或含非法字符");
  }

  if (process.platform !== "win32") {
    throw createFileError(
      "DOWNLOAD_FAILED",
      "官方安装包安全下载当前仅支持 Windows",
      { failureCode: "SIGNATURE_INVALID" }
    );
  }

  const maxBytes = input.entry.maxDownloadBytes;
  const allowed = input.entry.allowedDownloadDomains;
  await assertPublicHttpUrl(input.downloadUrl, allowed);

  const totalController = new AbortController();
  const external = input.signal;
  const onExternalAbort = () => totalController.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const totalTimer = setTimeout(
    () => totalController.abort(),
    DOWNLOAD_TOTAL_TIMEOUT_MS
  );

  let partPath = "";
  let completeTempPath = "";
  let response: Response | null = null;

  try {
    let fetchResult: { response: Response; finalUrl: string; redirectChain: string[] };
    try {
      fetchResult = await fetchWithDomainGuard(input.downloadUrl, allowed, {
        signal: totalController.signal
      });
    } catch (error) {
      if (typeof error === "object" && error && "fileCode" in error) {
        throw error;
      }
      throw createFileError(
        "DOWNLOAD_FAILED",
        error instanceof Error ? `下载失败：${error.message}` : "下载失败",
        { failureCode: "OFFICIAL_SOURCE_UNAVAILABLE" }
      );
    }

    response = fetchResult.response;
    const finalUrl = fetchResult.finalUrl;

    if (!response.ok) {
      await cancelBody(response);
      throw createFileError("DOWNLOAD_FAILED", `下载 HTTP ${response.status}`, {
        url: finalUrl,
        status: response.status
      });
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await cancelBody(response);
        throw createFileError(
          "FILE_TOO_LARGE",
          `文件过大（${contentLength} bytes），超过该软件上限 ${maxBytes}`,
          { failureCode: "FILE_TOO_LARGE", contentLength }
        );
      }
    }

    const tempDir = taskTempDirectory(taskId);
    const suggested =
      sanitizeFileName(input.suggestedFileName || "")
      || sanitizeFileName(basename(new URL(finalUrl).pathname))
      || `installer_${Date.now()}.exe`;
    partPath = join(tempDir, `${Date.now()}_${suggested}.part`);
    completeTempPath = join(tempDir, `${Date.now()}_${suggested}`);

    if (!response.body) {
      throw createFileError("DOWNLOAD_FAILED", "响应无正文", { url: finalUrl });
    }

    const nodeStream = Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream
    );
    let written = 0;
    nodeStream.on("data", (chunk: Buffer | string) => {
      written += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (written > maxBytes) {
        nodeStream.destroy(
          createFileError("FILE_TOO_LARGE", `下载中止：超过上限 ${maxBytes} bytes`, {
            failureCode: "FILE_TOO_LARGE"
          })
        );
      }
    });
    totalController.signal.addEventListener(
      "abort",
      () => {
        nodeStream.destroy(
          createFileError("DOWNLOAD_FAILED", "下载超时或已取消", {
            failureCode: "OFFICIAL_SOURCE_UNAVAILABLE"
          })
        );
      },
      { once: true }
    );

    try {
      await pipeline(nodeStream, createWriteStream(partPath));
    } catch (error) {
      safeUnlink(partPath);
      if (typeof error === "object" && error && "fileCode" in error) {
        throw error;
      }
      throw createFileError(
        "DOWNLOAD_FAILED",
        error instanceof Error ? error.message : "写入临时文件失败",
        { url: finalUrl }
      );
    }

    try {
      renameSync(partPath, completeTempPath);
      partPath = "";
    } catch {
      safeUnlink(partPath);
      throw createFileError("DOWNLOAD_FAILED", "无法完成临时文件落盘");
    }

    if (looksLikeHtml(completeTempPath, contentType)) {
      safeUnlink(completeTempPath);
      throw createFileError(
        "DOWNLOAD_FAILED",
        "下载结果是网页/错误页，不是安装包",
        { failureCode: "HTML_INSTEAD_OF_INSTALLER", url: finalUrl }
      );
    }

    const magic = detectInstallerMagic(completeTempPath);
    if (magic === "unknown") {
      safeUnlink(completeTempPath);
      throw createFileError(
        "DOWNLOAD_FAILED",
        "文件魔数不是有效的 PE/MSI 安装包",
        { failureCode: "HTML_INSTEAD_OF_INSTALLER", url: finalUrl }
      );
    }

    const sha256 = await sha256File(completeTempPath);
    const signature = await verifyAuthenticode(completeTempPath);

    if (!publisherMatches(signature.publisher, input.entry.expectedPublisherNames)) {
      safeUnlink(completeTempPath);
      throw createFileError(
        "DOWNLOAD_FAILED",
        `发布者不匹配：${signature.publisher || "unknown"}`,
        {
          failureCode: "PUBLISHER_MISMATCH",
          publisher: signature.publisher,
          expected: input.entry.expectedPublisherNames
        }
      );
    }

    const destinationDirectory = assertAllowedDestinationDirectory(
      input.destinationDirectory?.trim() || resolveDownloadFinalRoot()
    );
    mkdirSync(destinationDirectory, { recursive: true });

    // 创建后 realpath，拒绝 junction/symlink 逃逸
    let realDestination = destinationDirectory;
    try {
      realDestination = realpathSync(destinationDirectory);
    } catch {
      realDestination = resolve(destinationDirectory);
    }
    assertAllowedDestinationDirectory(realDestination);

    const finalFileName = sanitizeFileName(suggested);
    let finalPath = join(realDestination, finalFileName);
    if (existsSync(finalPath)) {
      if (input.overwritePolicy === "refuse") {
        safeUnlink(completeTempPath);
        throw createFileError("OVERWRITE_REFUSED", `目标已存在：${finalPath}`);
      }
      finalPath = resolveUniquePath(realDestination, finalFileName);
    }

    // 最终路径必须仍在白名单根内
    if (!listAllowedDownloadRoots().some((root) => isPathInsideRoot(finalPath, root))) {
      safeUnlink(completeTempPath);
      throw createFileError(
        "PATH_NOT_ALLOWED",
        `最终路径不在白名单：${finalPath}`
      );
    }

    try {
      renameSync(completeTempPath, finalPath);
      completeTempPath = "";
    } catch (error) {
      // 跨卷时 rename 可能失败：尝试 copy+unlink 不安全处不开放；直接失败
      safeUnlink(completeTempPath);
      throw createFileError(
        "MOVE_FAILED",
        `移动到最终目录失败：${finalPath}${
          error instanceof Error ? `（${error.message}）` : ""
        }`
      );
    }

    const stat = statSync(finalPath);
    return {
      softwareId: input.entry.softwareId,
      finalPath,
      fileName: basename(finalPath),
      bytes: stat.size,
      sha256,
      sourcePageUrl: input.sourcePageUrl,
      finalDownloadUrl: finalUrl,
      contentType,
      signatureStatus: "valid",
      publisher: signature.publisher,
      downloadedAt: Date.now()
    };
  } finally {
    clearTimeout(totalTimer);
    external?.removeEventListener("abort", onExternalAbort);
    safeUnlink(partPath);
    safeUnlink(completeTempPath);
  }
}
