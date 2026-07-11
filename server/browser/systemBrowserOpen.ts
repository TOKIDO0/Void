/**
 * 用操作系统默认/常用浏览器打开 URL（给用户看，不是 Playwright 自动化窗）。
 * Windows 走 cmd start；macOS open；Linux xdg-open。
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
 * 在用户系统浏览器中打开链接（异步、不等待浏览器退出）。
 */
export async function openUrlInSystemBrowser(url: string): Promise<{ openedUrl: string }> {
  const openedUrl = assertPublicHttpUrl(url);

  if (process.platform === "win32") {
    // start "" <url>：空标题参数避免把 URL 当窗口标题
    await execFileAsync(
      "cmd",
      ["/c", "start", "", openedUrl],
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
