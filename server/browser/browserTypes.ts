/**
 * 浏览器自动化 sidecar 的请求/响应契约。
 * 仅服务本地回环调用；前端工具层经 HTTP 访问，不直连 Playwright。
 */

/** 打开页面请求 */
export type BrowserOpenRequest = {
  taskId: string;
  url: string;
  /** 可选：复用已有 pageId；缺省则新建标签页 */
  pageId?: string;
};

/** 搜索请求：默认 DuckDuckGo HTML；B 站站内搜用 bilibili */
export type BrowserSearchRequest = {
  taskId: string;
  query: string;
  /** duckduckgo=全网 HTML；bilibili=B 站站内视频搜索 */
  engine?: "duckduckgo" | "bilibili";
  /** 最多返回条数，默认 8，上限 20 */
  limit?: number;
};

/** 读取当前/指定页结果请求 */
export type BrowserReadResultRequest = {
  taskId: string;
  pageId?: string;
  /** 最多返回条数，默认 8，上限 20 */
  limit?: number;
};

/** 截图请求 */
export type BrowserScreenshotRequest = {
  taskId: string;
  pageId?: string;
  /** 是否整页；默认 false（可视区域） */
  fullPage?: boolean;
};

/** 关闭任务浏览器上下文 */
export type BrowserCloseSessionRequest = {
  taskId: string;
};

/** 结构化搜索结果条目 */
export type BrowserSearchResultItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
};

/** 打开页面成功数据 */
export type BrowserOpenData = {
  taskId: string;
  pageId: string;
  url: string;
  title: string;
  finalUrl: string;
  /**
   * 打开方式说明，给模型/用户看：
   * automation_window = Playwright 独立窗（任务栏可能另有图标）
   */
  openMode: "automation_window";
  headless: boolean;
  /** 是否已尝试前置窗口 */
  broughtToFront: boolean;
};

/** 搜索成功数据 */
export type BrowserSearchData = {
  taskId: string;
  pageId: string;
  engine: "duckduckgo" | "bilibili";
  query: string;
  resultPageUrl: string;
  results: BrowserSearchResultItem[];
};

/** 用系统默认浏览器打开（给用户看） */
export type BrowserRevealInSystemBrowserData = {
  taskId: string;
  openedUrl: string;
  titleHint?: string;
  openMode: "system_default_browser";
  message: string;
};

/** 读结果成功数据 */
export type BrowserReadResultData = {
  taskId: string;
  pageId: string;
  pageUrl: string;
  pageTitle: string;
  results: BrowserSearchResultItem[];
};

/** 截图成功数据（路径相对系统临时目录，不落 Cookie） */
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

/** 会话关闭结果 */
export type BrowserCloseSessionData = {
  taskId: string;
  closed: boolean;
  hadSession: boolean;
};

/** 窄动作：点击（Playwright locator.click） */
export type BrowserClickData = {
  taskId: string;
  pageId: string;
  selector: string;
  pageUrl: string;
  pageTitle: string;
  button: "left" | "right" | "middle";
  clickCount: number;
};

/** 窄动作：输入（Playwright locator.fill / pressSequentially） */
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

/** 窄动作：等待元素（Playwright locator.waitFor） */
export type BrowserWaitForData = {
  taskId: string;
  pageId: string;
  selector: string;
  state: "attached" | "detached" | "visible" | "hidden";
  pageUrl: string;
  pageTitle: string;
  waitedMs: number;
};

export type BrowserApiSuccess<T> = {
  ok: true;
  data: T;
};

export type BrowserApiFailure = {
  ok: false;
  error: {
    code:
      | "INVALID_REQUEST"
      | "SESSION_NOT_FOUND"
      | "PAGE_NOT_FOUND"
      | "NAVIGATION_FAILED"
      | "PARSE_FAILED"
      | "BROWSER_UNAVAILABLE"
      | "TIMEOUT"
      | "INTERNAL_ERROR";
    message: string;
    details?: Record<string, unknown>;
  };
};

export type BrowserApiResponse<T> = BrowserApiSuccess<T> | BrowserApiFailure;
