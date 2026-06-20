import type {
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderValidationResult
} from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { buildFetchTarget, buildProviderEndpointUrl } from "./providerUrl";

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicResponse = {
  content?: AnthropicContentBlock[];
};

export const anthropicProvider: ModelProvider = {
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

    const systemPrompt = request.messages.find((message) => message.role === "system")?.content;
    const endpointUrl = buildProviderEndpointUrl(config.baseUrl, "messages");
    const fetchTarget = buildFetchTarget(endpointUrl);
    const response = await fetch(fetchTarget.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        ...fetchTarget.headers
      },
      body: JSON.stringify({
        model: config.modelName,
        system: systemPrompt,
        messages: buildAnthropicMessages(request.messages),
        temperature: config.temperature,
        max_tokens: config.maxOutputTokens,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`模型请求失败：${response.status} ${await readErrorMessage(response)}`);
    }

    return this.normalizeResponse(await response.json());
  },

  streamMessage: null,

  normalizeResponse(response: unknown): ProviderResponse {
    const parsedResponse = response as AnthropicResponse;
    const content = parsedResponse.content
      ?.filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("")
      .trim();

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

function buildAnthropicMessages(messages: ProviderMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    }));
}

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
