import type { VoidConversationMessage } from "../voidConversation";

export type TurnCapability =
  | "conversation"
  | "browser"
  | "file"
  | "desktop"
  | "clipboard";

export type TurnCapabilityRoute = {
  capability: TurnCapability;
  allowedToolNames: string[];
  resumedFromHistory: boolean;
};

const BROWSER_TOOL_NAMES = [
  "browser.open",
  "browser.search",
  "browser.selectTarget",
  "browser.revealInSystemBrowser",
  "browser.click",
  "browser.type",
  "browser.waitFor",
  "browser.extract",
  "browser.tabs",
  "browser.switchTab",
  "file.downloadToTemp",
  "file.placeDownload",
  "file.verify"
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

const EXPLICIT_CONTINUATION_PATTERN = /^(?:继续|接着|接着做|继续刚才|接着刚才|把刚才|刚才那个|再试一次|重试)(?:[，。,.！!？?\s]|$)/;
const THIS_PC_PATTERN = /(?:打开|进入|显示|启动).{0,6}(?:我的电脑|此电脑|这台电脑)/;
const CLIPBOARD_PATTERN = /(?:(?:读取|查看|看看|写入|复制到|放到|清空).{0,6}(?:剪贴板|粘贴板)|(?:剪贴板|粘贴板).{0,6}(?:有什么|内容|读取|查看|写入|清空))/;
const FILE_PATTERN = /(?:(?:整理|列出|查看|读取|移动|重命名|新建|创建|打开所在位置).{0,12}(?:本地文件|文件夹|目录|路径|文件)|(?:本地文件|文件夹|目录|路径|文件).{0,12}(?:有什么|里面|整理|列出|查看|读取|移动|重命名|新建|创建|打开所在位置)|[A-Za-z]:\\[^\n]{0,80}(?:有什么|里面|列出|查看|整理))/;
const BROWSER_PATTERN = /(?:搜索|搜一下|上网查|联网查|网上查|打开网页|打开网站|用浏览器打开|官网|网址|下载|安装包|找.{0,8}(?:视频|B站|哔哩哔哩)|(?:B站|哔哩哔哩).{0,8}(?:搜索|找|打开))/i;

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
  if (CLIPBOARD_PATTERN.test(userInput)) {
    return createRoute("clipboard", CLIPBOARD_TOOL_NAMES);
  }
  if (FILE_PATTERN.test(userInput)) {
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
