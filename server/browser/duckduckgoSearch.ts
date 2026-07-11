/**
 * DuckDuckGo HTML 版搜索结果解析。
 * 站点：https://html.duckduckgo.com/html/（静态 HTML，无登录）
 * 结构化定位：#links .result / .result__a / .result__snippet
 * 参考：Playwright 官方 BrowserContext 隔离；DDG HTML 结果类名社区实践。
 */

import type { Page } from "playwright";
import type { BrowserSearchResultItem } from "./browserTypes";

const DUCKDUCKGO_HTML_ORIGIN = "https://html.duckduckgo.com";

/**
 * 构建 DDG HTML 搜索 URL。
 */
export function buildDuckDuckGoHtmlSearchUrl(query: string): string {
  const trimmed = query.trim();
  const params = new URLSearchParams({ q: trimmed });
  return `${DUCKDUCKGO_HTML_ORIGIN}/html/?${params.toString()}`;
}

/**
 * 从 DDG 跳转链或直链中解析真实目标 URL。
 * 常见形态：//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com
 */
export function resolveDuckDuckGoTargetUrl(rawHref: string): string {
  if (!rawHref) {
    return "";
  }

  let href = rawHref.trim();
  if (href.startsWith("//")) {
    href = `https:${href}`;
  }

  try {
    const parsed = new URL(href);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return parsed.toString();
  } catch {
    return href;
  }
}

/**
 * 在当前页面上抽取结构化搜索结果。
 * 不假设上一步一定成功：找不到结果容器时返回空数组，由上层决定是否报错。
 */
export async function extractDuckDuckGoResults(
  page: Page,
  limit: number
): Promise<BrowserSearchResultItem[]> {
  const safeLimit = Math.min(20, Math.max(1, Math.floor(limit)));

  // 等待结果区出现；超时由调用方统一处理。
  await page.waitForSelector("#links .result, .results .result, .result__a", {
    timeout: 15_000
  }).catch(() => {
    // 无结果时不抛，后面返回空列表。
  });

  const rawItems = await page.locator("#links .result, .results .result").evaluateAll(
    (nodes, maxCount) => {
      const items: Array<{
        title: string;
        href: string;
        snippet: string;
        displayUrl: string;
      }> = [];

      for (const node of nodes) {
        if (items.length >= maxCount) {
          break;
        }

        // 广告/赞助位跳过（若带广告标记）
        const className = typeof (node as HTMLElement).className === "string"
          ? (node as HTMLElement).className
          : "";
        if (className.includes("result--ad") || className.includes("has-ad")) {
          continue;
        }

        const anchor = node.querySelector("a.result__a") as HTMLAnchorElement | null;
        if (!anchor) {
          continue;
        }

        const title = (anchor.textContent ?? "").trim();
        const href = anchor.getAttribute("href") ?? "";
        if (!title || !href) {
          continue;
        }

        const snippetNode = node.querySelector(".result__snippet");
        const displayUrlNode = node.querySelector(".result__url");
        items.push({
          title,
          href,
          snippet: (snippetNode?.textContent ?? "").trim(),
          displayUrl: (displayUrlNode?.textContent ?? "").trim()
        });
      }

      return items;
    },
    safeLimit
  );

  return rawItems.map((item, index) => ({
    rank: index + 1,
    title: item.title,
    url: resolveDuckDuckGoTargetUrl(item.href),
    snippet: item.snippet,
    displayUrl: item.displayUrl || undefined
  })).filter((item) => item.url.length > 0);
}
