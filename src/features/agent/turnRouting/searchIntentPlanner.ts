/**
 * 浏览器回合的轻量搜索/打开意图规划（S2）。
 * 不执行工具，只把「平台 + 改写检索词 + 动作」写进 Prompt，
 * 避免模型把「好玩的博主」这类口语原句原封不动塞进搜索框。
 */

export type SearchPlatform = "bilibili" | "web" | "unknown";

export type BrowserIntentAction =
  | "search"
  | "open_site"
  | "open_latest_video"
  | "open_homepage"
  | "social_interact"
  | "download"
  | "generic_browse";

export type BrowserSearchIntentPlan = {
  platform: SearchPlatform;
  action: BrowserIntentAction;
  /** 建议检索词（已去口语外壳）；供 browser.search 使用 */
  queryCandidates: string[];
  /** 若可直接打开的站点首页 */
  siteUrlHint?: string;
  /** 注入 Prompt 的短约束 */
  promptHint: string;
};

const PLATFORM_SITE_URL: Record<string, string> = {
  bilibili: "https://www.bilibili.com",
  抖音: "https://www.douyin.com",
  快手: "https://www.kuaishou.com",
  小红书: "https://www.xiaohongshu.com",
  微博: "https://weibo.com",
  知乎: "https://www.zhihu.com",
  youtube: "https://www.youtube.com",
  淘宝: "https://www.taobao.com",
  京东: "https://www.jd.com",
  百度: "https://www.baidu.com"
};

/**
 * 从用户本轮话里提取浏览器意图。
 * 置信不足时返回 null，调用方不注入额外约束。
 */
export function planBrowserSearchIntent(userInput: string): BrowserSearchIntentPlan | null {
  const text = userInput.trim();
  if (!text) {
    return null;
  }

  const platform = detectPlatform(text);
  const action = detectAction(text, platform);
  if (!action) {
    return null;
  }

  const queryCandidates = buildQueryCandidates(text, platform, action);
  const siteUrlHint = resolveSiteUrlHint(text, platform, action);
  const promptHint = buildPromptHint({
    platform,
    action,
    queryCandidates,
    siteUrlHint
  });

  return {
    platform,
    action,
    queryCandidates,
    siteUrlHint,
    promptHint
  };
}

function detectPlatform(text: string): SearchPlatform {
  // 模糊全球榜单：最牛网红等跨平台，不默认 B 站
  if (/(?:最牛|最强|最厉害|最红|最火).{0,10}(?:网红|博主|主播)/.test(text)) {
    return "web";
  }
  if (/(?:B\s*站|哔哩哔哩|bilibili|up主|BV[\w]+)/i.test(text)) {
    return "bilibili";
  }
  // 未点名平台，但在找博主/视频：默认按 B 站处理（当前产品主场景）
  if (/(?:博主|up主|最新一期|最新视频|三连)/i.test(text)) {
    return "bilibili";
  }
  if (/(?:抖音|快手|小红书|微博|知乎|youtube|淘宝|京东|百度|谷歌|google)/i.test(text)) {
    return "web";
  }
  return "unknown";
}

function detectAction(text: string, platform: SearchPlatform): BrowserIntentAction | null {
  if (/(?:点赞|三连|收藏|投币|转发|关注|评论区|评论一下|评论这个|写评论|发评论)/.test(text)) {
    return "social_interact";
  }
  if (/(?:下载|安装包|抓取|拉取)/.test(text)) {
    return "download";
  }
  if (/(?:最新|最近).{0,8}(?:一期|一集|视频)|打开.{0,12}最新/.test(text)) {
    return "open_latest_video";
  }
  if (/(?:主页|首页|主页链接)/.test(text)) {
    return "open_homepage";
  }
  if (
    /(?:打开|进入|访问|去).{0,8}(?:快手|抖音|B\s*站|哔哩哔哩|小红书|微博|知乎|youtube)/i.test(text)
    || /^(?:打开|进入)\s*(?:快手|抖音|B\s*站|哔哩哔哩|小红书)\s*[。.!！?？]*$/i.test(text)
  ) {
    return "open_site";
  }
  if (/(?:搜索|搜一下|搜一搜|帮我搜|给我搜|查一下|上网查|找.{0,8}(?:视频|博主|up主|主播)|好玩|有趣|推荐)/.test(text)) {
    return "search";
  }
  if (/(?:打开|看一下|看看).{0,16}(?:视频|博主|网页|网站|链接)/.test(text)) {
    return "generic_browse";
  }
  if (platform !== "unknown") {
    return "generic_browse";
  }
  return null;
}

