/**
 * P3-B UIA 后台投递：对已定位控件设值/触发，全程不抢焦点、不动真实光标。
 * 优先 UIA ValuePattern / InvokePattern；原生不支持时走 LegacyIAccessible 兼容桥
 * （仍限定到已定位控件），都不支持则如实报 PATTERN_UNSUPPORTED，
 * 绝不降级为全局 SendInput 盲打。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { listWindows } from "./desktopWindowManager";

const execFileAsync = promisify(execFile);

export type UiaControlSelector = {
  automationId?: string;
  nameContains?: string;
  controlType?: string;
};

export type UiaActedControl = {
  name: string;
  controlType: string;
  automationId: string;
};

const MAX_TEXT_CHARS = 500;

function ensureWindows(): void {
  if (platform() !== "win32") {
    throw Object.assign(new Error("窗口投递当前仅支持 Windows"), { desktopCode: "UNSUPPORTED_PLATFORM" });
  }
}

function escapePsString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildActScript(
  hwnd: string,
  selector: UiaControlSelector,
  action: "set" | "invoke",
  text: string
): string {
  const lines: string[] = [
    "Add-Type -AssemblyName UIAutomationClient",
    "Add-Type -AssemblyName UIAutomationTypes",
    `$targetHwnd = [Int64]${hwnd}`,
    "$root = [System.Windows.Automation.AutomationElement]::RootElement",
    "$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)",
    "$target = $null",
    "foreach ($w in $all) {",
    "  try { if ($w.Current.NativeWindowHandle -eq $targetHwnd) { $target = $w; break } } catch {}",
    "}",
    "if ($null -eq $target) { Write-Output '{\"error\":\"WINDOW_NOT_FOUND\"}'; exit }"
  ];

  const conds: string[] = [];
  if (selector.automationId) {
    conds.push(`($c.Current.AutomationId -eq '${escapePsString(selector.automationId)}')`);
  }
  if (selector.nameContains) {
    conds.push(`($c.Current.Name -like '*${escapePsString(selector.nameContains)}*')`);
  }
  if (selector.controlType) {
    conds.push(`($c.Current.ControlType.ProgrammaticName -like '*${escapePsString(selector.controlType)}*')`);
  }
  const matchExpr = conds.length > 0 ? conds.join(" -and ") : "$true";

  lines.push(
    "$found = $null",
    "function FindCtl($el, $depth) {",
    "  if ($found -ne $null) { return }",
    "  if ($depth -gt 6) { return }",
    "  try { $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }",
    "  foreach ($c in $kids) {",
    `    if (${matchExpr}) { $script:found = $c; return }`,
    "    FindCtl $c ($depth + 1)",
    "    if ($found -ne $null) { return }",
    "  }",
    "}",
    "FindCtl $target 1",
    "if ($null -eq $found) { Write-Output '{\"error\":\"CONTROL_NOT_FOUND\"}'; exit }"
  );

  if (action === "set") {
    lines.push(
      "$acted = $false",
      "try { $vp = $found.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($vp -ne $null) { $vp.SetValue('" + escapePsString(text) + "'); $acted = $true } } catch {}",
      "if (-not $acted) {",
      "  try { $lp = $found.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern); if ($lp -ne $null) { $lp.SetValue('" + escapePsString(text) + "'); $acted = $true } } catch {}",
      "}",
      "if (-not $acted) { Write-Output '{\"error\":\"PATTERN_UNSUPPORTED\"}'; exit }",
      "$res = [pscustomobject]@{ ok = $true; name = [string]$found.Current.Name; controlType = [string]$found.Current.ControlType.ProgrammaticName; automationId = [string]$found.Current.AutomationId }",
      "$res | ConvertTo-Json -Compress"
    );
  } else {
    lines.push(
      "$acted = $false",
      "try { $ip = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); if ($ip -ne $null) { $ip.Invoke(); $acted = $true } } catch {}",
      "if (-not $acted) {",
      "  try { $lp = $found.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern); if ($lp -ne $null) { $lp.DoDefaultAction(); $acted = $true } } catch {}",
      "}",
      "if (-not $acted) { Write-Output '{\"error\":\"PATTERN_UNSUPPORTED\"}'; exit }",
      "$res = [pscustomobject]@{ ok = $true; name = [string]$found.Current.Name; controlType = [string]$found.Current.ControlType.ProgrammaticName; automationId = [string]$found.Current.AutomationId }",
      "$res | ConvertTo-Json -Compress"
    );
  }
  return lines.join("\n");
}

async function runEncoded(script: string, timeoutMs = 20000): Promise<string> {
  const ps = process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    return stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.killed) {
      throw Object.assign(new Error("控件投递超时"), { desktopCode: "TIMEOUT" });
    }
    throw Object.assign(new Error(err.stderr?.trim() || err.message || "投递执行失败"), { desktopCode: "INTERNAL_ERROR" });
  }
}

async function resolveHwnd(input: { hwnd?: string; pid?: number; title?: string }): Promise<{ hwnd: string; pid: number; processName: string; title: string }> {
  const windows = await listWindows();
  const target = input.hwnd
    ? windows.find((w) => w.hwnd === String(input.hwnd).trim())
    : input.pid
      ? windows.find((w) => w.pid === Number(input.pid))
      : undefined;
  const resolved = target ?? (input.title
    ? windows.find((w) => w.title.toLowerCase() === input.title!.trim().toLowerCase())
      ?? windows.find((w) => w.title.toLowerCase().includes(input.title!.trim().toLowerCase()))
    : undefined);
  if (!resolved) {
    throw Object.assign(new Error("未找到匹配窗口"), { desktopCode: "PATH_NOT_FOUND" });
  }
  if (!/^\d+$/.test(resolved.hwnd)) {
    throw Object.assign(new Error("窗口句柄非法"), { desktopCode: "INVALID_REQUEST" });
  }
  return resolved;
}

function parseActOutput(raw: string): UiaActedControl {
  const text = raw.trim();
  if (!text) {
    throw Object.assign(new Error("投递无输出"), { desktopCode: "INTERNAL_ERROR" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("投递输出解析失败"), { desktopCode: "INTERNAL_ERROR" });
  }
  const record = parsed as Record<string, unknown>;
  if (record.error === "WINDOW_NOT_FOUND" || record.error === "CONTROL_NOT_FOUND") {
    throw Object.assign(new Error(record.error === "WINDOW_NOT_FOUND" ? "窗口已关闭或不可访问" : "未找到匹配控件，先用 inspectWindowControls 确认"), { desktopCode: "PATH_NOT_FOUND" });
  }
  if (record.error === "PATTERN_UNSUPPORTED") {
    throw Object.assign(new Error("该控件不支持后台设值/触发（无 Value/Invoke 模式），拒绝盲打"), { desktopCode: "INVALID_REQUEST" });
  }
  return {
    name: String(record.name ?? ""),
    controlType: String(record.controlType ?? "").replace("ControlType.", ""),
    automationId: String(record.automationId ?? "")
  };
}

export async function setControlText(input: {
  hwnd?: string;
  pid?: number;
  title?: string;
  control: UiaControlSelector;
  text: string;
}): Promise<UiaActedControl & { hwnd: string }> {
  ensureWindows();
  const text = (input.text ?? "").trim();
  if (!text) {
    throw Object.assign(new Error("text 不能为空"), { desktopCode: "INVALID_REQUEST" });
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw Object.assign(new Error(`text 不得超过 ${MAX_TEXT_CHARS} 字`), { desktopCode: "INVALID_REQUEST" });
  }
  const selector = input.control ?? {};
  if (!selector.automationId && !selector.nameContains && !selector.controlType) {
    throw Object.assign(new Error("control 至少指定 automationId/nameContains/controlType 之一"), { desktopCode: "INVALID_REQUEST" });
  }
  const window = await resolveHwnd(input);
  const raw = await runEncoded(buildActScript(window.hwnd, selector, "set", text));
  return { ...parseActOutput(raw), hwnd: window.hwnd };
}

export async function invokeControl(input: {
  hwnd?: string;
  pid?: number;
  title?: string;
  control: UiaControlSelector;
}): Promise<UiaActedControl & { hwnd: string }> {
  ensureWindows();
  const selector = input.control ?? {};
  if (!selector.automationId && !selector.nameContains && !selector.controlType) {
    throw Object.assign(new Error("control 至少指定 automationId/nameContains/controlType 之一"), { desktopCode: "INVALID_REQUEST" });
  }
  const window = await resolveHwnd(input);
  const raw = await runEncoded(buildActScript(window.hwnd, selector, "invoke", ""));
  return { ...parseActOutput(raw), hwnd: window.hwnd };
}

export const UIA_ACT_LIMITS = { maxTextChars: MAX_TEXT_CHARS } as const;
