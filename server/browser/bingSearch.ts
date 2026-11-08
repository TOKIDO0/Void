/**
 * Bing 搜索结果解析（国内默认 cn.bing.com，直连快、中文结果好）。
 * 结构化定位：li.b_algo h2 a + .b_caption p / .b_snippet。
 * 反爬比 Duck 强：调用方需走 Playwright 自动化，不做裸 fetch。
 */

import type { Page } from "playwright";
import type { BrowserSearchResultItem } from "./browserTypes";

const BING_CN_ORIGIN = "https://cn.bing.com";

export function buildBingSearchUrl(query: string): string {
  const trimmed = query.trim();
  const params = new URLSearchParams({ q: trimmed });
  return `${BING_CN_ORIGIN}/search?${params.toString()}`;
}

export async function extractBingResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));

  await page.waitForSelector("li.b_algo h2 a, #b_results li.b_algo", {
    timeout: 15_000
  }).catch(() => {
    // 无结果时不抛，后面返回空列表由上层回退。
  });

  const rawItems = await page.locator("li.b_algo").evaluateAll(
    (nodes, maxCount) => {
      const items: Array<{ title: string; href: string; snippet: string }> = [];
      for (const node of nodes) {
        if (items.length >= maxCount) break;
        const anchor = node.querySelector("h2 a") as HTMLAnchorElement | null;
        if (!anchor) continue;
        const title = (anchor.textContent ?? "").trim();
        const href = anchor.getAttribute("href") ?? "";
        if (!title || !href) continue;
        if (href.startsWith("javascript:") || href === "#") continue;
        const snippetNode =
          node.querySelector(".b_caption p, .b_snippet, p.b_paractl") as HTMLElement | null;
        items.push({
          title,
          href,
          snippet: (snippetNode?.textContent ?? "").trim()
        });
      }
      return items;
    },
    safeLimit
  );

  return rawItems
    .map((item, index) => {
      let url = item.href.trim();
      try {
        // Bing 偶发相对路径，补齐为绝对 URL。
        url = new URL(url, BING_CN_ORIGIN).toString();
      } catch {
        // 保留原文，由 filter 兜底。
      }
      return {
        rank: index + 1,
        title: item.title.replace(/\s+/g, " ").trim().slice(0, 120),
        url,
        snippet: item.snippet.replace(/\s+/g, " ").trim().slice(0, 240),
        displayUrl: undefined
      };
    })
    .filter((item) => item.url.startsWith("http"));
}