function buildQueryCandidates(
  text: string,
  platform: SearchPlatform,
  action: BrowserIntentAction
): string[] {
  const cleaned = stripSpeechShell(text);
  const candidates: string[] = [];

  // 模糊「好玩/有趣/推荐」类：展开为可检索风格词，禁止只用口语原句
  if (/(?:好玩|有趣|有意思|搞笑|沙雕|推荐|随便).{0,12}(?:博主|up主|视频|主播)/.test(text)
    || /(?:博主|up主|视频).{0,12}(?:好玩|有趣|有意思|搞笑|沙雕|推荐)/.test(text)) {
    if (platform === "bilibili" || /博主|up主|视频/.test(text)) {
      candidates.push("搞笑 博主", "沙雕 日常 up主", "有趣 冷知识 up");
    } else {
      candidates.push("搞笑博主", "有趣创作者");
    }
  }

  // 模糊“最牛/最火网红”类：展开为跨平台榜单检索词，避免模型空搜
  if (/(?:最牛|最强|最厉害|最红|最火|最热门).{0,10}(?:网红|博主|主播|up主)/.test(text)) {
    candidates.push("全球 YouTube 订阅最多网红 2024", "MrBeast YouTube channel", "抖音最火网红排行");
  }

  if (action === "open_latest_video") {
    const name = extractCreatorHint(cleaned);
    if (name) {
      candidates.push(`${name} 最新`, name);
    }
  }

  if (action === "search" || action === "generic_browse" || action === "open_homepage") {
    const name = extractCreatorHint(cleaned);
    if (name) {
      candidates.push(name);
    }
    if (cleaned && cleaned.length >= 2 && cleaned.length <= 40 && !candidates.includes(cleaned)) {
      // 去掉纯口语后的短句可作为候选，但仍优先具体名/风格词
      if (!/(?:打开|搜索|帮我|给我|一下|这个|那个)/.test(cleaned) || name) {
        candidates.push(cleaned);
      }
    }
  }

  // 去重并限制 3 条
  const unique: string[] = [];
  for (const item of candidates) {
    const q = item.trim();
    if (!q || unique.includes(q)) {
      continue;
    }
    unique.push(q);
    if (unique.length >= 3) {
      break;
    }
  }
  return unique;
}

function resolveSiteUrlHint(
  text: string,
  platform: SearchPlatform,
  action: BrowserIntentAction
): string | undefined {
  if (action !== "open_site" && action !== "generic_browse") {
    return platform === "bilibili" && action === "search"
      ? undefined
      : undefined;
  }
  if (/(?:B\s*站|哔哩哔哩|bilibili)/i.test(text) || platform === "bilibili" && action === "open_site") {
    return PLATFORM_SITE_URL.bilibili;
  }
  if (/快手/.test(text)) {
    return PLATFORM_SITE_URL.快手;
  }
  if (/抖音/.test(text)) {
    return PLATFORM_SITE_URL.抖音;
  }
  if (/小红书/.test(text)) {
    return PLATFORM_SITE_URL.小红书;
  }
  if (/微博/.test(text)) {
    return PLATFORM_SITE_URL.微博;
  }
  if (/知乎/.test(text)) {
    return PLATFORM_SITE_URL.知乎;
  }
  if (/youtube/i.test(text)) {
    return PLATFORM_SITE_URL.youtube;
  }
  if (/淘宝/.test(text)) {
    return PLATFORM_SITE_URL.淘宝;
  }
  if (/京东/.test(text)) {
    return PLATFORM_SITE_URL.京东;
  }
  if (/百度/.test(text)) {
    return PLATFORM_SITE_URL.百度;
  }
  return undefined;
}

