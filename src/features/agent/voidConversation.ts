import type { ModelConfig } from "../settings/modelConfig";
import type { ProviderMessage } from "../../lib/model-providers/providerContract";
import { getModelProvider } from "../../lib/model-providers/providerRegistry";
import { VOID_SYSTEM_PROMPT } from "./voidSystemPrompt";

export type VoidConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function sendVoidMessage(
  userInput: string,
  conversationHistory: VoidConversationMessage[],
  modelConfig: ModelConfig,
  onToken?: (token: string) => void
) {
  const provider = getModelProvider(modelConfig.provider);
  const messages: ProviderMessage[] = [
    { role: "system", content: VOID_SYSTEM_PROMPT },
    ...conversationHistory.map((message) => ({
      role: message.role,
      content: message.content
    })),
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
