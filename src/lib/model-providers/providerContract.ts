import type { ModelConfig } from "../../features/settings/modelConfig";

export type ProviderRole = "system" | "user" | "assistant";

export type ProviderMessage = {
  role: ProviderRole;
  content: string;
};

export type ProviderRequest = {
  messages: ProviderMessage[];
};

export type ProviderResponse = {
  content: string;
};

export type ProviderValidationResult = {
  valid: boolean;
  message?: string;
};

export type ModelProvider = {
  sendMessage: (request: ProviderRequest, config: ModelConfig) => Promise<ProviderResponse>;
  streamMessage: null;
  validateConfig: (config: ModelConfig) => ProviderValidationResult;
  normalizeResponse: (response: unknown) => ProviderResponse;
  mapError: (error: unknown) => Error;
};
