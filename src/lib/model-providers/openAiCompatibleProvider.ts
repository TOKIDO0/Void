import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderValidationResult
} from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { buildFetchTarget, buildProviderEndpointUrl } from "./providerUrl";

type OpenAiCompatibleChoice = {
  message?: {
    content?: string;
  };
};

type OpenAiCompatibleResponse = {
  choices?: OpenAiCompatibleChoice[];
};

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

    const endpointUrl = buildProviderEndpointUrl(config.baseUrl, "chat/completions");
    const fetchTarget = buildFetchTarget(endpointUrl, config.requestMode);
    const response = await fetch(fetchTarget.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...fetchTarget.headers
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: request.messages,
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: false
      })
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw new Error(`模型请求失败：${response.status}${errorMessage ? ` ${errorMessage}` : ""}`);
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
    if (error instanceof TypeError) {
      return new Error("模型网络请求失败。请检查 Base URL、浏览器 CORS 限制，或切换到开发代理模式。");
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error("模型连接暂时不可用。");
  }
};

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json() as { error?: { message?: string } | string; message?: string };
    if (typeof payload.error === "string") {
      return payload.error;
    }

    return payload.error?.message ?? payload.message ?? "";
  } catch {
    return "";
  }
}
