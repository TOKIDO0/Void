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
  openMode: "automation_window";
  headless: boolean;
  broughtToFront: boolean;
};

export type BrowserSearchData = {
  taskId: string;
  pageId: string;
  engine: "duckduckgo" | "bilibili";
  query: string;
  resultPageUrl: string;
  results: BrowserSearchResultItem[];
};

export type BrowserRevealInSystemBrowserData = {
  taskId: string;
  openedUrl: string;
  titleHint?: string;
  openMode: "system_default_browser";
  message: string;
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

export type BrowserClickData = {
  taskId: string;
  pageId: string;
  selector: string;
  pageUrl: string;
  pageTitle: string;
  button: "left" | "right" | "middle";
  clickCount: number;
};

export type BrowserTypeData = {
  taskId: string;
  pageId: string;
  selector: string;
  pageUrl: string;
  pageTitle: string;
  typedLength: number;
  cleared: boolean;
  submitted: boolean;
};

export type BrowserWaitForData = {
  taskId: string;
  pageId: string;
  selector: string;
  state: "attached" | "detached" | "visible" | "hidden";
  pageUrl: string;
  pageTitle: string;
  waitedMs: number;
};

/** 阶段 G2：与 server/browser/browserTypes 对齐 */
export type BrowserExtractMode = "links" | "text" | "both";

export type BrowserExtractItem = {
  index: number;
  kind: "link" | "text";
  text: string;
  href?: string;
  tagName?: string;
  /** 仅 count===1 时返回；多匹配省略 */
  suggestedSelector?: string;
};

export type BrowserExtractData = {
  taskId: string;
  pageId: string;
  pageUrl: string;
  pageTitle: string;
  mode: BrowserExtractMode;
  scopeSelector?: string;
  items: BrowserExtractItem[];
  count: number;
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
