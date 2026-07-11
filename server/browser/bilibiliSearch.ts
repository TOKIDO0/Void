/**
 * B 站站内搜索结果解析（公开搜索页，无登录）。
 * 入口：https://search.bilibili.com/all?keyword=...
 * 优先抽视频卡 /video/BV... 链接与标题。
 */

import type { Page } from "playwright";
import type { BrowserSearchResultItem } from "./browserTypes";

/**
 * 构建 B 站综合搜索 URL。
 */
export function buildBilibiliSearchUrl(query: string): string {
  const trimmed = query.trim();
  const params = new URLSearchParams({ keyword: trimmed });
  return `https://search.bilibili.com/all?${params.toString()}`;
}

/**
 * 从 B 站搜索页抽取结构化结果（视频优先）。
 */
export async function extractBilibiliSearchResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));

  // 等结果区或任意视频链接出现；超时不抛，后面返回空列表
  await page
    .waitForSelector(
      'a[href*="/video/"], .bili-video-card, .video-list .video-item, .search-content',
      { timeout: 18_000 }
    )
    .catch(() => undefined);

  // 再等一小会儿给前端渲染
  await page.waitForTimeout(800).catch(() => undefined);

  const rawItems = await page.evaluate((maxCount) => {
    const items: Array<{
      title: string;
      href: string;
      snippet: string;
      displayUrl: string;
    }> = [];
    const seen = new Set<string>();

    const pushItem = (title: string, href: string, snippet: string) => {
      if (items.length >= maxCount) {
        return;
      }
      const cleanTitle = title.replace(/\s+/g, " ").trim();
      if (!cleanTitle || !href) {
        return;
      }
      let absolute = href.trim();
      if (absolute.startsWith("//")) {
        absolute = `https:${absolute}`;
      } else if (absolute.startsWith("/")) {
        absolute = `https://www.bilibili.com${absolute}`;
      }
      // 只收视频页，去掉查询参数噪声
      try {
        const url = new URL(absolute);
        if (!url.pathname.includes("/video/")) {
          return;
        }
        // 归一化到 https://www.bilibili.com/video/BVxxx
        const match = url.pathname.match(/\/video\/(BV[\w]+)/i);
        if (!match) {
          return;
        }
        const normalized = `https://www.bilibili.com/video/${match[1]}`;
        if (seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        items.push({
          title: cleanTitle,
          href: normalized,
          snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 240),
          displayUrl: normalized
        });
      } catch {
        // 非法 URL 跳过
      }
    };

    // 1) 新版视频卡
    const cards = Array.from(
      document.querySelectorAll(
        ".bili-video-card, .video-list .video-item, .bili-video-card__wrap"
      )
    );
    for (const card of cards) {
      if (items.length >= maxCount) {
        break;
      }
      const link =
        (card.querySelector('a[href*="/video/"]') as HTMLAnchorElement | null)
        ?? (card.matches('a[href*="/video/"]') ? (card as HTMLAnchorElement) : null);
      if (!link?.href) {
        continue;
      }
      const titleEl =
        card.querySelector(".bili-video-card__info--tit, .title, h3, a[title]")
        ?? link;
      const title =
        (titleEl as HTMLElement).getAttribute("title")
        || (titleEl.textContent ?? "")
        || link.getAttribute("title")
        || "";
      const snippetEl = card.querySelector(
        ".bili-video-card__info--bottom, .bili-video-card__info--author, .info, .des"
      );
      pushItem(title, link.href, snippetEl?.textContent ?? "");
    }

    // 2) 兜底：页面上所有 /video/ 链接
    if (items.length < maxCount) {
      const anchors = Array.from(
        document.querySelectorAll('a[href*="/video/BV"]')
      ) as HTMLAnchorElement[];
      for (const anchor of anchors) {
        if (items.length >= maxCount) {
          break;
        }
        const title =
          anchor.getAttribute("title")
          || anchor.textContent
          || "";
        pushItem(title, anchor.href, "");
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
