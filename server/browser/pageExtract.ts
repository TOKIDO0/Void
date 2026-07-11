/**
 * 阶段 G2：页面结构化抽取（Playwright evaluate 薄封装）。
 *
 * 设计：
 * - 不引入 Stagehand / 额外 LLM（见 18 调研 4 格）
 * - 在页面上下文跑纯函数，返回稳定 JSON
 * - 链接优先；text 模式抽可见标题/段落；both 合并
 * - 尽量给出 suggestedSelector，辅助后续 click（不保证 100% 唯一）
 *
 * 重要：不要把 evaluate 回调直接写成 TS 箭头/function——tsx 会注入 __name，
 * 浏览器端 ReferenceError。使用 new Function(字符串) 在运行时生成函数体。
 */

import type { Page } from "playwright";
import type {
  BrowserExtractItem,
  BrowserExtractMode
} from "./browserTypes";

export type PageExtractOptions = {
  mode: BrowserExtractMode;
  /** 限定范围的 CSS/Playwright 选择器；空=整页 */
  scopeSelector?: string;
  /** 最多返回条数，调用方已 clamp */
  limit: number;
};

type RawExtractItem = {
  kind: "link" | "text";
  text: string;
  href?: string;
  tagName?: string;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  nameAttr?: string;
};

type ExtractPayload = {
  mode: BrowserExtractMode;
  limit: number;
  scopeSelector: string;
};

/**
 * 浏览器内函数体（仅字符串，不被 tsx 改写）。
 * 参数名 payload，字段：mode / limit / scopeSelector。
 */
const BROWSER_EXTRACT_BODY = `
  var mode = payload.mode;
  var limit = payload.limit;
  var scopeSelector = payload.scopeSelector;
  var MAX_TEXT = 240;
  function normalizeText(value) {
    if (!value) return "";
    return String(value).replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT);
  }
  function isVisible(element) {
    if (!element || element.hidden) return false;
    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  var root = scopeSelector
    ? (document.querySelector(scopeSelector) || document)
    : document;
  function collectMeta(element) {
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || undefined,
      testId: element.getAttribute("data-testid") || undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
      role: element.getAttribute("role") || undefined,
      nameAttr: element.name || undefined
    };
  }
  var items = [];
  var seenLinkKeys = {};
  var i;

  if (mode === "links" || mode === "both") {
    var anchors = Array.prototype.slice.call(root.querySelectorAll("a[href]"));
    for (i = 0; i < anchors.length; i++) {
      if (items.length >= limit) break;
      var anchor = anchors[i];
      if (!isVisible(anchor)) continue;
      var hrefRaw = anchor.getAttribute("href") || "";
      var href = hrefRaw;
      try {
        href = new URL(hrefRaw, window.location.href).toString();
      } catch (e) {}
      if (
        href.indexOf("javascript:") === 0
        || href.indexOf("mailto:") === 0
        || href.indexOf("tel:") === 0
      ) {
        continue;
      }
      var linkText =
        normalizeText(anchor.textContent)
        || normalizeText(anchor.getAttribute("aria-label"))
        || normalizeText(href);
      if (!linkText) continue;
      var key = href + "::" + linkText;
      if (seenLinkKeys[key]) continue;
      seenLinkKeys[key] = true;
      var linkItem = collectMeta(anchor);
      linkItem.kind = "link";
      linkItem.text = linkText;
      linkItem.href = href;
      items.push(linkItem);
    }
  }

  if (mode === "text" || mode === "both") {
    var textBudget = mode === "both" ? Math.max(0, limit - items.length) : limit;
    if (textBudget > 0) {
      var selectorList = [
        "h1", "h2", "h3", "h4", "[role='heading']",
        "p", "li", "button", "[role='button']", "label", "td", "th"
      ].join(",");
      var candidates = Array.prototype.slice.call(root.querySelectorAll(selectorList));
      var seenText = {};
      var added = 0;
      for (i = 0; i < candidates.length; i++) {
        if (added >= textBudget) break;
        var element = candidates[i];
        if (element.closest("a[href]")) continue;
        if (!isVisible(element)) continue;
        var text = normalizeText(element.textContent);
        if (text.length < 2) continue;
        if (seenText[text]) continue;
        seenText[text] = true;
        var textItem = collectMeta(element);
        textItem.kind = "text";
        textItem.text = text;
        items.push(textItem);
        added++;
      }
    }
  }

  return items.slice(0, limit);
`;

function createBrowserExtractFunction(): (payload: ExtractPayload) => RawExtractItem[] {
  // 运行时生成，避免源码级回调被 tsx 注入 __name
  // eslint-disable-next-line no-new-func
  return new Function("payload", BROWSER_EXTRACT_BODY) as (
    payload: ExtractPayload
  ) => RawExtractItem[];
}

/**
 * 在 Page 上执行抽取。异常由调用方映射为 PARSE_FAILED。
 */
export async function extractPageStructure(
  page: Page,
  options: PageExtractOptions
): Promise<BrowserExtractItem[]> {
  const mode = options.mode;
  const limit = options.limit;
  const scopeSelector = options.scopeSelector?.trim() || "";
  const browserFn = createBrowserExtractFunction();

  const rawItems = (await page.evaluate(browserFn, {
    mode,
    limit,
    scopeSelector
  })) as RawExtractItem[];

  if (!Array.isArray(rawItems)) {
    throw new Error("页面抽取返回非数组");
  }

  return rawItems.map((item, index) => ({
    index: index + 1,
    kind: item.kind,
    text: item.text,
    href: item.href,
    tagName: item.tagName,
    suggestedSelector: buildSuggestedSelector(item)
  }));
}

/**
 * 用稳定属性拼选择器；无法拼出则返回 undefined。
 * 不做 document 唯一性校验；调用方 click 时仍有单匹配门禁。
 */
function buildSuggestedSelector(item: RawExtractItem): string | undefined {
  if (item.testId) {
    return `[data-testid="${escapeAttr(item.testId)}"]`;
  }
  if (item.id && /^[A-Za-z][\w:-]*$/.test(item.id)) {
    return `#${item.id}`;
  }
  if (item.kind === "link" && item.href) {
    try {
      const url = new URL(item.href);
      const path = url.pathname.length > 1 ? url.pathname : "";
      if (path && path.length <= 120) {
        const hrefSelector = `a[href*="${escapeAttr(path)}"]`;
        if (item.text && item.text.length <= 40 && !item.text.includes('"')) {
          return `${hrefSelector}:has-text("${item.text}")`;
        }
        return hrefSelector;
      }
    } catch {
      // fall through
    }
    if (item.text && item.text.length <= 40 && !item.text.includes('"')) {
      return `a:has-text("${item.text}")`;
    }
  }
  if (item.ariaLabel && item.ariaLabel.length <= 60) {
    const tag = item.tagName && /^[a-z0-9]+$/.test(item.tagName) ? item.tagName : "";
    return `${tag || "*"}[aria-label="${escapeAttr(item.ariaLabel)}"]`;
  }
  if (
    item.kind === "text"
    && item.tagName
    && /^h[1-6]$/.test(item.tagName)
    && item.text
    && item.text.length <= 40
    && !item.text.includes('"')
  ) {
    return `${item.tagName}:has-text("${item.text}")`;
  }
  return undefined;
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
