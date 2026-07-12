import type { ModelProvider } from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { anthropicProvider } from "./anthropicProvider";
import { openAiCompatibleProvider } from "./openAiCompatibleProvider";

const MODEL_PROVIDERS: Record<ModelConfig["provider"], ModelProvider> = {
  anthropic: anthropicProvider,
  "openai-compatible": openAiCompatibleProvider
};

/** 冒烟/自测用：临时覆盖某个 provider 实现；正式产品路径勿用 */
const MODEL_PROVIDER_OVERRIDES = new Map<ModelConfig["provider"], ModelProvider>();

export function getModelProvider(providerType: ModelConfig["provider"]) {
  return MODEL_PROVIDER_OVERRIDES.get(providerType) ?? MODEL_PROVIDERS[providerType];
}

/** 安装临时 provider（返回卸载函数，便于 finally 恢复） */
export function installModelProviderOverride(
  providerType: ModelConfig["provider"],
  provider: ModelProvider
): () => void {
  MODEL_PROVIDER_OVERRIDES.set(providerType, provider);
  return () => {
    MODEL_PROVIDER_OVERRIDES.delete(providerType);
  };
}
