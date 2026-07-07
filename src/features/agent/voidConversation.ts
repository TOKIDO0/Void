import type { ModelConfig } from "../settings/modelConfig";
import type { ProviderMessage } from "../../lib/model-providers/providerContract";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import { VOID_SYSTEM_PROMPT } from "./voidSystemPrompt";

export type VoidConversationAttachment = {
  id: string;
  name: string;
  mimeType: string;
  content: string;
};

export type VoidConversationMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: VoidConversationAttachment[];
};

export type VoidAssistantStreamState = {
  history: VoidConversationMessage[];
  assistantMessageIndex: number;
};

type StoredConversationPayload = {
  version: 1;
  messages: VoidConversationMessage[];
};

const CURRENT_CONVERSATION_STORAGE_KEY = "void.currentConversation";
const CURRENT_CONVERSATION_STORAGE_VERSION = 1;
const MAX_STORED_CONVERSATION_MESSAGES = 80;
const MAX_STORED_MESSAGE_CHARACTERS = 24000;
const MAX_STORED_TOTAL_CHARACTERS = 120000;
const MAX_REQUEST_HISTORY_MESSAGES = 20;
const MAX_REQUEST_HISTORY_CHARACTERS = 18000;
const MAX_ATTACHMENT_CONTENT_CHARACTERS = 18000;
const THINKING_MODE_SYSTEM_SUFFIX = [
  "当前处于思考模式。",
  "请先在内部理清问题结构，再给出结论。",
  "回复要更审慎、更结构化，优先明确前提、步骤和结论。",
  "不要为了显得有思考感而故意拖慢表达。"
].join("");

export async function sendVoidMessage(
  userInput: string,
  conversationHistory: VoidConversationMessage[],
  modelConfig: ModelConfig,
  attachments: VoidConversationAttachment[] = [],
  onToken?: (token: string) => void,
  emotionContext?: string
) {
  const provider = getModelProvider(modelConfig.provider);
  const normalizedUserInput = buildUserInputWithAttachments(userInput, attachments);
  const messages: ProviderMessage[] = [
    { role: "system", content: buildSystemPrompt(modelConfig, emotionContext) },
    ...buildRequestConversationHistory(conversationHistory),
    { role: "user", content: normalizedUserInput }
  ];

  try {
    if (modelConfig.streamEnabled && provider.streamMessage) {
      return await provider.streamMessage({ messages, onToken }, modelConfig);
    }

    return await provider.sendMessage({ messages }, modelConfig);
  } catch (error) {
    throw provider.mapError(error);
  }
}

function buildSystemPrompt(modelConfig: ModelConfig, emotionContext?: string) {
  const sections = [VOID_SYSTEM_PROMPT];

  if (modelConfig.thinkingModeEnabled) {
    sections.push(THINKING_MODE_SYSTEM_SUFFIX);
  }

  // 情绪系统的本轮情绪上下文（可选）。缺省则完全退回原有行为，零副作用。
  if (emotionContext && emotionContext.trim()) {
    sections.push(emotionContext.trim());
  }

  return sections.join("\n\n");
}

export function createPendingAssistantConversation(
  conversationHistory: VoidConversationMessage[],
  userInput: string,
  attachments: VoidConversationAttachment[] = []
): VoidAssistantStreamState {
  const nextHistory: VoidConversationMessage[] = [
    ...conversationHistory,
    {
      role: "user",
      content: userInput.trim(),
      attachments: normalizeAttachments(attachments)
    },
    { role: "assistant", content: "" }
  ];

  return {
    history: nextHistory,
    assistantMessageIndex: nextHistory.length - 1
  };
}

export function applyAssistantStreamContent(
  streamState: VoidAssistantStreamState,
  content: string
): VoidConversationMessage[] {
  const nextHistory = [...streamState.history];
  nextHistory[streamState.assistantMessageIndex] = {
    role: "assistant",
    content: content.trimStart()
  };

  return nextHistory;
}

export function finalizeAssistantStreamContent(
  streamState: VoidAssistantStreamState,
  content: string
): VoidConversationMessage[] {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return removeAssistantMessageAt(streamState.history, streamState.assistantMessageIndex);
  }

  const nextHistory = [...streamState.history];
  nextHistory[streamState.assistantMessageIndex] = {
    role: "assistant",
    content: normalizedContent
  };

  return nextHistory;
}

export function removeAssistantMessageAt(
  conversationHistory: VoidConversationMessage[],
  assistantMessageIndex: number
): VoidConversationMessage[] {
  return conversationHistory.filter((_, index) => index !== assistantMessageIndex);
}

export function clearCurrentConversationHistory() {
  window.localStorage.removeItem(CURRENT_CONVERSATION_STORAGE_KEY);
}

export function loadCurrentConversationHistory(): VoidConversationMessage[] {
  const rawHistory = window.localStorage.getItem(CURRENT_CONVERSATION_STORAGE_KEY);
  if (!rawHistory) {
    return [];
  }

  try {
    const parsedHistory = JSON.parse(rawHistory) as unknown;
    const storedMessages = extractStoredConversationMessages(parsedHistory);
    if (!storedMessages) {
      clearCurrentConversationHistory();
      return [];
    }

    return storedMessages
      .filter(isVoidConversationMessage)
      .map(normalizeStoredConversationMessage)
      .filter((message) => message.content);
  } catch {
    clearCurrentConversationHistory();
    return [];
  }
}

