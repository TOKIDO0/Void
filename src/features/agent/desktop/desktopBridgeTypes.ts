/**
 * 桌面工具与 sidecar 之间的共享类型（前端侧镜像）。
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

export type DesktopBridgeErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PLATFORM"
  | "CLIPBOARD_FAILED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "BRIDGE_UNREACHABLE";

export type DesktopBridgeResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: DesktopBridgeErrorCode;
        message: string;
        details?: Record<string, unknown>;
      };
    };
