import { isSoftwareInstallerIntent } from "../software/softwareDownloadIntent";
import type { VoidConversationMessage } from "../voidConversation";

export type TurnCapability =
  | "conversation"
  | "browser"
  | "file"
  | "desktop"
  | "clipboard"
  | "software";

export type TurnCapabilityRoute = {
  capability: TurnCapability;
  allowedToolNames: string[];
  resumedFromHistory: boolean;
};

/**
 * 浏览器/下载主路径工具。
 * T3.a：附带 list/createDirectory/move，使「下载并整理到子目录」可在同一能力回合完成，
 * 无需再切到纯 file 能力（纯 file 没有 download*）。
 * T3.c：附带 desktop.revealPath，使 place+verify 成功后可在同一回合打开落盘位置；
 * 不塞入 openKnownLocation 等其它桌面能力。
 */
const BROWSER_TOOL_NAMES = [
  "browser.open",
  "browser.search",
  "browser.selectTarget",
  "browser.revealInSystemBrowser",
  "browser.click",
  "browser.longPress",
  "browser.type",
  "browser.waitFor",
  "browser.extract",
  "browser.tabs",
  "browser.switchTab",
  "file.downloadToTemp",
  "file.downloadMediaPage",
  "file.placeDownload",
  "file.verify",
  "file.listDirectory",
  "file.createDirectory",
  "file.move",
  "desktop.revealPath"
];

/**
 * T3.b：剪贴板 URL 下载。
 * 必须同时暴露 clipboard.read 与 download*；仅 clipboard 没有下载，仅 browser 读不到剪贴板。
 * 继承 BROWSER_TOOL_NAMES，因此同样含 T3.c 的 desktop.revealPath。
 */
const CLIPBOARD_DOWNLOAD_TOOL_NAMES = [
  "clipboard.read",
  ...BROWSER_TOOL_NAMES
];

const FILE_TOOL_NAMES = [
  "file.listDirectory",
  "file.readText",
  "file.createDirectory",
  "file.move",
  "file.verify",
  "desktop.revealPath"
];

const DESKTOP_TOOL_NAMES = [
  "desktop.openKnownLocation"
];

const CLIPBOARD_TOOL_NAMES = [
  "clipboard.read",
  "clipboard.write"
];

/**
 * 官方软件安装包自动化（通用领域，非某一站专线）。
 * list → resolve → downloadInstaller → 可选 revealPath。
 */
const SOFTWARE_TOOL_NAMES = [
  "software.listSupported",
  "software.resolveInstaller",
  "software.downloadInstaller",
  "desktop.revealPath"
];

const EXPLICIT_CONTINUATION_PATTERN = /^(?:继续|接着|接着做|继续刚才|接着刚才|把刚才|刚才那个|再试一次|重试)(?:[，。,.！!？?\s]|$)/;
const THIS_PC_PATTERN = /(?:打开|进入|显示|启动).{0,6}(?:我的电脑|此电脑|这台电脑)/;
const CLIPBOARD_PATTERN = /(?:(?:读取|查看|看看|写入|复制到|放到|清空).{0,6}(?:剪贴板|粘贴板)|(?:剪贴板|粘贴板).{0,6}(?:有什么|内容|读取|查看|写入|清空))/;
const FILE_PATTERN = /(?:(?:整理|列出|查看|读取|移动|重命名|新建|创建|打开所在位置).{0,12}(?:本地文件|文件夹|目录|路径|文件)|(?:本地文件|文件夹|目录|路径|文件).{0,12}(?:有什么|里面|整理|列出|查看|读取|移动|重命名|新建|创建|打开所在位置)|[A-Za-z]:\\[^\n]{0,80}(?:有什么|里面|列出|查看|整理))/;

/**
 * 浏览器/网页/平台动作意图。
 * 覆盖口语「打开快手」「打开最新视频」「在 Edge 打开」「点赞/三连/评论」等，
 * 避免被误判为普通聊天后模型只能空口解释或教用户手动命令。
 * 仍不覆盖「打开此电脑」——那条由 THIS_PC_PATTERN 优先接管。
 */
const KNOWN_WEB_PLATFORM_PATTERN =
  /(?:B\s*站|哔哩哔哩|bilibili|抖音|快手|小红书|微博|知乎|YouTube|youtu\.be|淘宝|京东|拼多多|百度|谷歌|google|推特|twitter|x\.com|instagram|tiktok)/i;
const BROWSER_PATTERN = new RegExp(
  [
    // 显式搜索 / 下载 / 网页
    "(?:搜索|搜一下|搜一搜|帮我搜|给我搜|查一下|上网查|联网查|网上查|官网|网址|下载|安装包)",
    // 显式浏览器/网页打开
    "(?:打开网页|打开网站|用浏览器打开|在浏览器(?:里|中)?打开|浏览器里打开)",
    // 指定浏览器品牌打开（系统默认浏览器 reveal；不能保证一定是 Edge，但必须进工具路径）
    "(?:(?:用|在)?(?:edge|chrome|微软?edge|谷歌(?:浏览器)?|chrome浏览器).{0,12}打开|打开.{0,12}(?:edge|chrome|微软?edge))",
    // 打开已知平台 / App 名 / 主页 / 最新视频
    `(?:(?:打开|进入|访问|去|看看|看一下|看下).{0,16}${KNOWN_WEB_PLATFORM_PATTERN.source})`,
    `(?:${KNOWN_WEB_PLATFORM_PATTERN.source}.{0,16}(?:打开|搜索|搜|找|进入|主页|首页|视频|直播|博主|up主))`,
    // 视频/博主导航口语
    "(?:打开.{0,16}(?:视频|主页|首页|博主|up主|直播间)|(?:最新|最近).{0,8}(?:一期|一集|视频)|(?:这个|该|那个).{0,8}(?:博主|up主|视频).{0,12}(?:打开|最新|主页))",
    // 找视频/博主
    "(?:找.{0,8}(?:视频|博主|up主|主播)|(?:B站|哔哩哔哩).{0,8}(?:搜索|找|打开|看))",
    // 社交互动意图（先进入 browser 工具组；具体能力后续切片实现，至少不再当闲聊）
    "(?:点赞|三连|收藏|投币|转发|关注|评论区|评论一下|评论这个|写评论|发评论)"
  ].join("|"),
  "i"
);