export function saveCurrentConversationHistory(conversationHistory: VoidConversationMessage[]) {
  const normalizedHistory = conversationHistory
    .filter(isVoidConversationMessage)
    .map(normalizeStoredConversationMessage)
    .filter((message) => message.content)
    .slice(-MAX_STORED_CONVERSATION_MESSAGES);

  if (!normalizedHistory.length) {
    clearCurrentConversationHistory();
    return;
  }

  const storedHistory = clipConversationByTotalCharacters(normalizedHistory, MAX_STORED_TOTAL_CHARACTERS);
  const payload: StoredConversationPayload = {
    version: CURRENT_CONVERSATION_STORAGE_VERSION,
    messages: storedHistory
  };

  window.localStorage.setItem(CURRENT_CONVERSATION_STORAGE_KEY, JSON.stringify(payload));
}

function extractStoredConversationMessages(value: unknown) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<StoredConversationPayload>;
  if (payload.version !== CURRENT_CONVERSATION_STORAGE_VERSION || !Array.isArray(payload.messages)) {
    return null;
  }

  return payload.messages;
}

function isVoidConversationMessage(value: unknown): value is VoidConversationMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<VoidConversationMessage>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

function normalizeStoredConversationMessage(message: VoidConversationMessage): VoidConversationMessage {
  const content = message.content.trim();
  const attachments = normalizeAttachments(message.attachments);

  return {
    role: message.role,
    content: content.length > MAX_STORED_MESSAGE_CHARACTERS
      ? content.slice(content.length - MAX_STORED_MESSAGE_CHARACTERS)
      : content,
    attachments
  };
}

function buildRequestConversationHistory(conversationHistory: VoidConversationMessage[]): ProviderMessage[] {
  const requestMessages: ProviderMessage[] = [];
  let remainingCharacters = MAX_REQUEST_HISTORY_CHARACTERS;

  for (const message of conversationHistory.slice(-MAX_REQUEST_HISTORY_MESSAGES).reverse()) {
    const content = message.content.trim();
    if (!content || shouldSkipRequestHistoryMessage(message.role, content)) {
      continue;
    }

    if (remainingCharacters <= 0) {
      break;
    }

    const clippedContent = content.length > remainingCharacters
      ? content.slice(content.length - remainingCharacters)
      : content;

    requestMessages.unshift({
      role: message.role,
      content: message.role === "user"
        ? buildUserInputWithAttachments(clippedContent, normalizeAttachments(message.attachments))
        : clippedContent
    });
    remainingCharacters -= clippedContent.length;
  }

  return requestMessages;
}

function clipConversationByTotalCharacters(conversationHistory: VoidConversationMessage[], maxTotalCharacters: number) {
  const clippedHistory: VoidConversationMessage[] = [];
  let totalCharacters = 0;

  for (const message of conversationHistory.slice().reverse()) {
    if (totalCharacters >= maxTotalCharacters) {
      break;
    }

    const remainingCharacters = maxTotalCharacters - totalCharacters;
    const clippedContent = message.content.length > remainingCharacters
      ? message.content.slice(message.content.length - remainingCharacters)
      : message.content;

    clippedHistory.unshift({
      role: message.role,
      content: clippedContent,
      attachments: normalizeAttachments(message.attachments)
    });
    totalCharacters += clippedContent.length;
  }

  return clippedHistory;
}

function shouldSkipRequestHistoryMessage(role: VoidConversationMessage["role"], content: string) {
  if (role !== "assistant") {
    return false;
  }

  return (
    content.startsWith("模型请求失败：")
    || content.startsWith("模型网络请求失败。")
    || content.startsWith("模型连接失败")
    || content.startsWith("正式模型代理不可用")
  );
}

function buildUserInputWithAttachments(userInput: string, attachments?: VoidConversationAttachment[]) {
  const trimmedInput = userInput.trim();
  const normalizedAttachments = normalizeAttachments(attachments) ?? [];
  if (!normalizedAttachments.length) {
    return trimmedInput;
  }

  const attachmentBlock = normalizedAttachments.map((attachment) => {
    const clippedContent = attachment.content.length > MAX_ATTACHMENT_CONTENT_CHARACTERS
      ? attachment.content.slice(0, MAX_ATTACHMENT_CONTENT_CHARACTERS)
      : attachment.content;

    return [
      `文件名：${attachment.name}`,
      `文件类型：${attachment.mimeType || "text/plain"}`,
      "文件内容：",
      clippedContent
    ].join("\n");
  }).join("\n\n---\n\n");

  if (!trimmedInput) {
    return `以下是本轮附加文件内容，请结合文件内容回答：\n\n${attachmentBlock}`;
  }

  return `${trimmedInput}\n\n以下是本轮附加文件内容，请结合文件内容回答：\n\n${attachmentBlock}`;
}

function normalizeAttachments(attachments: VoidConversationAttachment[] | undefined) {
  if (!attachments?.length) {
    return undefined;
  }

  return attachments
    .filter((attachment) => attachment.name.trim() && attachment.content.trim())
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name.trim(),
      mimeType: attachment.mimeType.trim(),
      content: attachment.content.trim()
    }));
}
