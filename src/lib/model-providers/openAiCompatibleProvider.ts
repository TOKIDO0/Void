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
  delta?: {
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
    const fetchTarget = buildFetchTarget(endpointUrl);
    logOpenAiCompatibleRequest("send", endpointUrl, config);
    const response = await fetch(fetchTarget.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildBearerToken(config.apiKey),
        ...fetchTarget.headers
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: request.messages,
        temperature: normalizeOpenAiCompatibleTemperature(config.temperature),
        max_tokens: config.maxOutputTokens,
        ...buildOpenAiCompatibleReasoningOptions(config),
        stream: false
      })
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw new Error(buildOpenAiCompatibleErrorMessage(response.status, errorMessage, config));
    }

    return this.normalizeResponse(await response.json());
  },

  async streamMessage(request: ProviderRequest, config: ModelConfig): Promise<ProviderResponse> {
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    const endpointUrl = buildProviderEndpointUrl(config.baseUrl, "chat/completions");
    const fetchTarget = buildFetchTarget(endpointUrl);
    logOpenAiCompatibleRequest("stream", endpointUrl, config);
    const response = await fetch(fetchTarget.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildBearerToken(config.apiKey),
        ...fetchTarget.headers
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: request.messages,
        temperature: normalizeOpenAiCompatibleTemperature(config.temperature),
        max_tokens: config.maxOutputTokens,
        ...buildOpenAiCompatibleReasoningOptions(config),
        stream: true
      })
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw new Error(buildOpenAiCompatibleErrorMessage(response.status, errorMessage, config));
    }

    if (!response.body) {
      throw new Error("模型没有返回可读取的流式内容。");
    }

    return readOpenAiCompatibleStream(response.body, request.onToken);
  },

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

function normalizeOpenAiCompatibleTemperature(temperature: number) {
  return Math.min(Math.max(temperature, 0.01), 1);
}

function buildBearerToken(apiKey: string) {
  return `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`;
}

function buildOpenAiCompatibleReasoningOptions(config: ModelConfig) {
  if (!isOpenAiConfig(config)) {
    return {};
  }

  return {
    reasoning_effort: mapModelStrengthToReasoningEffort(config.modelStrength)
  };
}

function isOpenAiConfig(config: ModelConfig) {
  try {
    return new URL(config.baseUrl).hostname.endsWith("openai.com");
  } catch {
    return false;
  }
}

function mapModelStrengthToReasoningEffort(strength: ModelConfig["modelStrength"]) {
  if (strength === "low") {
    return "low";
  }

  if (strength === "high" || strength === "max") {
    return "high";
  }

  return "medium";
}

function buildOpenAiCompatibleErrorMessage(status: number, errorMessage: string, config: ModelConfig) {
  if (status === 401 && isVolcengineArkConfig(config)) {
    return [
      "模型请求失败：401 豆包 Ark 鉴权失败。",
      "请确认 API Key 填的是“API Key Secret”，不是 API Key ID、Access Key ID、Secret Access Key 或火山 AK/SK。",
      errorMessage ? `服务端信息：${errorMessage}` : ""
    ].filter(Boolean).join(" ");
  }

  return `模型请求失败：${status}${errorMessage ? ` ${errorMessage}` : ""}`;
}

function isVolcengineArkConfig(config: ModelConfig) {
  try {
    return new URL(config.baseUrl).hostname.endsWith("volces.com");
  } catch {
    return false;
  }
}

function logOpenAiCompatibleRequest(mode: "send" | "stream", endpointUrl: string, config: ModelConfig) {
  if (!import.meta.env.DEV) {
    return;
  }

  const normalizedApiKey = config.apiKey.trim().replace(/^Bearer\s+/i, "");
  console.info("[VOID model request]", {
    mode,
    endpointUrl,
    modelName: config.modelName,
    provider: config.provider,
    apiKeyLength: normalizedApiKey.length,
    apiKeyLooksLikeArkSecret: normalizedApiKey.startsWith("V"),
    apiKeyLooksLikeArkId: normalizedApiKey.startsWith("ee"),
    apiKeyHasBearerPrefix: /^Bearer\s+/i.test(config.apiKey.trim()),
    streamEnabled: config.streamEnabled
  });
}

async function readOpenAiCompatibleStream(
  body: ReadableStream<Uint8Array>,
  onToken: ProviderRequest["onToken"]
): Promise<ProviderResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) {
        continue;
      }

      const payload = trimmedLine.slice(5).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      const token = parseStreamToken(payload);
      if (!token) {
        continue;
      }

      content += token;
      onToken?.(token);
    }
  }

  const finalContent = content.trim();
  if (!finalContent) {
    throw new Error("模型没有返回有效内容。");
  }

  return { content: finalContent };
}

function parseStreamToken(payload: string) {
  try {
    const parsedPayload = JSON.parse(payload) as OpenAiCompatibleResponse;
    return parsedPayload.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json() as {
      code?: string | number;
      error?: { code?: string | number; message?: string } | string;
      message?: string;
      msg?: string;
    };
    if (typeof payload.error === "string") {
      return payload.error;
    }

    const errorCode = payload.error?.code ?? payload.code;
    const errorMessage = payload.error?.message ?? payload.message ?? payload.msg ?? "";
    if (errorCode && errorMessage) {
      return `${errorCode} ${errorMessage}`;
    }

    return errorMessage || (errorCode ? String(errorCode) : "");
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}
