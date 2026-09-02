/**
 * 站点薄适配：知乎 / 抖音 / 小红书 / 微博 等结构化抽取与搜索。
 * 原则：只提供选择器与 URL 构造，复用 browserSessionManager / pageExtract 的通用链路，不引入新运行面。
 * 所有解析在页面端 evaluate 内完成，失败静默回落到通用抽取。
 */

import type { Page } from "playwright";
import type { BrowserSearchResultItem } from "./browserTypes";

// —— 搜索 URL 构造 ——

export function buildZhihuSearchUrl(query: string): string {
  const trimmed = query.trim();
  const params = new URLSearchParams({ type: "content", q: trimmed });
  return `https://www.zhihu.com/search?${params.toString()}`;
}

export function buildDouyinSearchUrl(query: string): string {
  const trimmed = query.trim();
  return `https://www.douyin.com/search/${encodeURIComponent(trimmed)}`;
}

export function buildXiaohongshuSearchUrl(query: string): string {
  const trimmed = query.trim();
  const params = new URLSearchParams({ keyword: trimmed, source: "web_search_result_notes" });
  return `https://www.xiaohongshu.com/search_result?${params.toString()}`;
}

export function buildWeiboSearchUrl(query: string): string {
  const trimmed = query.trim();
  return `https://s.weibo.com/weibo?q=${encodeURIComponent(trimmed)}`;
}

// —— 知乎搜索结果抽取 ——

export async function extractZhihuSearchResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await page
    .waitForSelector(
      ".SearchResult-Card, .ContentItem, .List-item, a[href*=\"/question/\"], a[href*=\"/answer/\"]",
      { timeout: 18_000 }
    )
    .catch(() => undefined);
  await page.waitForTimeout(900).catch(() => undefined);

  const rawItems = await page.evaluate((maxCount) => {
    const items: Array<{ title: string; href: string; snippet: string; displayUrl: string }> = [];
    const seen = new Set<string>();
    const push = (title: string, href: string, snippet: string) => {
      if (items.length >= maxCount) return;
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || !href) return;
      let absolute = href.trim();
      if (absolute.startsWith("//")) absolute = `https:${absolute}`;
      else if (absolute.startsWith("/")) absolute = `https://www.zhihu.com${absolute}`;
      try {
        const url = new URL(absolute);
        if (!url.hostname.includes("zhihu.com")) return;
        // 仅收问题/回答/文章
        if (
          !url.pathname.includes("/question/") &&
          !url.pathname.includes("/answer/") &&
          !url.pathname.includes("/p/")
        ) {
          return;
        }
        const normalized = url.toString();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        items.push({
          title: cleanTitle.slice(0, 120),
          href: normalized,
          snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
          displayUrl: normalized
        });
      } catch {
        // ignore
      }
    };

    const cards = Array.from(
      document.querySelectorAll(".SearchResult-Card, .ContentItem, .List-item")
    );
    for (const card of cards) {
      if (items.length >= maxCount) break;
      const anchor =
        (card.querySelector("a[href*=\"/question/\"]") as HTMLAnchorElement | null) ??
        (card.querySelector("a[href*=\"/answer/\"]") as HTMLAnchorElement | null) ??
        (card.querySelector("a[href*=\"/p/\"]") as HTMLAnchorElement | null) ??
        (card.querySelector("a") as HTMLAnchorElement | null);
      if (!anchor?.href) continue;
      const titleEl =
        card.querySelector(".ContentItem-title, h2, [class*=\"Title\"]") ?? anchor;
      const title = (titleEl.textContent ?? "") || anchor.getAttribute("title") || "";
      const snippetEl = card.querySelector(
        ".RichText, .ContentItem-excerpt, .SearchResult-Card-excerpt"
      );
      push(title, anchor.href, snippetEl?.textContent ?? "");
    }

    if (items.length < maxCount) {
      const anchors = Array.from(
        document.querySelectorAll('a[href*="zhihu.com/question"], a[href*="zhihu.com/p/"]')
      ) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        if (items.length >= maxCount) break;
        push(anchor.textContent ?? "", anchor.href, "");
      }
    }
    return items;
  }, safeLimit);

  return rawItems.map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: item.href,
    snippet: item.snippet,
    displayUrl: item.displayUrl
  }));
}

