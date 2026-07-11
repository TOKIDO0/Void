/**
 * Playwright 浏览器会话管理（阶段 C）。
 *
 * 设计要点（对齐 27 号 §7.1 / Playwright 官方 isolation）：
 * - 进程内复用一个 Browser 实例；
 * - 每个 taskId 独立 BrowserContext（Cookie/Storage 隔离）；
 * - 任务结束必须 close context；
 * - 前端不直连 Playwright，只经本模块被 HTTP 路由调用。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page
} from "playwright";
import {
  buildDuckDuckGoHtmlSearchUrl,
  extractDuckDuckGoResults
} from "./duckduckgoSearch";
import type {
  BrowserCloseSessionData,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserScreenshotData,
  BrowserSearchData
} from "./browserTypes";

type ManagedPage = {
  pageId: string;
  page: Page;
};

type ManagedSession = {
  taskId: string;
  context: BrowserContext;
  pages: Map<string, ManagedPage>;
  activePageId?: string;
  createdAt: number;
  lastUsedAt: number;
};

/** 默认可视窗口尺寸：桌面常见比例，避免移动端布局 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** 无头开关：环境变量 VOID_BROWSER_HEADLESS=1 时无头；默认有头便于阶段 C 验收「真打开浏览器」 */
function resolveHeadless(): boolean {
  const raw = process.env.VOID_BROWSER_HEADLESS;
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return false;
}

function makePageId() {
  return `page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampLimit(limit: number | undefined, fallback = 8) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(20, Math.max(1, Math.floor(limit)));
}

function assertHttpUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw createBrowserError("INVALID_REQUEST", `非法 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createBrowserError("INVALID_REQUEST", `仅允许 http/https：${url}`);
  }
  return parsed.toString();
}

function createBrowserError(
  code:
    | "INVALID_REQUEST"
    | "SESSION_NOT_FOUND"
    | "PAGE_NOT_FOUND"
    | "NAVIGATION_FAILED"
    | "PARSE_FAILED"
    | "BROWSER_UNAVAILABLE"
    | "TIMEOUT"
    | "INTERNAL_ERROR",
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    browserCode: string;
    details?: Record<string, unknown>;
  };
  error.browserCode = code;
  error.details = details;
  return error;
}

