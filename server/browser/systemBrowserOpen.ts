/**
 * 用操作系统默认/常用浏览器打开 URL（给用户看，不是 Playwright 自动化窗）。
 * Windows 走 PowerShell Start-Process；macOS open；Linux xdg-open。
 *
 * 历史：曾用 cmd /c start "" <url>，URL 中的 & % ^ 会被 cmd 解释截断（open 库官方亦已弃用 start）。
 * 现改为 PowerShell Start-Process，单引号包裹 URL，按 PowerShell 规则转义。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 仅允许 http(s)，防止 file: / javascript: 等被系统打开。
 */
export function assertPublicHttpUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效 URL：${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅允许 http/https 链接");
  }
  return parsed.toString();
}

/**
 * 把 URL 安全嵌入 PowerShell 单引号字符串。
 * PowerShell 单引号内唯一特殊字符是单引号本身，用 '' 转义。
 */
function escapeForPowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * 在用户系统浏览器中打开链接（异步、不等待浏览器退出）。
 */
export async function openUrlInSystemBrowser(url: string): Promise<{ openedUrl: string }> {
  const openedUrl = assertPublicHttpUrl(url);

  if (process.platform === "win32") {
    // Start-Process 交给系统默认关联处理 http(s)，避免 cmd start 对 &/%/^ 的截断。
    const escapedUrl = escapeForPowerShellSingleQuotedString(openedUrl);
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath '${escapedUrl}'`
      ],
      { windowsHide: true }
    );
    return { openedUrl };
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [openedUrl]);
    return { openedUrl };
  }

  await execFileAsync("xdg-open", [openedUrl]);
  return { openedUrl };
}
