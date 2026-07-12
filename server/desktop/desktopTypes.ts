/**
 * M-desktop 契约（sidecar）。
 * 当前：剪贴板 read/write + 资源管理器 revealPath。
 * 不上完整 UIA / app.launch / 任意 Shell。
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

/** open=打开目录；select=在资源管理器中选中文件 */
export type DesktopRevealOpenMode = "open" | "select";

export type DesktopRevealPathData = {
  revealedPath: string;
  openMode: DesktopRevealOpenMode;
  revealedAt: number;
};

export type DesktopApiErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PLATFORM"
  | "CLIPBOARD_FAILED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "PATH_NOT_ALLOWED"
  | "PATH_NOT_FOUND"
  | "REVEAL_FAILED"
  | "INTERNAL_ERROR";

export type DesktopApiSuccess<T> = { ok: true; data: T };
export type DesktopApiFailure = {
  ok: false;
  error: {
    code: DesktopApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};
export type DesktopApiResponse<T> = DesktopApiSuccess<T> | DesktopApiFailure;
