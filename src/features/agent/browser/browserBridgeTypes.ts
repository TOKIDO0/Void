/**
 * 浏览器工具与 sidecar 之间的共享结构化类型（前端侧镜像）。
 * 与 server/browser/browserTypes.ts 保持字段一致，但不依赖 Node 模块。
 */

export type BrowserSearchResultItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
};

export type BrowserOpenData = {
  taskId: string;
  pageId: string;
  url: string;
  title: string;
  finalUrl: string;
};

export type BrowserSearchData = {
  taskId: string;
  pageId: string;
  engine: "duckduckgo";
  query: string;
  resultPageUrl: string;
  results: BrowserSearchResultItem[];
};

export type BrowserReadResultData = {
  taskId: string;
  pageId: string;
  pageUrl: string;
  pageTitle: string;
  results: BrowserSearchResultItem[];
};

export type BrowserScreenshotData = {
  taskId: string;
  pageId: string;
  pageUrl: string;
  pageTitle: string;
  path: string;
  width: number;
  height: number;
  fullPage: boolean;
};

export type BrowserCloseSessionData = {
  taskId: string;
  closed: boolean;
  hadSession: boolean;
};

export type BrowserEnsureSessionData = {
  taskId: string;
  created: boolean;
};

export type BrowserBridgeErrorCode =
  | "INVALID_REQUEST"
  | "SESSION_NOT_FOUND"
  | "PAGE_NOT_FOUND"
  | "NAVIGATION_FAILED"
  | "PARSE_FAILED"
  | "BROWSER_UNAVAILABLE"
  | "TIMEOUT"
  | "INTERNAL_ERROR"
  | "BRIDGE_UNREACHABLE";

export type BrowserBridgeFailure = {
  ok: false;
  error: {
    code: BrowserBridgeErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type BrowserBridgeSuccess<T> = {
  ok: true;
  data: T;
};

export type BrowserBridgeResponse<T> = BrowserBridgeSuccess<T> | BrowserBridgeFailure;