// —— 抖音搜索结果抽取 ——

export async function extractDouyinSearchResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await page
    .waitForSelector(
      'a[href*="/video/"], [data-e2e="search-card"], .search-result, [class*="video"]',
      { timeout: 18_000 }
    )
    .catch(() => undefined);
  await page.waitForTimeout(1200).catch(() => undefined);

  const rawItems = await page.evaluate((maxCount) => {
    const items: Array<{ title: string; href: string; snippet: string; displayUrl: string }> = [];
    const seen = new Set<string>();
    const push = (title: string, href: string, snippet: string) => {
      if (items.length >= maxCount) return;
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || !href) return;
      let absolute = href.trim();
      if (absolute.startsWith("//")) absolute = `https:${absolute}`;
      else if (absolute.startsWith("/")) absolute = `https://www.douyin.com${absolute}`;
      try {
        const url = new URL(absolute);
        if (!url.hostname.includes("douyin.com")) return;
        if (!url.pathname.includes("/video/") && !url.pathname.includes("/note/")) return;
        const normalized = `https://www.douyin.com${url.pathname}`;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        items.push({
          title: cleanTitle.slice(0, 120),
          href: normalized,
          snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
          displayUrl: normalized
        });
      } catch {
        // ignore
      }
    };

    const cards = Array.from(
      document.querySelectorAll('[data-e2e="search-card"], .search-result-card, [class*="Card"]')
    );
    for (const card of cards) {
      if (items.length >= maxCount) break;
      const anchor = card.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null;
      if (!anchor?.href) continue;
      const title =
        card.querySelector('[data-e2e="video-title"], .title, span')?.textContent ?? anchor.textContent ?? "";
      push(title, anchor.href, "");
    }

    if (items.length < maxCount) {
      const anchors = Array.from(
        document.querySelectorAll('a[href*="douyin.com/video"]')
      ) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        if (items.length >= maxCount) break;
        const title = anchor.getAttribute("title") || anchor.textContent || "";
        push(title, anchor.href, "");
      }
    }
    return items;
  }, safeLimit);

  return rawItems.map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: item.href,
    snippet: item.snippet,
    displayUrl: item.displayUrl
  }));
}

// —— 小红书搜索结果抽取 ——

export async function extractXiaohongshuSearchResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await page
    .waitForSelector(
      'a[href*="/explore/"], .note-item, .feed-card, [class*="search"]',
      { timeout: 18_000 }
    )
    .catch(() => undefined);
  await page.waitForTimeout(1100).catch(() => undefined);

  const rawItems = await page.evaluate((maxCount) => {
    const items: Array<{ title: string; href: string; snippet: string; displayUrl: string }> = [];
    const seen = new Set<string>();
    const push = (title: string, href: string, snippet: string) => {
      if (items.length >= maxCount) return;
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || !href) return;
      let absolute = href.trim();
      if (absolute.startsWith("//")) absolute = `https:${absolute}`;
      else if (absolute.startsWith("/")) absolute = `https://www.xiaohongshu.com${absolute}`;
      try {
        const url = new URL(absolute);
        if (!url.hostname.includes("xiaohongshu.com")) return;
        if (!url.pathname.includes("/explore/") && !url.pathname.includes("/discovery/")) return;
        const normalized = url.toString().split("?")[0]!;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        items.push({
          title: cleanTitle.slice(0, 120),
          href: normalized,
          snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
          displayUrl: normalized
        });
      } catch {
        // ignore
      }
    };

    const cards = Array.from(document.querySelectorAll(".note-item, .feed-card, [class*=\"Card\"]"));
    for (const card of cards) {
      if (items.length >= maxCount) break;
      const anchor = card.querySelector('a[href*="/explore/"]') as HTMLAnchorElement | null;
      if (!anchor?.href) continue;
      const title =
        card.querySelector(".title, [class*=\"title\"], span")?.textContent ?? anchor.textContent ?? "";
      push(title, anchor.href, "");
    }

    if (items.length < maxCount) {
      const anchors = Array.from(document.querySelectorAll('a[href*="xiaohongshu.com/explore"]')) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        if (items.length >= maxCount) break;
        push(anchor.textContent ?? "", anchor.href, "");
      }
    }
    return items;
  }, safeLimit);

  return rawItems.map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: item.href,
    snippet: item.snippet,
    displayUrl: item.displayUrl
  }));
}

