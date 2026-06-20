import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderValidationResult
} from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";

type OpenAiCompatibleChoice = {
  message?: {
    content?: string;
  };
};

type OpenAiCompatibleResponse = {
  choices?: OpenAiCompatibleChoice[];
};

function buildChatCompletionsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export const openAiCompatibleProvider: ModelProvider = {
  validateConfig(config: ModelConfig): ProviderValidationResult {
    if (!config.apiKey.trim()) {
      return { valid: false, message: "需要先填写 API Key。" };
    }

    if (!config.baseUrl.trim()) {
      return { valid: false, message: "需要先填写 Base URL。" };
    }

    if (!config.modelName.trim()) {
      return { valid: false, message: "需要先填写模型名。" };
    }

    try {
      new URL(config.baseUrl);
    } catch {
      return { valid: false, message: "Base URL 格式不正确。" };
    }

    return { valid: true };
  },

  async sendMessage(request: ProviderRequest, config: ModelConfig): Promise<ProviderResponse> {
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    const response = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: request.messages,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`模型请求失败：${response.status}`);
    }

    return this.normalizeResponse(await response.json());
  },

  streamMessage: null,

  normalizeResponse(response: unknown): ProviderResponse {
    const parsedResponse = response as OpenAiCompatibleResponse;
    const content = parsedResponse.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error("模型没有返回有效内容。");
    }

    return { content };
  },

  mapError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error("模型连接暂时不可用。");
  }
};
