import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

const SCREENSHOT_ROOT = "D:\\AI\\void-runtime\\desktop-screenshots";

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
