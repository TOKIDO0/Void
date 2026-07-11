/**
 * 最终回复话术护栏（阶段 F3）。
 *
 * 模型偶发会在未成功 open/reveal 时说「已经打开了」。
 * 这里不做自然语言重写大手术，只在「本轮工具证据不足」时追加一句硬约束提醒，
 * 并在终态成功时确保 URL 线索可被模型看到（循环层已有 system 收口）。
 *
 * 真正的事实源仍是 tool 结果；本模块是最后一道面向用户的克制护栏。
 */

export type ReplySpeechGuardContext = {
  usedTools: boolean;
  /** 本轮是否出现过系统浏览器 reveal 成功 */
  didRevealInSystemBrowser: boolean;
  /** 本轮是否出现过 automation open 成功 */
  didOpenAutomationWindow: boolean;
  /** 可供核对的 URL（若有） */
  lastOpenedUrl?: string;
};

/**
 * 若回复声称「打开了」但本轮没有对应成功工具，附加更正说明。
 * 不篡改模型全文语气，只在末尾补事实，避免假操作体验。
 */
export function applyReplySpeechGuard(reply: string, context: ReplySpeechGuardContext): string {
  const text = reply.trim();
  if (!text || !context.usedTools) {
    return text;
  }

  const claimsOpened = /(?:已经|已|成功)?(?:为你|帮你)?打开了|打开成功|在浏览器里打开/.test(text);
  if (!claimsOpened) {
    return text;
  }

  const reallyOpened = context.didRevealInSystemBrowser || context.didOpenAutomationWindow;
  if (reallyOpened) {
    // 成功打开但回复缺 URL 时，补上可点击线索
    if (context.lastOpenedUrl && !text.includes(context.lastOpenedUrl)) {
      const where = context.didRevealInSystemBrowser
        ? "请到你的系统默认浏览器查看"
        : "当前是在自动化预览窗口中打开";
      return `${text}\n\n链接：${context.lastOpenedUrl}\n（${where}）`;
    }
    return text;
  }

  return `${text}\n\n（更正：本轮还没有成功打开页面。若需要，请再说一次目标或允许我继续操作。）`;
}

/** 从工具 JSON 结果里抽取 open/reveal 成功信号 */
export function inspectToolResultForOpenEvidence(
  toolName: string,
  parsed: Record<string, unknown> | null
): {
  didReveal: boolean;
  didOpenAutomation: boolean;
  url?: string;
} {
  if (!parsed || parsed.ok !== true) {
    return { didReveal: false, didOpenAutomation: false };
  }

  const data =
    parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
      ? (parsed.data as Record<string, unknown>)
      : {};

  const url =
    typeof data.openedUrl === "string"
      ? data.openedUrl
      : typeof data.finalUrl === "string"
        ? data.finalUrl
        : typeof data.url === "string"
          ? data.url
          : typeof data.pageUrl === "string"
            ? data.pageUrl
            : undefined;

  if (toolName === "browser.revealInSystemBrowser") {
    return { didReveal: true, didOpenAutomation: false, url };
  }

  if (toolName === "browser.open") {
    const openMode = typeof data.openMode === "string" ? data.openMode : "";
    return {
      didReveal: openMode === "system_default_browser",
      didOpenAutomation: openMode !== "system_default_browser",
      url
    };
  }

  return { didReveal: false, didOpenAutomation: false, url };
}
