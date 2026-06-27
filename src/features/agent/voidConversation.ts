import type { ModelConfig } from "../settings/modelConfig";
import type { ProviderMessage } from "../../lib/model-providers/providerContract";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import { VOID_SYSTEM_PROMPT } from "./voidSystemPrompt";

export type VoidConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

const CURRENT_CONVERSATION_STORAGE_KEY = "void.currentConversation";
const MAX_STORED_CONVERSATION_MESSAGES = 80;
const MAX_STORED_MESSAGE_CHARACTERS = 24000;
const MAX_REQUEST_HISTORY_MESSAGES = 20;
const MAX_REQUEST_HISTORY_CHARACTERS = 18000;

export async function sendVoidMessage(
  userInput: string,
  conversationHistory: VoidConversationMessage[],
  modelConfig: ModelConfig,
  onToken?: (token: string) => void
) {
  const provider = getModelProvider(modelConfig.provider);
  const messages: ProviderMessage[] = [
    { role: "system", content: VOID_SYSTEM_PROMPT },
    ...buildRequestConversationHistory(conversationHistory),
    { role: "user", content: userInput }
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

export function loadCurrentConversationHistory(): VoidConversationMessage[] {
  const rawHistory = window.localStorage.getItem(CURRENT_CONVERSATION_STORAGE_KEY);
  if (!rawHistory) {
    return [];
  }

  try {
    const parsedHistory = JSON.parse(rawHistory) as unknown;
    if (!Array.isArray(parsedHistory)) {
      return [];
    }

    return parsedHistory
      .filter(isVoidConversationMessage)
      .map(normalizeStoredConversationMessage)
      .filter((message) => message.content);
  } catch {
    return [];
  }
}

export function saveCurrentConversationHistory(conversationHistory: VoidConversationMessage[]) {
  const storedHistory = conversationHistory
    .filter(isVoidConversationMessage)
    .map(normalizeStoredConversationMessage)
    .filter((message) => message.content)
    .slice(-MAX_STORED_CONVERSATION_MESSAGES);

  window.localStorage.setItem(CURRENT_CONVERSATION_STORAGE_KEY, JSON.stringify(storedHistory));
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

  return {
    role: message.role,
    content: content.length > MAX_STORED_MESSAGE_CHARACTERS
      ? content.slice(content.length - MAX_STORED_MESSAGE_CHARACTERS)
      : content
  };
}

function buildRequestConversationHistory(conversationHistory: VoidConversationMessage[]): ProviderMessage[] {
  const requestMessages: ProviderMessage[] = [];
  let remainingCharacters = MAX_REQUEST_HISTORY_CHARACTERS;

  for (const message of conversationHistory.slice(-MAX_REQUEST_HISTORY_MESSAGES).reverse()) {
    const content = message.content.trim();
    if (!content) {
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
      content: clippedContent
    });
    remainingCharacters -= clippedContent.length;
  }

  return requestMessages;
}
