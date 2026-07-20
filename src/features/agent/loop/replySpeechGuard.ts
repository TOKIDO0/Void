/**
 * 最终回复话术护栏（阶段 F3 + P0 假成功收紧）。
 *
 * 模型偶发会在未成功 open/reveal / 下载 / 点击时说「已经打开了 / 已下载 / 已点赞」。
 * 这里不做自然语言重写大手术：
 * - 有对应成功证据：必要时补 URL；
 * - 无证据却声称完成：末尾追加更正，或在未调工具时直接改写为诚实失败句。
 *
 * 真正的事实源仍是 tool 结果；本模块是最后一道面向用户的克制护栏。
 */

export type ReplySpeechGuardContext = {
  /** 本轮是否进入过工具循环（调过至少一次工具） */
  usedTools: boolean;
  /** 本轮是否出现过系统浏览器 reveal 成功 */
  didRevealInSystemBrowser: boolean;
  /** 本轮是否出现过 automation open 成功 */
  didOpenAutomationWindow: boolean;
  /** 本轮是否成功打开受限桌面系统位置 */
  didOpenDesktopLocation: boolean;
  /** 本轮是否成功落盘/校验下载（place/verify） */
  didCompleteDownload?: boolean;
  /** 本轮是否成功执行过页面点击/长按（互动前置证据，仍不能单凭此说「已三连」） */
  didPageClick?: boolean;
  /** 本轮是否成功执行过长按（B 站三连前置证据） */
  didLongPress?: boolean;
  /** 可供核对的 URL（若有） */
  lastOpenedUrl?: string;
};

type ClaimKind = "open" | "download" | "interact";

/**
 * 若回复声称「打开了 / 下载了 / 点赞了」但本轮没有对应成功工具，附加更正或改写。
 * 不篡改模型全文语气为主，只在证据不足时拦假完成。
 */
export function applyReplySpeechGuard(reply: string, context: ReplySpeechGuardContext): string {
  const text = reply.trim();
  if (!text) {
    return text;
  }

  const claimKinds = detectCompletionClaims(text);
  if (claimKinds.length === 0) {
    return text;
  }

  const missing: ClaimKind[] = [];
  for (const kind of claimKinds) {
    if (!hasEvidenceForClaim(kind, context)) {
      missing.push(kind);
    }
  }

  // 打开类有证据时：成功但缺 URL 则补线索
  if (!missing.includes("open") && claimKinds.includes("open")) {
    const reallyOpened = context.didRevealInSystemBrowser
      || context.didOpenAutomationWindow
      || context.didOpenDesktopLocation;
    if (reallyOpened && context.lastOpenedUrl && !text.includes(context.lastOpenedUrl)) {
      const where = context.didRevealInSystemBrowser
        ? "请到你的系统默认浏览器查看"
        : context.didOpenDesktopLocation
          ? "请到已打开的系统位置查看"
          : "当前是在自动化预览窗口中打开";
      return `${text}\n\n链接：${context.lastOpenedUrl}\n（${where}）`;
    }
  }

  if (missing.length === 0) {
    return text;
  }

  // 本轮根本没调工具却声称完成：直接改成诚实句，避免用户只看到假成功正文
  if (!context.usedTools) {
    return buildNoToolFalseSuccessReply(missing);
  }

  return `${text}\n\n（更正：${buildMissingEvidenceCorrection(missing)}）`;
}

