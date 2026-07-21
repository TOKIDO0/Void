// VOID 对话工作摘要（M2）
// 把挤出近窗的旧轮次折叠成短摘要，避免长对话盲砍后丢失用户约束。
// 工作摘要 ≠ 长期记忆：禁止写入 memoryStore / 九分区。

/** 仅依赖消息形状，避免与 voidConversation 循环引用。 */
export type CompactableConversationMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: unknown;
};

export type ConversationWorkingSummary = {
  version: 1;
  summary: string;
  /** 摘要已覆盖的历史消息条数（从对话开头计） */
  coveredUntilMessageCount: number;
  updatedAt: number;
};

type CompactHistoryOptions = {
  history: CompactableConversationMessage[];
  historyTokenBudget: number;
  summaryTokenBudget: number;
  existingSummary: ConversationWorkingSummary | null;
  estimateTokens: (text: string) => number;
};

type CompactHistoryResult = {
  messagesForRequest: CompactableConversationMessage[];
  /** 注入 system 的摘要段；空串表示不注入 */
  summaryText: string;
  nextSummary: ConversationWorkingSummary | null;
};

const WORKING_SUMMARY_STORAGE_KEY = "void.conversationWorkingSummary.v1";
const MAX_SUMMARY_CHARACTERS = 700;

/** 用户侧更值得保留进摘要的约束线索。 */
const USER_CONSTRAINT_PATTERN =
  /记住|以后|不要|别再|必须|约定|叫我|我是|我喜欢|我不喜欢|请你|记住我|下次|始终|永远/;

/**
 * 按 token 预算裁近窗，并把更旧消息折叠进工作摘要（规则抽取，默认不调 LLM）。
 */
export function compactHistoryForRequest(
  options: CompactHistoryOptions
): CompactHistoryResult {
  const {
    history,
    historyTokenBudget,
    summaryTokenBudget,
    existingSummary,
    estimateTokens
  } = options;

  const usableHistory = history.filter((message) => message.content.trim());
  if (usableHistory.length === 0) {
    return {
      messagesForRequest: [],
      summaryText: "",
      nextSummary: null
    };
  }

  // 从尾部往前装近窗，直到预算用尽
  const recentReversed: CompactableConversationMessage[] = [];
  let usedTokens = 0;
  for (let index = usableHistory.length - 1; index >= 0; index -= 1) {
    const message = usableHistory[index];
    const cost = estimateTokens(message.content);
    if (recentReversed.length > 0 && usedTokens + cost > historyTokenBudget) {
      break;
    }
    if (recentReversed.length === 0 && cost > historyTokenBudget) {
      // 单条过长：仍保留尾部截断后的一条，避免近窗全空
      recentReversed.push({
        ...message,
        content: sliceToTokenBudget(message.content, historyTokenBudget, estimateTokens)
      });
      usedTokens = historyTokenBudget;
      break;
    }
    recentReversed.push(message);
    usedTokens += cost;
  }

  const messagesForRequest = recentReversed.reverse();
  const recentCount = messagesForRequest.length;
  const olderMessages = usableHistory.slice(0, Math.max(0, usableHistory.length - recentCount));

  if (olderMessages.length === 0) {
    // 全部装进近窗：保留既有摘要（若仍有信息），但不强制扩张
    const summaryText = formatSummaryForPrompt(existingSummary?.summary ?? "", summaryTokenBudget, estimateTokens);
    return {
      messagesForRequest,
      summaryText,
      nextSummary: existingSummary
    };
  }

  const mergedSummaryBody = buildRuleBasedSummary(
    existingSummary?.summary ?? "",
    olderMessages
  );
  const clippedSummary = clipSummaryCharacters(mergedSummaryBody, MAX_SUMMARY_CHARACTERS);
  const nextSummary: ConversationWorkingSummary | null = clippedSummary
    ? {
      version: 1,
      summary: clippedSummary,
      coveredUntilMessageCount: olderMessages.length,
      updatedAt: Date.now()
    }
    : null;

  return {
    messagesForRequest,
    summaryText: formatSummaryForPrompt(clippedSummary, summaryTokenBudget, estimateTokens),
    nextSummary
  };
}

export function loadConversationWorkingSummary(): ConversationWorkingSummary | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(WORKING_SUMMARY_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ConversationWorkingSummary>;
    if (parsed.version !== 1 || typeof parsed.summary !== "string") {
      clearConversationWorkingSummary();
      return null;
    }
    if (!parsed.summary.trim()) {
      return null;
    }
    return {
      version: 1,
      summary: parsed.summary.trim(),
      coveredUntilMessageCount:
        typeof parsed.coveredUntilMessageCount === "number"
          ? parsed.coveredUntilMessageCount
          : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now()
    };
  } catch {
    clearConversationWorkingSummary();
    return null;
  }
}

export function saveConversationWorkingSummary(
  summary: ConversationWorkingSummary | null
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!summary || !summary.summary.trim()) {
    clearConversationWorkingSummary();
    return;
  }
  window.localStorage.setItem(WORKING_SUMMARY_STORAGE_KEY, JSON.stringify(summary));
}

export function clearConversationWorkingSummary(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(WORKING_SUMMARY_STORAGE_KEY);
}

/** 规则摘要：优先保留用户约束句，assistant 仅留极短结论。 */
function buildRuleBasedSummary(
  previousSummary: string,
  olderMessages: CompactableConversationMessage[]
): string {
  const lines: string[] = [];
  if (previousSummary.trim()) {
    lines.push(previousSummary.trim());
  }

  for (const message of olderMessages) {
    const content = message.content.trim().replace(/\s+/g, " ");
    if (!content) {
      continue;
    }

    if (message.role === "user") {
      if (USER_CONSTRAINT_PATTERN.test(content) || content.length <= 80) {
        lines.push(`用户：${clipLine(content, 120)}`);
      } else {
        lines.push(`用户：${clipLine(content, 80)}`);
      }
      continue;
    }

    // assistant：跳过明显错误/工具失败长文
    if (
      content.startsWith("模型请求失败：")
      || content.startsWith("工具循环超过")
      || content.startsWith("这轮工具操作没能完成")
    ) {
      continue;
    }
    lines.push(`助手：${clipLine(content, 60)}`);
  }

  // 去重并控制总行数，避免摘要无限膨胀
  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = line.replace(/\s+/g, "");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueLines.push(line);
  }

  return uniqueLines.slice(-18).join("\n");
}

function formatSummaryForPrompt(
  summary: string,
  summaryTokenBudget: number,
  estimateTokens: (text: string) => number
): string {
  const body = summary.trim();
  if (!body) {
    return "";
  }
  const clipped = sliceToTokenBudget(body, Math.max(80, summaryTokenBudget), estimateTokens);
  return `【对话工作摘要（旧轮压缩，非长期记忆）】\n${clipped}`;
}

function clipSummaryCharacters(text: string, maxCharacters: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxCharacters) {
    return trimmed;
  }
  return `${trimmed.slice(trimmed.length - maxCharacters)}`;
}

function clipLine(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}

function sliceToTokenBudget(
  text: string,
  tokenBudget: number,
  estimateTokens: (text: string) => number
): string {
  if (tokenBudget <= 0) {
    return "";
  }
  if (estimateTokens(text) <= tokenBudget) {
    return text;
  }

  // 从尾部保留：旧约束摘要更关心最近折叠进摘要的内容
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(text.length - mid);
    if (estimateTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || text.slice(-Math.max(16, tokenBudget * 2));
}
