import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

const SCREENSHOT_ROOT = "D:\\AI\\void-runtime\\desktop-screenshots";
/** 单张截图回传上限：防止把超大图塞进模型请求体。 */
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;

function ensureWindows(): void {
  if (platform() !== "win32") {
    throw Object.assign(new Error("桌面截图当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
}

function ensureRoot(): void {
  if (!existsSync(SCREENSHOT_ROOT)) {
    mkdirSync(SCREENSHOT_ROOT, { recursive: true });
  }
}

export async function takeDesktopScreenshot(): Promise<{ path: string; width: number; height: number; capturedAt: number }> {
  ensureWindows();
  ensureRoot();
  const fileName = `desktop-${Date.now()}.png`;
  const outPath = join(SCREENSHOT_ROOT, fileName);
  // PowerShell: CopyFromScreen to PNG, limit to 1280x800 if larger (avoid 4K huge)
  const script = `
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $w = $bounds.Width; $h = $bounds.Height
    # 限制最大 1920x1080，避免 4K 过大
    $maxW = 1920; $maxH = 1080
    if ($w -gt $maxW -or $h -gt $maxH) { $w = [Math]::Min($w, $maxW); $h = [Math]::Min($h, $maxH) }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(0,0,0,0,$bmp.Size)
    $bmp.Save("${outPath.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "$w,$h"
  `;
  const ps = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
  try {
    const { stdout } = await execFileAsync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    const raw = stdout.trim().split("\n").pop()?.trim() ?? "";
    const [wStr, hStr] = raw.split(",");
    const width = Number(wStr) || 0;
    const height = Number(hStr) || 0;
    if (!existsSync(outPath)) {
      throw new Error("截图文件未生成");
    }
    return { path: outPath, width, height, capturedAt: Date.now() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.killed) throw Object.assign(new Error("截图超时"), { desktopCode: "TIMEOUT" });
    throw Object.assign(new Error(err.stderr?.trim() || err.message || "截图失败"), { desktopCode: "INTERNAL_ERROR" });
  }
}

/**
 * 读取截图目录内的 PNG 并转 base64，供「看屏」把画面交给视觉模型。
 *
 * 安全边界：只允许读取 `SCREENSHOT_ROOT` 内的 `.png`，拒绝目录穿越与任意文件读取；
 * 该端点是只读的，不产生新文件。
 */
export function readScreenshotImage(inputPath: string): {
  path: string;
  mediaType: string;
  dataBase64: string;
  bytes: number;
} {
  const trimmed = typeof inputPath === "string" ? inputPath.trim() : "";
  if (!trimmed) {
    throw Object.assign(new Error("缺少 path"), { desktopCode: "INVALID_REQUEST" });
  }

  const rootResolved = resolve(SCREENSHOT_ROOT);
  const targetResolved = resolve(trimmed);
  const insideRoot = targetResolved === rootResolved || targetResolved.startsWith(rootResolved + sep);
  if (!insideRoot) {
    throw Object.assign(new Error("只允许读取截图目录内的文件"), { desktopCode: "PATH_NOT_ALLOWED" });
  }
  if (!targetResolved.toLowerCase().endsWith(".png")) {
    throw Object.assign(new Error("只允许读取 PNG 截图"), { desktopCode: "UNSUPPORTED_MEDIA" });
  }

  let size = 0;
  try {
    size = statSync(targetResolved).size;
  } catch {
    throw Object.assign(new Error("截图文件不存在"), { desktopCode: "PATH_NOT_FOUND" });
  }
  if (size > MAX_SCREENSHOT_BYTES) {
    throw Object.assign(new Error("截图超过回传上限"), { desktopCode: "TOO_LARGE" });
  }

  const buffer = readFileSync(targetResolved);
  return {
    path: targetResolved,
    mediaType: "image/png",
    dataBase64: buffer.toString("base64"),
    bytes: buffer.length
  };
}