/**
 * 进行中的下载/拉取意图（区别于「下载目录」「下载好的文件」这类本地整理指代）。
 * 命中时即使也匹配 FILE_PATTERN，也必须走 browser，否则没有 download* 工具。
 */
const ACTIVE_DOWNLOAD_INTENT_PATTERN =
  /(?:帮我|请)?(?:去)?(?:下载|抓取|拉取)(?!目录|文件夹|路径|好|完|过的?)(?:一[个下]|这个|该|到|并|视频|文件|安装包|[，。！？\s]|$)|(?:把|将).{0,12}下载到|(?:B\s*站|哔哩哔哩|视频页|BV[\w]+).{0,16}下载/i;

/**
 * T3.b：明确「从剪贴板/粘贴板取链接并下载」。
 * 覆盖「下载剪贴板里的链接」「把剪贴板的 URL 下载下来」等；纯查看剪贴板不命中。
 */
const CLIPBOARD_DOWNLOAD_INTENT_PATTERN =
  /(?:剪贴板|粘贴板).{0,20}(?:下载|拉取|抓取|保存)|(?:下载|拉取|抓取|保存).{0,20}(?:剪贴板|粘贴板)|(?:把|将).{0,10}(?:剪贴板|粘贴板).{0,16}(?:下载|保存|拉取|抓取)|(?:剪贴板|粘贴板).{0,12}(?:链接|网址|url|URL).{0,12}(?:下载|拉取|抓取|保存)/i;

/**
 * 只判断“本轮允许暴露哪些能力”，不执行工具，也不做副作用。
 * 高置信动作词才进入工具路径；其余输入默认按普通对话处理。
 */
export function resolveTurnCapability(
  userInput: string,
  history: VoidConversationMessage[]
): TurnCapabilityRoute {
  const normalizedInput = userInput.trim();
  const directRoute = classifyDirectCapability(normalizedInput);
  if (directRoute.capability !== "conversation") {
    return directRoute;
  }

  if (EXPLICIT_CONTINUATION_PATTERN.test(normalizedInput)) {
    const previousUserMessage = [...history]
      .reverse()
      .find((message) => message.role === "user" && message.content.trim());
    if (previousUserMessage) {
      const previousRoute = classifyDirectCapability(previousUserMessage.content);
      if (previousRoute.capability !== "conversation") {
        return { ...previousRoute, resumedFromHistory: true };
      }
    }
  }

  return directRoute;
}

function classifyDirectCapability(userInput: string): TurnCapabilityRoute {
  if (THIS_PC_PATTERN.test(userInput)) {
    return createRoute("desktop", DESKTOP_TOOL_NAMES);
  }

  // 官方软件安装包意图优先于 browser/media，避免「客户端」被当成视频或乱点官网。
  if (isSoftwareInstallerIntent(userInput)) {
    return createRoute("software", SOFTWARE_TOOL_NAMES);
  }

  // T3.b：剪贴板 URL 下载优先于纯剪贴板；capability 仍为 browser（下载主路径 + 整理）
  if (CLIPBOARD_DOWNLOAD_INTENT_PATTERN.test(userInput)) {
    return createRoute("browser", CLIPBOARD_DOWNLOAD_TOOL_NAMES);
  }

  if (CLIPBOARD_PATTERN.test(userInput)) {
    // 「读取剪贴板并下载」等：CLIPBOARD 命中但含下载意图 → 升级为剪贴板+下载工具组
    if (ACTIVE_DOWNLOAD_INTENT_PATTERN.test(userInput)) {
      return createRoute("browser", CLIPBOARD_DOWNLOAD_TOOL_NAMES);
    }
    return createRoute("clipboard", CLIPBOARD_TOOL_NAMES);
  }

  // 先看 file 模式，但「下载并整理」类必须升级到 browser（含 createDirectory/move）
  if (FILE_PATTERN.test(userInput)) {
    if (ACTIVE_DOWNLOAD_INTENT_PATTERN.test(userInput)) {
      return createRoute("browser", BROWSER_TOOL_NAMES);
    }
    return createRoute("file", FILE_TOOL_NAMES);
  }
  if (BROWSER_PATTERN.test(userInput)) {
    return createRoute("browser", BROWSER_TOOL_NAMES);
  }
  return createRoute("conversation", []);
}

function createRoute(
  capability: TurnCapability,
  allowedToolNames: string[]
): TurnCapabilityRoute {
  return {
    capability,
    allowedToolNames: [...allowedToolNames],
    resumedFromHistory: false
  };
}