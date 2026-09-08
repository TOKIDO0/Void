import { Icon } from "@iconify/react";
import { openExternalUrl } from "../../lib/runtime/openExternalUrl";

/**
 * AI 实时状态行：历史视图里 AI 正在回复时，替代光秃秃的 "..."，
 * 显示当前在做什么（在搜索 / 在整理信息…），数据来自工具进度中文文案。
 */
export function AgentLiveStatus({ label }: { label: string }) {
  return (
    <span className="agent-live-status" role="status" aria-live="polite">
      <span className="agent-live-status__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="agent-live-status__label">{label || "正在思考…"}</span>
    </span>
  );
}

export type CitationLink = {
  url: string;
  domain: string;
};

const URL_PATTERN = /https?:\/\/[^\s)>"'，。！？、；：」』]+/g;
const TRAILING_PUNCT = /[.,;:!?)\]}，。！？；：、」』]+$/;
const MAX_CITATIONS = 6;

/** 从回复正文里抽可验证的来源链接（去重，上限 6 个）。 */
export function extractCitationLinks(content: string): CitationLink[] {
  const found = content.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const links: CitationLink[] = [];
  for (const raw of found) {
    const url = raw.replace(TRAILING_PUNCT, "");
    let domain = "";
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (!domain || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push({ url, domain });
    if (links.length >= MAX_CITATIONS) {
      break;
    }
  }
  return links;
}

/** 来源徽标：品牌彩色图标（Iconify theSVG Color）+ 域名，点击走系统浏览器打开。 */
export function CitationChips({ links }: { links: CitationLink[] }) {
  if (!links.length) {
    return null;
  }
  return (
    <span className="citation-chips">
      {links.map((link) => {
        const brandIcon = resolveBrandIcon(link.domain);
        return (
          <button
            key={link.url}
            type="button"
            className="citation-chips__chip"
            title={link.url}
            onClick={() => void openExternalUrl(link.url)}
          >
            {brandIcon ? (
              <Icon
                className="citation-chips__brand"
                icon={`thesvg-color:${brandIcon}`}
                aria-hidden="true"
              />
            ) : (
              <Icon
                className="citation-chips__brand"
                icon="solar:global-linear"
                aria-hidden="true"
              />
            )}
            <span className="citation-chips__domain">{link.domain}</span>
          </button>
        );
      })}
    </span>
  );
}

/**
 * 域名 → theSVG Color 图标名（仅收录已在图标库核验存在的命名，未收录返回 null 走通用地球图标）。
 * 深色面板优先用 -light 变体（如 github-light），单色标用原名。
 */
function resolveBrandIcon(domain: string): string | null {
  const host = domain.toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/github\.com$/, "github-light"],
    [/youtu\.?be(\.com)?$/, "youtube"],
    [/^(twitter|x)\.com$/, "twitter"],
    [/bilibili\.com$|b23\.tv$/, "bilibili"],
    [/zhihu\.com$/, "zhihu"],
    [/baidu\.com$/, "baidu"],
    [/bing\.com$/, "bing"],
    [/douban\.com$/, "douban"],
    [/taobao\.com$/, "taobao"],
    [/xiaohongshu\.com$/, "xiaohongshu"],
    [/csdn\.net$/, "csdn"],
    [/juejin\.cn$/, "juejin"],
    [/v2ex\.com$/, "v2ex"],
    [/reddit\.com$/, "reddit"],
    [/medium\.com$/, "medium"],
    [/google\./, "google"],
    [/microsoft\.com$/, "microsoft"],
    [/deepseek\.com$/, "deepseek"],
    [/doubao\.com$/, "doubao"],
    [/wechat\.com$/, "wechat"],
    [/git-scm\.com$/, "git"]
  ];
  for (const [pattern, icon] of table) {
    if (pattern.test(host)) {
      return icon;
    }
  }
  return null;
}
