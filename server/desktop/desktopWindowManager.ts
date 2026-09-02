import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

export type DesktopWindowInfo = {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
};

function ensureWindows(): void {
  if (platform() !== "win32") {
    throw Object.assign(new Error("窗口管理当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
}

async function runPowerShell(script: string, timeoutMs = 8000): Promise<string> {
  const ps = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  try {
    const { stdout } = await execFileAsync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    if (err.killed) {
      throw Object.assign(new Error("窗口操作超时"), { desktopCode: "TIMEOUT" });
    }
    throw Object.assign(new Error(err.stderr?.trim() || err.message || "PowerShell 执行失败"), { desktopCode: "INTERNAL_ERROR" });
  }
}

export async function listWindows(): Promise<DesktopWindowInfo[]> {
  ensureWindows();
  const script = `
    $list = Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id, ProcessName, MainWindowTitle, @{N='Hwnd';E={$_.MainWindowHandle.ToInt64()}};
    $list | ConvertTo-Json -Compress
  `;
  const raw = (await runPowerShell(script)).trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: DesktopWindowInfo[] = [];
  for (const item of arr as Array<Record<string, unknown>>) {
    const hwnd = String((item.Hwnd ?? item.MainWindowHandle ?? item.hwnd ?? "")).trim();
    const pid = Number(item.Id ?? item.pid ?? 0);
    const processName = String(item.ProcessName ?? item.processName ?? "").trim();
    const title = String(item.MainWindowTitle ?? item.title ?? "").trim();
    if (!hwnd || hwnd === "0" || !title) continue;
    out.push({ hwnd, pid, processName, title });
    if (out.length >= 80) break;
  }
  return out;
}

export async function focusWindow(input: { hwnd?: string; pid?: number; title?: string }): Promise<DesktopWindowInfo> {
  ensureWindows();
  const windows = await listWindows();
  let target: DesktopWindowInfo | undefined;
  if (input.hwnd) {
    target = windows.find((w) => w.hwnd === String(input.hwnd).trim());
  } else if (input.pid) {
    target = windows.find((w) => w.pid === Number(input.pid));
  } else if (input.title) {
    const q = input.title.trim().toLowerCase();
    target = windows.find((w) => w.title.toLowerCase() === q) ?? windows.find((w) => w.title.toLowerCase().includes(q));
  }
  if (!target) {
    throw Object.assign(new Error("未找到匹配窗口"), { desktopCode: "PATH_NOT_FOUND" });
  }
  const script = `
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); }
"@
    $hwnd = [IntPtr]${target.hwnd}
    if ([WinAPI]::IsIconic($hwnd)) { [void][WinAPI]::ShowWindow($hwnd, 9) }
    [void][WinAPI]::SetForegroundWindow($hwnd)
    "ok"
  `;
  await runPowerShell(script);
  return target;
}

export async function closeWindow(input: { hwnd?: string; pid?: number; title?: string }): Promise<{ closed: boolean; pid: number; title: string }> {
  ensureWindows();
  const windows = await listWindows();
  let target: DesktopWindowInfo | undefined;
  if (input.hwnd) {
    target = windows.find((w) => w.hwnd === String(input.hwnd).trim());
  } else if (input.pid) {
    target = windows.find((w) => w.pid === Number(input.pid));
  } else if (input.title) {
    const q = input.title.trim().toLowerCase();
    target = windows.find((w) => w.title.toLowerCase() === q) ?? windows.find((w) => w.title.toLowerCase().includes(q));
  }
  if (!target) {
    throw Object.assign(new Error("未找到匹配窗口"), { desktopCode: "PATH_NOT_FOUND" });
  }
  const script = `
    $p = Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue
    if ($null -ne $p) { $p.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 800; if (!$p.HasExited) { Stop-Process -Id ${target.pid} -Force -ErrorAction SilentlyContinue } }
    "ok"
  `;
  await runPowerShell(script, 10000);
  return { closed: true, pid: target.pid, title: target.title };
}

export async function getSystemInfo(): Promise<{ platform: string; arch: string; totalMemMb: number; freeMemMb: number; cpus: number; screen?: { width: number; height: number } }> {
  const os = await import("node:os");
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  let screen: { width: number; height: number } | undefined;
  if (platform() === "win32") {
    try {
      const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Select-Object Width,Height | ConvertTo-Json -Compress`;
      const raw = (await runPowerShell(script, 5000)).trim();
      const parsed = JSON.parse(raw) as { Width: number; Height: number };
      if (parsed?.Width && parsed?.Height) screen = { width: parsed.Width, height: parsed.Height };
    } catch {}
  }
  return {
    platform: platform(),
    arch: os.arch(),
    totalMemMb,
    freeMemMb,
    cpus: os.cpus().length,
    screen
  };
}