// —— 微博搜索结果抽取 ——

export async function extractWeiboSearchResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));
  await page
    .waitForSelector(
      '.card-wrap, [class*="card"], [action-type="feed_list_item"]',
      { timeout: 18_000 }
    )
    .catch(() => undefined);
  await page.waitForTimeout(1100).catch(() => undefined);

  const rawItems = await page.evaluate((maxCount) => {
    const items: Array<{ title: string; href: string; snippet: string; displayUrl: string }> = [];
    const seen = new Set<string>();
    const push = (title: string, href: string, snippet: string) => {
      if (items.length >= maxCount) return;
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || !href) return;
      let absolute = href.trim();
      if (absolute.startsWith("//")) absolute = `https:${absolute}`;
      else if (absolute.startsWith("/")) absolute = `https://s.weibo.com${absolute}`;
      try {
        const url = new URL(absolute);
        if (!url.hostname.includes("weibo.com") && !url.hostname.includes("weibo.cn")) return;
        const normalized = url.toString();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        items.push({
          title: cleanTitle.slice(0, 120),
          href: normalized,
          snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
          displayUrl: normalized
        });
      } catch {
        // ignore
      }
    };

    const cards = Array.from(document.querySelectorAll('.card-wrap, [action-type="feed_list_item"]'));
    for (const card of cards) {
      if (items.length >= maxCount) break;
      const anchor =
        card.querySelector('a[href*="/status/"], a[href*="weibo.com"]') as HTMLAnchorElement | null;
      if (!anchor?.href) continue;
      const textEl = card.querySelector(".txt, .content, p") as HTMLElement | null;
      const title = textEl?.textContent ?? anchor.textContent ?? "";
      push(title, anchor.href, textEl?.textContent ?? "");
    }

    if (items.length < maxCount) {
      const anchors = Array.from(document.querySelectorAll('a[href*="weibo.com"]')) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        if (items.length >= maxCount) break;
        push(anchor.textContent ?? "", anchor.href, "");
      }
    }
    return items;
  }, safeLimit);

  return rawItems.map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: item.href,
    snippet: item.snippet,
    displayUrl: item.displayUrl
  }));
}

// —— 站点页面抽取优先级 Scope ——
// 当 browser.extract 未指定 scopeSelector 且 mode 含 text，按 host 给出首选容器，便于 model 少写选择器。

export function getPreferredExtractScopeForUrl(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("zhihu.com")) {
      // 回答页正文 / 问题标题区
      return ".Post-RichText, .RichText, .QuestionHeader, .ContentItem";
    }
    if (host.includes("douyin.com")) {
      return '[data-e2e="feed-video"], .video-info, .player-container';
    }
    if (host.includes("xiaohongshu.com")) {
      return ".note-content, .content, .feed-card";
    }
    if (host.includes("weibo.com") || host.includes("weibo.cn")) {
      return ".WB_detail, .card-wrap, article";
    }
    if (host.includes("bilibili.com")) {
      // 视频页：标题+简介；动态页 fallback
      return "#viewbox_report, .video-info, .bili-video-card";
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type SiteEngine = "duckduckgo" | "bilibili" | "zhihu" | "douyin" | "xiaohongshu" | "weibo";