function buildPromptHint(input: {
  platform: SearchPlatform;
  action: BrowserIntentAction;
  queryCandidates: string[];
  siteUrlHint?: string;
}): string {
  const lines: string[] = [
    "【本轮浏览器意图】",
    `平台倾向：${platformLabel(input.platform)}。`,
    `动作：${actionLabel(input.action)}。`
  ];

  if (input.siteUrlHint) {
    lines.push(
      `站点线索：可直接 browser.open 或 revealInSystemBrowser 打开 ${input.siteUrlHint}（用户要自己浏览器看时必须 reveal）。`
    );
  }

  if (input.queryCandidates.length > 0) {
    lines.push(
      `建议检索词（按序尝试，禁止只把用户口语原句原封不动当唯一 query）：${input.queryCandidates
        .map((item, index) => `${index + 1}.${item}`)
        .join("；")}。`
    );
  } else {
    lines.push("检索词：先把用户目标改写成具体名词/人名/作品名，再 search；禁止空转。");
  }

  if (input.platform === "bilibili") {
    lines.push("B 站搜索必须 browser.search 且 engine=bilibili。");
  }

  if (input.action === "open_latest_video") {
    lines.push(
      "打开最新视频：search 后从结果里选视频页 URL（含 /video/），再 open/reveal；没有 URL 禁止说已打开。"
    );
  }

  if (input.action === "social_interact") {
    lines.push(
      "社交互动：先确保当前在目标视频页（无 page 则 search→open）。",
      "点赞/收藏/关注：browser.extract 找按钮 → browser.click（selector 或 role+name）。",
      "B 站三连：browser.extract 定位点赞按钮后 browser.longPress（默认 holdMs=3000）；其它平台无三连则说明并改点赞/收藏。",
      "评论：extract/click 打开评论区 → browser.type 写入用户原话 → 发送；需确认则走确认。",
      "未登录、点不到或 longPress/click 失败时如实说明，禁止假称已点赞/已三连/已评论。"
    );
  }

  if (input.action === "search" && input.queryCandidates.some((item) => /搞笑|沙雕|有趣/.test(item))) {
    lines.push(
      "模糊推荐：可先 search 得到具体候选，再向用户口头确认打开哪一个；用户说随便则打开第一条并说明理由。"
    );
  }

  return lines.join("\n");
}

function platformLabel(platform: SearchPlatform) {
  if (platform === "bilibili") {
    return "B站";
  }
  if (platform === "web") {
    return "全网/指定站点";
  }
  return "未指定（可按上下文默认 B站找博主视频）";
}

function actionLabel(action: BrowserIntentAction) {
  switch (action) {
    case "search":
      return "搜索/找人找视频";
    case "open_site":
      return "打开站点";
    case "open_latest_video":
      return "打开最新视频";
    case "open_homepage":
      return "打开主页";
    case "social_interact":
      return "点赞/三连/评论等互动";
    case "download":
      return "下载";
    default:
      return "浏览/打开";
  }
}

/** 去掉礼貌/指令外壳，留下可能的检索主体 */
function stripSpeechShell(text: string) {
  return text
    .replace(/^(?:请|麻烦|帮我|给我|你|VOID)?(?:去|再)?/i, "")
    .replace(/(?:一下|一哈|呗|吧|啊|呀|呢|嘛)+$/g, "")
    .replace(/(?:搜索|搜一下|搜一搜|打开|进入|访问|看看|看一下|找)/g, " ")
    .replace(/(?:在|用)?(?:edge|chrome|浏览器|里|中)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 尝试抽出「某某的最新视频」里的创作者名 */
function extractCreatorHint(text: string) {
  const patterns = [
    /([A-Za-z0-9_一-鿿]{2,20})的?(?:最新|最近)?(?:一期|一集)?视频/,
    /(?:博主|up主|主播)\s*([A-Za-z0-9_一-鿿]{2,20})/,
    /([A-Za-z0-9_一-鿿]{2,20})\s*(?:博主|up主)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && !/(?:这个|那个|最新|有趣|好玩|搞笑)/.test(match[1])) {
      return match[1];
    }
  }
  return null;
}
