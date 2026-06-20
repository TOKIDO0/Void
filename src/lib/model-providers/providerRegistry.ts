import type { ModelProvider } from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { openAiCompatibleProvider } from "./openAiCompatibleProvider";

const MODEL_PROVIDERS: Record<ModelConfig["provider"], ModelProvider> = {
  "openai-compatible": openAiCompatibleProvider
};

export function getModelProvider(providerType: ModelConfig["provider"]) {
  return MODEL_PROVIDERS[providerType];
}