export class BrowserSessionManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, ManagedSession>();
  /**
   * 截图落盘：优先 D:\AI\void-runtime\browser-screenshots（避开已满的 C 盘）。
   * 可用环境变量 VOID_BROWSER_SCREENSHOT_DIR 覆盖。
   */
  private readonly screenshotRoot = resolveScreenshotRoot();

  constructor() {
    mkdirSync(this.screenshotRoot, { recursive: true });
  }

  /**
   * 确保 Browser 进程就绪（懒启动）。
   */
  async ensureBrowser(): Promise<void> {
    await this.getBrowser();
  }

  isBrowserReady(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  listActiveTaskIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * 确保任务拥有独立 BrowserContext。
   */
  async ensureSession(taskId: string): Promise<{ taskId: string; created: boolean }> {
    const normalizedTaskId = normalizeTaskId(taskId);
    const existing = this.sessions.get(normalizedTaskId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return { taskId: normalizedTaskId, created: false };
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      // 阶段 C 只读：不接受下载，避免误触写入
      acceptDownloads: false
    });

    const now = Date.now();
    this.sessions.set(normalizedTaskId, {
      taskId: normalizedTaskId,
      context,
      pages: new Map(),
      createdAt: now,
      lastUsedAt: now
    });

    return { taskId: normalizedTaskId, created: true };
  }

  async open(input: {
    taskId: string;
    url: string;
    pageId?: string;
  }): Promise<BrowserOpenData> {
    const session = await this.getOrCreateSession(input.taskId);
    const targetUrl = assertHttpUrl(input.url);
    const managedPage = await this.resolveWritablePage(session, input.pageId);

    try {
      const response = await managedPage.page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      // 4xx/5xx 仍返回页面信息，由调用方决定；导航异常才抛
      if (response && response.status() >= 500) {
        throw createBrowserError(
          "NAVIGATION_FAILED",
          `页面响应异常：HTTP ${response.status()}`,
          { status: response.status(), url: targetUrl }
        );
      }
    } catch (error) {
      if (isBrowserCodedError(error)) {
        throw error;
      }
      throw createBrowserError(
        "NAVIGATION_FAILED",
        error instanceof Error ? error.message : "页面导航失败",
        { url: targetUrl }
      );
    }

    session.lastUsedAt = Date.now();
    session.activePageId = managedPage.pageId;

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      url: targetUrl,
      title: await managedPage.page.title(),
      finalUrl: managedPage.page.url()
    };
  }

  async search(input: {
    taskId: string;
    query: string;
    limit?: number;
  }): Promise<BrowserSearchData> {
    const query = input.query.trim();
    if (!query) {
      throw createBrowserError("INVALID_REQUEST", "搜索关键词不能为空");
    }

    const limit = clampLimit(input.limit, 8);
    const resultPageUrl = buildDuckDuckGoHtmlSearchUrl(query);
    const opened = await this.open({
      taskId: input.taskId,
      url: resultPageUrl
    });

    const session = this.requireSession(opened.taskId);
    const managedPage = this.requirePage(session, opened.pageId);

    let results;
    try {
      results = await extractDuckDuckGoResults(managedPage.page, limit);
    } catch (error) {
      throw createBrowserError(
        "PARSE_FAILED",
        error instanceof Error ? error.message : "解析搜索结果失败",
        { query }
      );
    }

    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      engine: "duckduckgo",
      query,
      resultPageUrl: managedPage.page.url(),
      results
    };
  }

  async readResult(input: {
    taskId: string;
    pageId?: string;
    limit?: number;
  }): Promise<BrowserReadResultData> {
    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);
    const limit = clampLimit(input.limit, 8);

    let results;
    try {
      results = await extractDuckDuckGoResults(managedPage.page, limit);
    } catch (error) {
      throw createBrowserError(
        "PARSE_FAILED",
        error instanceof Error ? error.message : "读取页面结果失败"
      );
    }

    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      results
    };
  }

  async screenshot(input: {
    taskId: string;
    pageId?: string;
    fullPage?: boolean;
  }): Promise<BrowserScreenshotData> {
    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);
    const fullPage = input.fullPage === true;
    const fileName = `${session.taskId}_${managedPage.pageId}_${Date.now()}.png`;
    const path = join(this.screenshotRoot, fileName);

    await managedPage.page.screenshot({
      path,
      fullPage,
      type: "png"
    });

    // 尺寸用 viewport 兜底（阶段 C 验收不依赖像素级测量）
    const viewport = managedPage.page.viewportSize() ?? DEFAULT_VIEWPORT;
    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      path,
      width: viewport.width,
      height: fullPage ? viewport.height : viewport.height,
      fullPage
    };
  }

  async closeSession(taskId: string): Promise<BrowserCloseSessionData> {
    const normalizedTaskId = normalizeTaskId(taskId);
    const session = this.sessions.get(normalizedTaskId);
    if (!session) {
      return {
        taskId: normalizedTaskId,
        closed: false,
        hadSession: false
      };
    }

    this.sessions.delete(normalizedTaskId);
    try {
      await session.context.close();
    } catch (error) {
      // 关闭失败仍视为会话已移除，避免泄漏映射
      console.error("[void-browser] close context failed", error);
    }

    return {
      taskId: normalizedTaskId,
      closed: true,
      hadSession: true
    };
  }

  /**
   * 进程退出时关闭全部会话与 Browser。
   */
  async dispose(): Promise<void> {
    const taskIds = [...this.sessions.keys()];
    for (const taskId of taskIds) {
      await this.closeSession(taskId);
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // ignore
      }
      this.browser = null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.launching) {
      return this.launching;
    }

    this.launching = this.launchBrowserPreferringSystemChrome()
      .then((browser) => {
        this.browser = browser;
        this.launching = null;
        browser.on("disconnected", () => {
          this.browser = null;
          this.sessions.clear();
        });
        return browser;
      })
      .catch((error) => {
        this.launching = null;
        throw createBrowserError(
          "BROWSER_UNAVAILABLE",
          error instanceof Error
            ? `无法启动浏览器：${error.message}`
            : "无法启动浏览器",
          {
            hint:
              "优先使用本机 Chrome/Edge（channel）。若均不可用，可腾出磁盘后执行 npx playwright install chromium"
          }
        );
      });

    return this.launching;
  }

  /**
   * 启动策略（产品向）：
   * 1) 本机 Google Chrome（channel:chrome）— 不占额外磁盘下载
   * 2) 本机 Microsoft Edge（channel:msedge）
   * 3) Playwright 自带 Chromium（需事先 install）
   */
  private async launchBrowserPreferringSystemChrome(): Promise<Browser> {
    const headless = resolveHeadless();
    const commonArgs = ["--disable-dev-shm-usage"];

    const attempts: Array<{ label: string; launch: () => Promise<Browser> }> = [
      {
        label: "chrome-channel",
        launch: () =>
          chromium.launch({
            channel: "chrome",
            headless,
            args: commonArgs
          })
      },
      {
        label: "msedge-channel",
        launch: () =>
          chromium.launch({
            channel: "msedge",
            headless,
            args: commonArgs
          })
      },
      {
        label: "playwright-chromium",
        launch: () =>
          chromium.launch({
            headless,
            args: commonArgs
          })
      }
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const browser = await attempt.launch();
        console.log(`[void-browser] launched via ${attempt.label} (headless=${headless})`);
        return browser;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${attempt.label}: ${message}`);
        console.warn(`[void-browser] launch failed (${attempt.label}): ${message}`);
      }
    }

    throw new Error(errors.join(" | "));
  }

  private async getOrCreateSession(taskId: string): Promise<ManagedSession> {
    await this.ensureSession(taskId);
    return this.requireSession(taskId);
  }

  private requireSession(taskId: string): ManagedSession {
    const normalizedTaskId = normalizeTaskId(taskId);
    const session = this.sessions.get(normalizedTaskId);
    if (!session) {
      throw createBrowserError(
        "SESSION_NOT_FOUND",
        `浏览器会话不存在：${normalizedTaskId}`
      );
    }
    return session;
  }

  private requirePage(session: ManagedSession, pageId?: string): ManagedPage {
    const resolvedId = pageId ?? session.activePageId;
    if (!resolvedId) {
      throw createBrowserError("PAGE_NOT_FOUND", "当前任务没有可用页面，请先 open 或 search");
    }
    const managed = session.pages.get(resolvedId);
    if (!managed) {
      throw createBrowserError("PAGE_NOT_FOUND", `页面不存在：${resolvedId}`);
    }
    return managed;
  }

  private async resolveWritablePage(
    session: ManagedSession,
    pageId?: string
  ): Promise<ManagedPage> {
    if (pageId) {
      const existing = session.pages.get(pageId);
      if (existing) {
        return existing;
      }
      throw createBrowserError("PAGE_NOT_FOUND", `页面不存在：${pageId}`);
    }

    const page = await session.context.newPage();
    const managed: ManagedPage = {
      pageId: makePageId(),
      page
    };
    session.pages.set(managed.pageId, managed);
    session.activePageId = managed.pageId;

    page.on("close", () => {
      session.pages.delete(managed.pageId);
      if (session.activePageId === managed.pageId) {
        const remaining = session.pages.keys().next();
        session.activePageId = remaining.done ? undefined : remaining.value;
      }
    });

    return managed;
  }
}

function normalizeTaskId(taskId: string): string {
  const trimmed = taskId.trim();
  if (!trimmed) {
    throw createBrowserError("INVALID_REQUEST", "taskId 不能为空");
  }
  return trimmed;
}

/**
 * 截图目录解析：避免默认写到 C 盘 %TEMP%。
 */
function resolveScreenshotRoot(): string {
  const fromEnv = process.env.VOID_BROWSER_SCREENSHOT_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  // 产品默认：与工程同盘的 AI 运行时目录
  return "D:\\AI\\void-runtime\\browser-screenshots";
}

function isBrowserCodedError(
  error: unknown
): error is Error & { browserCode: string; details?: Record<string, unknown> } {
  return (
    typeof error === "object"
    && error !== null
    && "browserCode" in error
    && typeof (error as { browserCode?: unknown }).browserCode === "string"
  );
}

export function getBrowserErrorPayload(error: unknown): {
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
} {
  if (
    typeof error === "object"
    && error !== null
    && "browserCode" in error
    && typeof (error as { browserCode?: unknown }).browserCode === "string"
  ) {
    const coded = error as Error & {
      browserCode:
        | "INVALID_REQUEST"
        | "SESSION_NOT_FOUND"
        | "PAGE_NOT_FOUND"
        | "NAVIGATION_FAILED"
        | "PARSE_FAILED"
        | "BROWSER_UNAVAILABLE"
        | "TIMEOUT"
        | "INTERNAL_ERROR";
      details?: Record<string, unknown>;
    };
    return {
      code: coded.browserCode,
      message: coded.message,
      details: coded.details
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "浏览器内部错误"
  };
}

/** 进程级单例：一个 sidecar 共用一个管理器 */
export const browserSessionManager = new BrowserSessionManager();
