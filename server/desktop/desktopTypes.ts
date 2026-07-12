/**
 * M-desktop 剪贴板契约（sidecar）。
 * 本阶段只做 read/write 文本；不上完整 UIA / app.launch。
 */

export type ClipboardReadData = {
  text: string;
  length: number;
  empty: boolean;
  truncated: boolean;
  readAt: number;
};

export type ClipboardWriteData = {
  length: number;
  writtenAt: number;
};

export type DesktopApiSuccess<T> = { ok: true; data: T };
export type DesktopApiFailure = {
  ok: false;
  error: {
    code:
      | "INVALID_REQUEST"
      | "UNSUPPORTED_PLATFORM"
      | "CLIPBOARD_FAILED"
      | "TOO_LARGE"
      | "TIMEOUT"
      | "INTERNAL_ERROR";
    message: string;
    details?: Record<string, unknown>;
  };
};
export type DesktopApiResponse<T> = DesktopApiSuccess<T> | DesktopApiFailure;
