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
  buildBilibiliSearchUrl,
  extractBilibiliSearchResults
} from "./bilibiliSearch";
import {
  buildDuckDuckGoHtmlSearchUrl,
  extractDuckDuckGoResults
} from "./duckduckgoSearch";
import {
  assertSingleMatch,
  createBrowserError,
  isBrowserCodedError,
  mapLocatorActionError,
  normalizeA11yName,
  normalizeA11yRole,
  normalizeSelector,
  resolveActionTarget
} from "./browserLocatorUtils";
import { extractPageStructure } from "./pageExtract";
import { openUrlInSystemBrowser } from "./systemBrowserOpen";
import type {
  BrowserClickData,
  BrowserCloseSessionData,
  BrowserExtractData,
  BrowserExtractMode,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserRevealInSystemBrowserData,
  BrowserScreenshotData,
  BrowserSearchData,
  BrowserSwitchTabData,
  BrowserTabsData,
  BrowserTypeData,
  BrowserWaitForData
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

/**
 * 无头开关：
 * - VOID_BROWSER_HEADLESS=1/true → 无头（仅冒烟脚本用）
 * - 默认有头：用户要能在任务栏看到自动化窗
 * 产品路径禁止默认无头。
 */
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

function isHeadlessMode(): boolean {
  return resolveHeadless();
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

  /**
   * Q2：列出当前任务上下文内全部标签页（pageId/url/title/是否活动）。
   * 只读；无会话时返回空列表而不是报错（便于模型先 tabs 再 open）。
   */
  async listTabs(input: { taskId: string }): Promise<BrowserTabsData> {
    const normalizedTaskId = normalizeTaskId(input.taskId);
    const session = this.sessions.get(normalizedTaskId);
    if (!session) {
      return {
        taskId: normalizedTaskId,
        tabs: [],
        count: 0
      };
    }

    session.lastUsedAt = Date.now();
    const tabs = [];
    for (const managed of session.pages.values()) {
      let title = "";
      try {
        title = await managed.page.title();
      } catch {
        title = "";
      }
      tabs.push({
        pageId: managed.pageId,
        url: managed.page.url(),
        title,
        active: managed.pageId === session.activePageId
      });
    }

    return {
      taskId: session.taskId,
      activePageId: session.activePageId,
      tabs,
      count: tabs.length
    };
  }

  /**
   * Q2：把指定 pageId 设为活动标签；后续未传 pageId 的动作走该页。
   * 有头模式尽量 bringToFront。
   */
  async switchTab(input: {
    taskId: string;
    pageId: string;
  }): Promise<BrowserSwitchTabData> {
    const pageId = input.pageId?.trim() ?? "";
    if (!pageId) {
      throw createBrowserError("INVALID_REQUEST", "pageId 不能为空");
    }

    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, pageId);
    const previousPageId = session.activePageId;
    session.activePageId = managedPage.pageId;
    session.lastUsedAt = Date.now();

    let broughtToFront = false;
    if (!isHeadlessMode()) {
      try {
        await managedPage.page.bringToFront();
        broughtToFront = true;
      } catch {
        broughtToFront = false;
      }
    }

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      url: managedPage.page.url(),
      title: await managedPage.page.title(),
      previousPageId:
        previousPageId && previousPageId !== managedPage.pageId
          ? previousPageId
          : undefined,
      broughtToFront
    };
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

    // 有头模式：尽量把自动化窗拉到前台，避免用户以为「没打开」
    const headless = isHeadlessMode();
    let broughtToFront = false;
    if (!headless) {
      try {
        await managedPage.page.bringToFront();
        broughtToFront = true;
      } catch {
        broughtToFront = false;
      }
    }

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      url: targetUrl,
      title: await managedPage.page.title(),
      finalUrl: managedPage.page.url(),
      openMode: "automation_window",
      headless,
      broughtToFront
    };
  }

  async search(input: {
    taskId: string;
    query: string;
    engine?: "duckduckgo" | "bilibili";
    limit?: number;
  }): Promise<BrowserSearchData> {
    const query = input.query.trim();
    if (!query) {
      throw createBrowserError("INVALID_REQUEST", "搜索关键词不能为空");
    }

    const engine = input.engine === "bilibili" ? "bilibili" : "duckduckgo";
    const limit = clampLimit(input.limit, 8);
    const resultPageUrl =
      engine === "bilibili"
        ? buildBilibiliSearchUrl(query)
        : buildDuckDuckGoHtmlSearchUrl(query);

    const opened = await this.open({
      taskId: input.taskId,
      url: resultPageUrl
    });

    const session = this.requireSession(opened.taskId);
    const managedPage = this.requirePage(session, opened.pageId);

    let results;
    try {
      results =
        engine === "bilibili"
          ? await extractBilibiliSearchResults(managedPage.page, limit)
          : await extractDuckDuckGoResults(managedPage.page, limit);
    } catch (error) {
      throw createBrowserError(
        "PARSE_FAILED",
        error instanceof Error ? error.message : "解析搜索结果失败",
        { query, engine }
      );
    }

    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      engine,
      query,
      resultPageUrl: managedPage.page.url(),
      results
    };
  }

  /**
   * 用系统默认浏览器打开 URL，让用户在常用浏览器里看到页面。
   * 与 Playwright 自动化窗分离：自动化窗负责读页面；本方法负责「给用户看」。
   */
  async revealInSystemBrowser(input: {
    taskId: string;
    url: string;
    titleHint?: string;
  }): Promise<BrowserRevealInSystemBrowserData> {
    const taskId = normalizeTaskId(input.taskId);
    const openedUrl = assertHttpUrl(input.url);
    try {
      await openUrlInSystemBrowser(openedUrl);
    } catch (error) {
      throw createBrowserError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "系统浏览器打开失败",
        { url: openedUrl }
      );
    }

    // 若该 task 已有会话，更新活跃时间（不强依赖会话）
    const session = this.sessions.get(taskId);
    if (session) {
      session.lastUsedAt = Date.now();
    }

    const titlePart = input.titleHint?.trim() ? `「${input.titleHint.trim()}」` : "目标页面";
    return {
      taskId,
      openedUrl,
      titleHint: input.titleHint,
      openMode: "system_default_browser",
      message: `已在你的系统默认浏览器中打开${titlePart}：${openedUrl}。请切换到你常用的浏览器窗口查看（不是自动化小窗）。`
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

  /**
   * 窄动作：点击。使用官方 Locator API（自动等待可点），禁止坐标点击。
   * 定位：selector 或 role+name（getByRole）；多元素命中严格失败。
   */
  async click(input: {
    taskId: string;
    pageId?: string;
    selector?: string;
    role?: string;
    name?: string;
    button?: "left" | "right" | "middle";
    clickCount?: number;
  }): Promise<BrowserClickData> {
    const button = input.button === "right" || input.button === "middle" ? input.button : "left";
    const clickCount =
      typeof input.clickCount === "number" && Number.isFinite(input.clickCount)
        ? Math.min(3, Math.max(1, Math.floor(input.clickCount)))
        : 1;

    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);
    const { locator, targetLabel, via } = resolveActionTarget(managedPage.page, input);

    try {
      // 先等到至少一个可见，再校验唯一性，避免动态页 count() 过早为 0。
      await locator.first().waitFor({ state: "visible", timeout: 15_000 });
      await assertSingleMatch(locator, targetLabel);
      await locator.click({
        button,
        clickCount,
        timeout: 15_000
      });
    } catch (error) {
      throw mapLocatorActionError(error, "click", targetLabel);
    }

    session.lastUsedAt = Date.now();
    session.activePageId = managedPage.pageId;

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      selector: targetLabel,
      role: via === "role" ? normalizeA11yRole(input.role ?? "") : undefined,
      name: via === "role" ? normalizeA11yName(input.name ?? "") : undefined,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      button,
      clickCount
    };
  }

  /**
   * 窄动作：输入文本。默认 fill（清空后写入）；clear=false 时用 pressSequentially 追加。
   * 定位：selector 或 role+name；submit=true 时在输入后按 Enter。
   */
  async type(input: {
    taskId: string;
    pageId?: string;
    selector?: string;
    role?: string;
    name?: string;
    text: string;
    clear?: boolean;
    submit?: boolean;
  }): Promise<BrowserTypeData> {
    if (typeof input.text !== "string") {
      throw createBrowserError("INVALID_REQUEST", "text 必须是字符串");
    }
    if (input.text.length > 4000) {
      throw createBrowserError("INVALID_REQUEST", "单次输入不能超过 4000 字符");
    }

    const shouldClear = input.clear !== false;
    const shouldSubmit = input.submit === true;
    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);
    const { locator, targetLabel, via } = resolveActionTarget(managedPage.page, input);

    try {
      await locator.first().waitFor({ state: "visible", timeout: 15_000 });
      await assertSingleMatch(locator, targetLabel);
      if (shouldClear) {
        await locator.fill(input.text, { timeout: 15_000 });
      } else {
        await locator.pressSequentially(input.text, { timeout: 15_000 });
      }
      if (shouldSubmit) {
        await locator.press("Enter", { timeout: 5_000 });
      }
    } catch (error) {
      throw mapLocatorActionError(error, "type", targetLabel);
    }

    session.lastUsedAt = Date.now();
    session.activePageId = managedPage.pageId;

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      selector: targetLabel,
      role: via === "role" ? normalizeA11yRole(input.role ?? "") : undefined,
      name: via === "role" ? normalizeA11yName(input.name ?? "") : undefined,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      typedLength: input.text.length,
      cleared: shouldClear,
      submitted: shouldSubmit
    };
  }

  /**
   * 窄动作：等待选择器到达指定状态。默认 visible。
   */
  async waitFor(input: {
    taskId: string;
    pageId?: string;
    selector: string;
    state?: "attached" | "detached" | "visible" | "hidden";
    timeoutMs?: number;
  }): Promise<BrowserWaitForData> {
    const selector = normalizeSelector(input.selector);
    const state =
      input.state === "attached"
      || input.state === "detached"
      || input.state === "hidden"
        ? input.state
        : "visible";
    const timeoutMs =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.min(60_000, Math.max(200, Math.floor(input.timeoutMs)))
        : 15_000;

    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);
    const startedAt = Date.now();

    try {
      await managedPage.page.locator(selector).waitFor({
        state,
        timeout: timeoutMs
      });
    } catch (error) {
      throw mapLocatorActionError(error, "waitFor", selector);
    }

    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      selector,
      state,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      waitedMs: Date.now() - startedAt
    };
  }

  /**
   * 阶段 G2：结构化抽取当前页（只读）。
   * mode=links|text|both；可选 scopeSelector 限定范围。
   */
  async extract(input: {
    taskId: string;
    pageId?: string;
    mode?: BrowserExtractMode;
    scopeSelector?: string;
    limit?: number;
    includeBelowFold?: boolean;
  }): Promise<BrowserExtractData> {
    const mode: BrowserExtractMode =
      input.mode === "text" || input.mode === "both" ? input.mode : "links";
    // extract 上限 40（比搜索结果多，便于列表页）
    const extractLimit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(40, Math.max(1, Math.floor(input.limit)))
        : 20;

    let scopeSelector: string | undefined;
    if (typeof input.scopeSelector === "string" && input.scopeSelector.trim()) {
      scopeSelector = normalizeSelector(input.scopeSelector);
    }

    const session = this.requireSession(input.taskId);
    const managedPage = this.requirePage(session, input.pageId ?? session.activePageId);

    // 若给了 scope，先确认范围内有节点，避免静默退回整页却不告知
    if (scopeSelector) {
      try {
        const scopeCount = await managedPage.page.locator(scopeSelector).count();
        if (scopeCount === 0) {
          throw createBrowserError(
            "PARSE_FAILED",
            `scopeSelector 未匹配到任何元素：${scopeSelector}`,
            { scopeSelector }
          );
        }
      } catch (error) {
        if (isBrowserCodedError(error)) {
          throw error;
        }
        throw createBrowserError(
          "INVALID_REQUEST",
          error instanceof Error
            ? `非法 scopeSelector：${error.message}`
            : "非法 scopeSelector",
          { scopeSelector }
        );
      }
    }

    let items;
    try {
      items = await extractPageStructure(managedPage.page, {
        mode,
        scopeSelector,
        limit: extractLimit,
        includeBelowFold: input.includeBelowFold === true
      });
    } catch (error) {
      throw createBrowserError(
        "PARSE_FAILED",
        error instanceof Error ? error.message : "页面抽取失败",
        { mode, scopeSelector }
      );
    }

    session.lastUsedAt = Date.now();

    return {
      taskId: session.taskId,
      pageId: managedPage.pageId,
      pageUrl: managedPage.page.url(),
      pageTitle: await managedPage.page.title(),
      mode,
      scopeSelector,
      items,
      count: items.length
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
  if (isBrowserCodedError(error)) {
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
