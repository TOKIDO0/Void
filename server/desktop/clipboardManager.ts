/**
 * Windows 剪贴板读写（无新 npm 依赖）。
 * 通过 PowerShell Get-Clipboard / Set-Clipboard；write 走 stdin 防注入与命令行长度限制。
 */

import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { ClipboardReadData, ClipboardWriteData } from "./desktopTypes";

/** 单次读出上限（字符），超出截断并标记 truncated */
export const CLIPBOARD_READ_MAX_CHARS = 50_000;
/** 单次写入上限（字符），超出直接拒绝 */
export const CLIPBOARD_WRITE_MAX_CHARS = 20_000;

function createDesktopError(
  code:
    | "INVALID_REQUEST"
    | "UNSUPPORTED_PLATFORM"
    | "CLIPBOARD_FAILED"
    | "TOO_LARGE"
    | "TIMEOUT"
    | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    desktopCode: string;
    details?: Record<string, unknown>;
  };
  error.desktopCode = code;
  error.details = details;
  return error;
}

function assertWindows() {
  if (platform() !== "win32") {
    throw createDesktopError(
      "UNSUPPORTED_PLATFORM",
      `剪贴板当前仅支持 Windows，当前平台：${platform()}`
    );
  }
}

/**
 * 跑一段 PowerShell，可选 stdin 文本。
 * 统一 UTF-8 输出，超时 15s。
 */
function runPowerShell(
  command: string,
  options?: { stdinText?: string; timeoutMs?: number }
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // 强制控制台用 UTF-8，避免中文剪贴板乱码
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        + "$OutputEncoding = [System.Text.Encoding]::UTF8; "
        + command
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(
        createDesktopError("TIMEOUT", `剪贴板操作超时（${timeoutMs}ms）`)
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        createDesktopError(
          "CLIPBOARD_FAILED",
          error instanceof Error ? error.message : "无法启动 PowerShell"
        )
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          createDesktopError(
            "CLIPBOARD_FAILED",
            stderr.trim() || `PowerShell 退出码 ${code}`,
            { exitCode: code }
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    if (typeof options?.stdinText === "string") {
      child.stdin.write(options.stdinText, "utf8");
    }
    child.stdin.end();
  });
}

export class ClipboardManager {
  async read(): Promise<ClipboardReadData> {
    assertWindows();

    // Get-Clipboard 后用 Base64 回传，避免控制台代码页把中文 stdout 弄乱
    let raw = "";
    try {
      const { stdout } = await runPowerShell(
        "try { "
        + "$t = Get-Clipboard -Raw -ErrorAction Stop; "
        + "if ($null -eq $t) { $t = '' }; "
        + "$bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$t); "
        + "[Convert]::ToBase64String($bytes) "
        + "} catch { "
        + "$bytes = [System.Text.Encoding]::UTF8.GetBytes(''); "
        + "[Convert]::ToBase64String($bytes) "
        + "}"
      );
      const b64 = stdout.trim();
      raw = b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "desktopCode" in error
      ) {
        throw error;
      }
      throw createDesktopError(
        "CLIPBOARD_FAILED",
        error instanceof Error ? error.message : "读取剪贴板失败"
      );
    }

    const empty = raw.length === 0;
    let truncated = false;
    let text = raw;
    if (text.length > CLIPBOARD_READ_MAX_CHARS) {
      text = text.slice(0, CLIPBOARD_READ_MAX_CHARS);
      truncated = true;
    }

    return {
      text,
      length: text.length,
      empty,
      truncated,
      readAt: Date.now()
    };
  }

  async write(text: string): Promise<ClipboardWriteData> {
    assertWindows();

    if (typeof text !== "string") {
      throw createDesktopError("INVALID_REQUEST", "text 必须是字符串");
    }
    if (text.length > CLIPBOARD_WRITE_MAX_CHARS) {
      throw createDesktopError(
        "TOO_LARGE",
        `剪贴板写入不能超过 ${CLIPBOARD_WRITE_MAX_CHARS} 字符（当前 ${text.length}）`,
        { maxChars: CLIPBOARD_WRITE_MAX_CHARS, length: text.length }
      );
    }

    // 用 Base64 传 UTF-8 字节，避开 Windows 控制台代码页把 stdin 当 GBK 的问题
    const base64 = Buffer.from(text, "utf8").toString("base64");
    try {
      await runPowerShell(
        "$b64 = [Console]::In.ReadToEnd().Trim(); "
        + "$bytes = [Convert]::FromBase64String($b64); "
        + "$inputText = [System.Text.Encoding]::UTF8.GetString($bytes); "
        + "Set-Clipboard -Value $inputText",
        { stdinText: base64 }
      );
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "desktopCode" in error
      ) {
        throw error;
      }
      throw createDesktopError(
        "CLIPBOARD_FAILED",
        error instanceof Error ? error.message : "写入剪贴板失败"
      );
    }

    return {
      length: text.length,
      writtenAt: Date.now()
    };
  }
}

export const clipboardManager = new ClipboardManager();

export function getDesktopErrorPayload(error: unknown): {
  code:
    | "INVALID_REQUEST"
    | "UNSUPPORTED_PLATFORM"
    | "CLIPBOARD_FAILED"
    | "TOO_LARGE"
    | "TIMEOUT"
    | "PATH_NOT_ALLOWED"
    | "PATH_NOT_FOUND"
    | "APP_NOT_FOUND"
    | "AMBIGUOUS_APP_NAME"
    | "REVEAL_FAILED"
    | "INTERNAL_ERROR";
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "desktopCode" in error
    && typeof (error as { desktopCode?: unknown }).desktopCode === "string"
  ) {
    const coded = error as Error & {
      desktopCode:
        | "INVALID_REQUEST"
        | "UNSUPPORTED_PLATFORM"
        | "CLIPBOARD_FAILED"
        | "TOO_LARGE"
        | "TIMEOUT"
        | "PATH_NOT_ALLOWED"
        | "PATH_NOT_FOUND"
        | "APP_NOT_FOUND"
        | "AMBIGUOUS_APP_NAME"
        | "REVEAL_FAILED"
        | "INTERNAL_ERROR";
      details?: Record<string, unknown>;
    };
    return {
      code: coded.desktopCode,
      message: coded.message,
      details: coded.details
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "桌面操作内部错误"
  };
}