/** 从工具 JSON 结果里抽取 open/reveal / 下载 / 点击成功信号 */
export function inspectToolResultForOpenEvidence(
  toolName: string,
  parsed: Record<string, unknown> | null
): {
  didReveal: boolean;
  didOpenAutomation: boolean;
  didOpenDesktop: boolean;
  didCompleteDownload: boolean;
  didPageClick: boolean;
  didLongPress: boolean;
  url?: string;
} {
  if (!parsed || parsed.ok !== true) {
    return {
      didReveal: false,
      didOpenAutomation: false,
      didOpenDesktop: false,
      didCompleteDownload: false,
      didPageClick: false,
      didLongPress: false
    };
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
    return {
      didReveal: true,
      didOpenAutomation: false,
      didOpenDesktop: false,
      didCompleteDownload: false,
      didPageClick: false,
      didLongPress: false,
      url
    };
  }

  if (toolName === "browser.open") {
    const openMode = typeof data.openMode === "string" ? data.openMode : "";
    return {
      didReveal: openMode === "system_default_browser",
      didOpenAutomation: openMode !== "system_default_browser",
      didOpenDesktop: false,
      didCompleteDownload: false,
      didPageClick: false,
      didLongPress: false,
      url
    };
  }

  if (toolName === "desktop.openKnownLocation" && data.location === "this_pc") {
    return {
      didReveal: false,
      didOpenAutomation: false,
      didOpenDesktop: true,
      didCompleteDownload: false,
      didPageClick: false,
      didLongPress: false
    };
  }

  if (
    toolName === "file.placeDownload"
    || toolName === "file.verify"
    || toolName === "file.downloadMediaPage"
  ) {
    return {
      didReveal: false,
      didOpenAutomation: false,
      didOpenDesktop: false,
      didCompleteDownload: true,
      didPageClick: false,
      didLongPress: false,
      url
    };
  }

  if (toolName === "browser.click") {
    return {
      didReveal: false,
      didOpenAutomation: false,
      didOpenDesktop: false,
      didCompleteDownload: false,
      didPageClick: true,
      didLongPress: false,
      url
    };
  }

  if (toolName === "browser.longPress") {
    return {
      didReveal: false,
      didOpenAutomation: false,
      didOpenDesktop: false,
      didCompleteDownload: false,
      didPageClick: false,
      didLongPress: true,
      url
    };
  }

  return {
    didReveal: false,
    didOpenAutomation: false,
    didOpenDesktop: false,
    didCompleteDownload: false,
    didPageClick: false,
    didLongPress: false,
    url
  };
}

function detectCompletionClaims(text: string): ClaimKind[] {
  const kinds: ClaimKind[] = [];

  // 「打开了 / 打开成功 / 在浏览器里打开 / 已打开页面」
  if (
    /(?:已经|已|成功)?(?:为你|帮你)?打开了|打开成功|在浏览器里打开|已打开(?:了)?(?:页面|网页|视频|主页|链接|快手|抖音|B\s*站)?/.test(text)
  ) {
    kinds.push("open");
  }

  // 「已下载 / 下载完成 / 保存好了」
  if (
    /(?:已经|已|成功)?(?:为你|帮你)?(?:下载|保存)(?:了|完成|好了|成功)|下载成功|保存成功|落盘成功/.test(text)
  ) {
    kinds.push("download");
  }

  // 「已点赞 / 已三连 / 已收藏 / 已评论 / 评论发出」
  if (
    /(?:已经|已|成功)?(?:为你|帮你)?(?:点赞|三连|收藏|投币|关注|评论)(?:了|完成|成功)?|评论(?:已)?(?:发出|发送|发出去了)/.test(text)
  ) {
    kinds.push("interact");
  }

  return kinds;
}

function hasEvidenceForClaim(kind: ClaimKind, context: ReplySpeechGuardContext): boolean {
  if (kind === "open") {
    return context.didRevealInSystemBrowser
      || context.didOpenAutomationWindow
      || context.didOpenDesktopLocation;
  }
  if (kind === "download") {
    return Boolean(context.didCompleteDownload);
  }
  // 点赞/三连/评论：当前没有平台回执校验。
  // 有 click / longPress 成功证据时允许模型按工具结果汇报；
  // 无任何互动工具成功时一律拦截假完成。
  if (kind === "interact") {
    return Boolean(context.didLongPress || context.didPageClick);
  }
  return false;
}

function buildMissingEvidenceCorrection(missing: ClaimKind[]): string {
  const parts: string[] = [];
  if (missing.includes("open")) {
    parts.push("本轮还没有成功打开页面");
  }
  if (missing.includes("download")) {
    parts.push("本轮还没有成功完成下载或保存");
  }
  if (missing.includes("interact")) {
    parts.push("本轮还没有可核对的点赞/三连/评论成功证据");
  }
  return `${parts.join("；")}。若需要，请再说一次目标或允许我继续操作。`;
}

function buildNoToolFalseSuccessReply(missing: ClaimKind[]): string {
  if (missing.includes("open") && missing.length === 1) {
    return "这轮我还没有真正打开页面。若要打开，请再说一次目标，我会用工具执行后再告诉你结果。";
  }
  if (missing.includes("download") && missing.length === 1) {
    return "这轮我还没有真正完成下载或保存。需要的话请再说一次目标，我按工具结果如实汇报。";
  }
  if (missing.includes("interact") && missing.length === 1) {
    return "这轮我还不能确认点赞、三连或评论已经成功。需要操作时请明确说目标，我只会在有工具证据后回报。";
  }
  return "这轮我还没有可核对的完成证据，不能声称已经打开、下载或互动成功。请再说一次具体目标。";
}
