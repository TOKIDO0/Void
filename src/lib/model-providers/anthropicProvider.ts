import type {
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderValidationResult
} from "./providerContract";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { ProviderRequestError, createHttpStatusError } from "./providerErrors";
import { buildFetchTarget, buildProviderEndpointUrl, fetchWithProxyFallback } from "./providerUrl";

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicResponse = {
  content?: AnthropicContentBlock[];
};

export const anthropicProvider: ModelProvider = {
  // 阶段 E′ 先打通 OpenAI-compatible tool_calls；Anthropic tools 后置
  supportsTools: false,

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

    const systemMessage = request.messages.find((message) => message.role === "system");
    const systemPrompt = typeof systemMessage?.content === "string" ? systemMessage.content : null;
    const endpointUrl = buildProviderEndpointUrl(config.baseUrl, "messages");
    const fetchTarget = buildFetchTarget(endpointUrl);
    const requestBody = buildAnthropicRequestBody(request, config, systemPrompt);
    const response = await fetchWithProxyFallback(fetchTarget, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(requestBody),
      signal: request.signal
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw createHttpStatusError(response.status, errorMessage, endpointUrl);
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
    if (error instanceof ProviderRequestError) {
      return new Error(buildAnthropicErrorMessage(error));
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error("模型连接暂时不可用。");
  }
};

function buildAnthropicMessages(messages: ProviderMessage[]) {
  // Anthropic 路径暂不支持 tool 角色；保留 user/assistant，多模态块按官方格式序列化
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: serializeAnthropicContent(message.content)
    }));
}

/**
 * 多模态内容序列化为 Anthropic 官方块格式：
 *   image → { type:"image", source:{ type:"base64", media_type, data } }
 *   document(PDF) → { type:"document", source:{ type:"base64", media_type:"application/pdf", data } }
 */
function serializeAnthropicContent(content: ProviderMessage["content"]) {
  if (!Array.isArray(content)) {
    return content ?? "";
  }

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        source: { type: "base64", media_type: part.mediaType, data: part.dataBase64 }
      };
    }
    return {
      type: "document",
      source: { type: "base64", media_type: part.mediaType, data: part.dataBase64 },
      ...(part.name ? { title: part.name } : {})
    };
  });
}

function buildAnthropicRequestBody(request: ProviderRequest, config: ModelConfig, systemPrompt?: string | null) {
  const thinkingBudgetTokens = mapThinkingModeToBudgetTokens(config);
  const baseBody = {
    model: config.modelName,
    system: systemPrompt ?? undefined,
    messages: buildAnthropicMessages(request.messages),
    max_tokens: config.maxOutputTokens,
    stream: false
  };

  if (!thinkingBudgetTokens) {
    return {
      ...baseBody,
      temperature: config.temperature
    };
  }

  return {
    ...baseBody,
    thinking: {
      type: "enabled",
      budget_tokens: thinkingBudgetTokens
    }
  };
}

function mapThinkingModeToBudgetTokens(config: ModelConfig) {
  if (!config.thinkingModeEnabled || config.maxOutputTokens <= 1024) {
    return 0;
  }

  if (config.modelStrength === "high") {
    return Math.min(Math.max(Math.floor(config.maxOutputTokens * 0.25), 1024), config.maxOutputTokens - 1);
  }

  if (config.modelStrength === "max") {
    return Math.min(Math.max(Math.floor(config.maxOutputTokens * 0.5), 1024), config.maxOutputTokens - 1);
  }

  return 0;
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json() as {
      type?: string;
      error?: { type?: string; message?: string } | string;
      message?: string;
    };
    if (typeof payload.error === "string") {
      return payload.error;
    }

    const errorType = payload.error?.type ?? payload.type ?? "";
    const errorMessage = payload.error?.message ?? payload.message ?? "";
    if (errorType && errorMessage) {
      return `${errorType} ${errorMessage}`;
    }

    return errorMessage || errorType;
  } catch {
    return "";
  }
}

function buildAnthropicErrorMessage(error: ProviderRequestError) {
  if (error.kind === "proxy-unavailable") {
    return error.message;
  }

  if (error.kind === "network") {
    return "模型网络请求失败。请检查 Base URL、网络连通性或目标接口配置。";
  }

  const status = error.status ?? 0;
  const errorMessage = error.serviceMessage;

  if (status === 401 || status === 403) {
    return `模型请求失败：${status} 鉴权失败。请确认 x-api-key 是否正确、账户权限是否有效。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status === 404) {
    return `模型请求失败：404。请确认 Base URL、接口路径和模型名是否正确。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status === 429) {
    return `模型请求失败：429，请求过于频繁或额度不足。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status >= 500) {
    return `模型请求失败：${status}，目标模型服务暂时异常。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  return `模型请求失败：${status}${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
}
