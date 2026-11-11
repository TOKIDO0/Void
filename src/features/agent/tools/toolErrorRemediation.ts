/**
 * CORE-02 错误即提示词：把"失败了"升级为"为什么失败、别再走哪条路、下一步做什么"。
 *
 * 为什么不在各工具里自由发挥：纠偏文案写错会直接误导模型。
 * 本模块是纠偏语义的唯一真源，按"来源域 + 桥接错误码"集中维护，
 * 三个域的错误映射器（browser/file/desktop）在返回前统一挂载。
 *
 * 为什么按桥接码而不是按工具名：同一码在不同工具上的正确下一步相同
 * （例如 BRIDGE_UNREACHABLE 对 browser.open / browser.click 都是"先别重试"），
 * 而工具名有 40+ 个，按工具维护会立刻腐化。
 */

import type { ToolError } from "./toolTypes";

export type ToolErrorRemediation = {
  /** 归因：为什么会这样。 */
  cause: string;
  /** 禁止动作：不要重复做什么。 */
  forbidden: string;
  /** 下一步：应该改用什么工具或参数。 */
  nextStep: string;
};

/** 浏览器域：来自服务端 bridge 错误码。 */
const BROWSER_REMEDIATION: Record<string, ToolErrorRemediation> = {
  BRIDGE_UNREACHABLE: {
    cause: "本机浏览器服务没有运行或端口未监听，请求根本没发出去。",
    forbidden: "不要再换 URL、换参数或换选择器重试，结果一定一样。",
    nextStep: "直接如实告诉用户本机服务未连接，让用户启动 VOID 桌面端后再说。"
  },
  NAVIGATION_FAILED: {
    cause: "目标地址打不开（域名错误、站点拒绝或网络不可达）。",
    forbidden: "不要对同一个 URL 反复重试，也不要假装已经打开。",
    nextStep: "报告失败原因；需要继续时改用 browser.search 找可用入口。"
  },
  TIMEOUT: {
    cause: "页面或操作在超时时间内没有完成。",
    forbidden: "不要原样重试同一操作。",
    nextStep: "缩小目标（例如只抽一个元素、只读首屏）后再试一次，或向用户说明页面太慢。"
  },
  SESSION_NOT_FOUND: {
    cause: "浏览器会话已经关闭或过期。",
    forbidden: "不要继续点击或输入旧元素。",
    nextStep: "先用 browser.open 重新打开页面，再重新观察元素后操作。"
  },
  PAGE_NOT_FOUND: {
    cause: "当前会话没有可用页面（标签页被关掉或从未打开）。",
    forbidden: "不要对不存在的页面执行点击或抽取。",
    nextStep: "先用 browser.open 打开目标页，再重试。"
  },
  RESOURCE_LIMIT: {
    cause: "同时运行的浏览器会话已达上限。",
    forbidden: "不要并发开新任务或重复开页面。",
    nextStep: "等其它任务结束，或用 browser.tabs 关闭不再需要的标签页。"
  }
};

/** 文件域：来自 /void-file 错误码。 */
const FILE_REMEDIATION: Record<string, ToolErrorRemediation> = {
  PATH_NOT_ALLOWED: {
    cause: "目标路径不在允许根内（系统目录、盘符根部或越界路径会被拒）。",
    forbidden: "不要换一个更宽松的路径绕过限制。",
    nextStep: "改用允许根内的路径，或如实告知用户该位置受限需要手动处理。"
  },
  OVERWRITE_REFUSED: {
    cause: "目标文件已存在，且当前策略拒绝覆盖。",
    forbidden: "不要直接覆盖重试。",
    nextStep: "改用新文件名，或先调 file.inspectWriteTarget 看清冲突策略再决定。"
  },
  FILE_NOT_FOUND: {
    cause: "目标文件或目录不存在。",
    forbidden: "不要对同一路径反复读取。",
    nextStep: "先用 file.inspectPath 或 file.listDirectory 确认实际路径。"
  },
  DOWNLOAD_BLOCKED: {
    cause: "下载目标被安全策略拦截（私网、回环、可疑重定向或非法协议）。",
    forbidden: "不要换 URL 变体绕过拦截。",
    nextStep: "如实告知用户该地址被拦截，需要用户确认来源可信后再处理。"
  },
  UNSUPPORTED_DOCUMENT: {
    cause: "该文档类型不在可读范围内（如扫描件或二进制格式）。",
    forbidden: "不要重复尝试读取同一文件。",
    nextStep: "改用图片理解能力，或请用户提供可复制的文本。"
  }
};

/** 桌面域：来自 /void-desktop 错误码。 */
const DESKTOP_REMEDIATION: Record<string, ToolErrorRemediation> = {
  APP_NOT_FOUND: {
    cause: "该应用不在开始菜单已安装列表中，无法按名称启动。",
    forbidden: "不要猜测或改写应用名反复尝试。",
    nextStep: "先调 desktop.listInstalledApplications 取准确名称，再启动。"
  },
  PATH_NOT_ALLOWED: {
    cause: "目标路径或应用不在允许范围内。",
    forbidden: "不要换路径或换名称绕过限制。",
    nextStep: "如实告知用户该目标受限，请用户自行打开或授权。"
  },
  PATH_NOT_FOUND: {
    cause: "目标路径不存在。",
    forbidden: "不要对同一路径重复操作。",
    nextStep: "先确认路径是否存在，再决定是否继续。"
  },
  TOO_LARGE: {
    cause: "输入或文件超过单次处理上限。",
    forbidden: "不要原样重发更大的内容。",
    nextStep: "拆成更小的批次，或只处理需要的片段。"
  }
};

function pick(table: Record<string, ToolErrorRemediation>, code: string) {
  return table[code];
}

export function resolveBrowserRemediation(code: string): ToolErrorRemediation | undefined {
  return pick(BROWSER_REMEDIATION, code);
}

export function resolveFileRemediation(code: string): ToolErrorRemediation | undefined {
  return pick(FILE_REMEDIATION, code);
}

export function resolveDesktopRemediation(code: string): ToolErrorRemediation | undefined {
  return pick(DESKTOP_REMEDIATION, code);
}

/** 挂载纠偏字段；无对应条目时原样返回，保持零副作用。 */
export function withToolRemediation(
  error: ToolError,
  remediation?: ToolErrorRemediation
): ToolError {
  if (!remediation) {
    return error;
  }
  return { ...error, ...remediation };
}
