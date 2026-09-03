/**
 * P3-A UIA 只读探针：枚举目标窗口的控件树（名称/类型/矩形），不投递任何输入。
 * Windows UIAutomationClient 为系统自带，无 npm 依赖；复杂脚本走 -EncodedCommand 避免引号转义。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { listWindows } from "./desktopWindowManager";

const execFileAsync = promisify(execFile);

export type UiaControlInfo = {
  name: string;
  controlType: string;
  automationId: string;
  depth: number;
  rect: { x: number; y: number; width: number; height: number };
};

export type UiaInspectResult = {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
  controls: UiaControlInfo[];
  truncated: boolean;
  inspectedAt: number;
};

const MAX_DEPTH = 5;
const MAX_CONTROLS = 80;

function ensureWindows(): void {
  if (platform() !== "win32") {
    throw Object.assign(new Error("窗口控件探针当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
}

function buildProbeScript(hwnd: string, maxDepth: number, maxControls: number): string {
  return [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    `$targetHwnd = [Int64]${hwnd}`,
    `$maxDepth = ${maxDepth}`,
    `$maxControls = ${maxControls}`,
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)",
    "$target = $null",
    "foreach ($w in $all) {",
    "  try { if ($w.Current.NativeWindowHandle -eq $targetHwnd) { $target = $w; break } } catch {}",
    "}",
    "if ($null -eq $target) { Write-Output '{\"error\":\"WINDOW_NOT_FOUND\"}'; exit }",
    "$out = New-Object System.Collections.Generic.List[object]",
    "function Visit($el, $depth) {",
    "  if ($out.Count -ge $maxControls) { return }",
    "  if ($depth -gt $maxDepth) { return }",
    "  try { $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }",
    "  foreach ($k in $kids) {",
    "    if ($out.Count -ge $maxControls) { break }",
    "    try {",
    "      $r = $k.Current.BoundingRectangle",
    "      $out.Add([pscustomobject]@{",
    "        name = [string]$k.Current.Name",
    "        controlType = [string]$k.Current.ControlType.ProgrammaticName",
    "        automationId = [string]$k.Current.AutomationId",
    "        depth = $depth",
    "        x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height",
    "      })",
    "    } catch {}",
    "    Visit $k ($depth + 1)",
    "  }",
    "}",
    "Visit $target 1",
    "$out | ConvertTo-Json -Compress -Depth 3"
  ].join("\n");
}

async function runEncoded(script: string, timeoutMs = 15000): Promise<string> {
  const ps = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.killed) {
      throw Object.assign(new Error("控件探针超时"), { desktopCode: "TIMEOUT" });
    }
    throw Object.assign(new Error(err.stderr?.trim() || err.message || "探针执行失败"), { desktopCode: "INTERNAL_ERROR" });
  }
}

export async function inspectWindowControls(input: {
  hwnd?: string;
  pid?: number;
  title?: string;
  depth?: number;
  limit?: number;
}): Promise<UiaInspectResult> {
  ensureWindows();
  const windows = await listWindows();
  let target = input.hwnd
    ? windows.find((w) => w.hwnd === String(input.hwnd).trim())
    : input.pid
      ? windows.find((w) => w.pid === Number(input.pid))
      : undefined;
  if (!target && input.title) {
    const q = input.title.trim().toLowerCase();
    target = windows.find((w) => w.title.toLowerCase() === q)
      ?? windows.find((w) => w.title.toLowerCase().includes(q));
  }
  if (!target) {
    throw Object.assign(new Error("未找到匹配窗口"), { desktopCode: "PATH_NOT_FOUND" });
  }
  if (!/^\d+$/.test(target.hwnd)) {
    throw Object.assign(new Error("窗口句柄非法"), { desktopCode: "INVALID_REQUEST" });
  }

  const depth = Math.min(Math.max(Math.floor(input.depth ?? 2), 1), MAX_DEPTH);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 40), 1), MAX_CONTROLS);

  const raw = (await runEncoded(buildProbeScript(target.hwnd, depth, limit))).trim();
  if (!raw) {
    return { ...target, controls: [], truncated: false, inspectedAt: Date.now() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("探针输出解析失败"), { desktopCode: "INTERNAL_ERROR" });
  }
  if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
    throw Object.assign(new Error("窗口已关闭或不可访问"), { desktopCode: "PATH_NOT_FOUND" });
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const controls: UiaControlInfo[] = [];
  for (const item of arr as Array<Record<string, unknown>>) {
    if (controls.length >= limit) break;
    const rect = {
      x: Number(item.x ?? 0),
      y: Number(item.y ?? 0),
      width: Number(item.width ?? 0),
      height: Number(item.height ?? 0)
    };
    controls.push({
      name: String(item.name ?? ""),
      controlType: String(item.controlType ?? "").replace("ControlType.", ""),
      automationId: String(item.automationId ?? ""),
      depth: Number(item.depth ?? 1),
      rect
    });
  }
  return {
    ...target,
    controls,
    truncated: arr.length > controls.length || controls.length >= limit,
    inspectedAt: Date.now()
  };
}
