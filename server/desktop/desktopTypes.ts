/**
 * M-desktop 契约（sidecar）。
 * 当前：剪贴板 read/write + 资源管理器 revealPath + 应用启动。
 * 不上完整 UIA / 任意 Shell。
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

/** 代码内固定映射的 Windows 系统位置；不接受任意路径或命令。 */
export type DesktopKnownLocation = "this_pc";

export type DesktopOpenKnownLocationData = {
  location: DesktopKnownLocation;
  openedAt: number;
};

export type DesktopInstalledApp = {
  name: string;
  lnkPath: string;
};

export type DesktopInstalledAppsData = {
  apps: DesktopInstalledApp[];
  count: number;
  scannedAt: number;
};

export type DesktopLaunchAppData = {
  name: string;
  lnkPath: string;
  launchedAt: number;
};

export type DesktopWindowInfo = {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
};

export type DesktopListWindowsData = {
  windows: DesktopWindowInfo[];
  count: number;
  scannedAt: number;
};

export type DesktopFocusWindowData = {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
  focusedAt: number;
};

export type DesktopCloseWindowData = {
  closed: boolean;
  pid: number;
  title: string;
  closedAt: number;
};

export type DesktopSystemInfoData = {
  platform: string;
  arch: string;
  totalMemMb: number;
  freeMemMb: number;
  cpus: number;
  screen?: { width: number; height: number };
  collectedAt: number;
};

export type DesktopScreenshotData = {
  path: string;
  width: number;
  height: number;
  capturedAt: number;
};

export type DesktopSetWindowBoundsData = {
  hwnd: string;
  pid: number;
  processName: string;
  title: string;
  action: string;
  bounds?: { x: number; y: number; width: number; height: number };
  appliedAt: number;
};

export type DesktopApiErrorCode =
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
