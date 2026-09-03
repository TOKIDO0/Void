import type {
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderToolCall,
  ProviderValidationResult
} from "./providerContract";
import { parseDsmlToolCalls } from "./dsmlToolCallParser";
import type { ModelConfig } from "../../features/settings/modelConfig";
import { ProviderRequestError, createHttpStatusError } from "./providerErrors";
import { buildFetchTarget, buildProviderEndpointUrl, fetchWithProxyFallback } from "./providerUrl";

type OpenAiCompatibleToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  index?: number;
};

type OpenAiCompatibleChoice = {
  message?: {
    content?: string | null;
    /** 推理模型（DeepSeek R1/V4 系、o1 类）的思考过程字段；content 为空时它说明额度被思考耗尽。 */
    reasoning_content?: string | null;
    tool_calls?: OpenAiCompatibleToolCall[];
  };
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAiCompatibleToolCall[];
  };
  finish_reason?: string | null;
};

type OpenAiCompatibleResponse = {
  choices?: OpenAiCompatibleChoice[];
};

export const openAiCompatibleProvider: ModelProvider = {
  supportsTools: true,

  validateConfig(config: ModelConfig): ProviderValidationResult {
    const isOllamaLocal = isOllamaLocalConfig(config);
    if (!config.apiKey.trim() && !isOllamaLocal) {
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
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey.trim()) {
      headers.Authorization = buildBearerToken(config.apiKey);
    }
    let response = await fetchWithProxyFallback(fetchTarget, {
      method: "POST",
      headers,
      body: JSON.stringify(buildOpenAiCompatibleBody(request, config, false)),
      signal: request.signal
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      const lower = (errorMessage || "").toLowerCase();
      // 根因修复：中转站对带 tools 的请求报 no_available_channel 时，自动降级为纯对话重试一次，避免全盘 503
      const shouldRetryWithoutTools = response.status === 503
        && (lower.includes("no_available_channel") || lower.includes("no available channel"))
        && request.tools && request.tools.length > 0;
      if (shouldRetryWithoutTools) {
        const retryBody = buildOpenAiCompatibleBody({ ...request, tools: undefined, toolChoice: undefined }, config, false);
        const retryResponse = await fetchWithProxyFallback(fetchTarget, {
          method: "POST",
          headers,
          body: JSON.stringify(retryBody),
          signal: request.signal
        });
        if (retryResponse.ok) {
          return this.normalizeResponse(await retryResponse.json());
        }
        const retryError = await readErrorMessage(retryResponse);
        throw createHttpStatusError(
          retryResponse.status,
          buildOpenAiCompatibleServiceMessage(retryResponse.status, retryError, config) + "（已尝试去掉工具后重试仍失败）",
          endpointUrl
        );
      }
      throw createHttpStatusError(
        response.status,
        buildOpenAiCompatibleServiceMessage(response.status, errorMessage, config),
        endpointUrl
      );
    }

    return this.normalizeResponse(await response.json());
  },

  async streamMessage(request: ProviderRequest, config: ModelConfig): Promise<ProviderResponse> {
    const validation = this.validateConfig(config);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    // 带 tools 的请求必须非流式，才能完整拿到 tool_calls；由上层 agent loop 走 sendMessage
    if (request.tools && request.tools.length > 0) {
      return this.sendMessage(request, config);
    }

    const endpointUrl = buildProviderEndpointUrl(config.baseUrl, "chat/completions");
    const fetchTarget = buildFetchTarget(endpointUrl);
    logOpenAiCompatibleRequest("stream", endpointUrl, config);
    const streamHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey.trim()) {
      streamHeaders.Authorization = buildBearerToken(config.apiKey);
    }
    const response = await fetchWithProxyFallback(fetchTarget, {
      method: "POST",
      headers: streamHeaders,
      body: JSON.stringify(buildOpenAiCompatibleBody(request, config, true)),
      signal: request.signal
    });

    if (!response.ok) {
      const errorMessage = await readErrorMessage(response);
      throw createHttpStatusError(
        response.status,
        buildOpenAiCompatibleServiceMessage(response.status, errorMessage, config),
        endpointUrl
      );
    }

    if (!response.body) {
      throw new Error("模型没有返回可读取的流式内容。");
    }

    return readOpenAiCompatibleStream(response.body, request.onToken);
  },

  normalizeResponse(response: unknown): ProviderResponse {
    const parsedResponse = response as OpenAiCompatibleResponse;
    const choice = parsedResponse.choices?.[0];
    const message = choice?.message;
    const rawContent = message?.content;
    const content =
      typeof rawContent === "string" ? rawContent.trim() : "";
    let toolCalls = normalizeToolCalls(message?.tool_calls);

    // 根因修复：部分模型把工具调用以 DSML 文本写进正文而 tool_calls 为空。
    // 在此解析成真 tool_calls 去执行，绝不让协议原文下沉为最终回复。
    if (toolCalls.length === 0 && content) {
      const dsmlCalls = parseDsmlToolCalls(content);
      if (dsmlCalls.length > 0) {
        toolCalls = dsmlCalls.map((call, index) => ({
          id: `call_dsml_${index + 1}`,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args)
          }
        }));
      }
    }

    if (!content && toolCalls.length === 0) {
      // 推理模型（reasoning model）专用诊断：思考过程吃光输出额度时 content 为空，
      // 笼统报「没有返回有效内容」会让用户以为配置错了。点名根因并给出解法。
      if (typeof message?.reasoning_content === "string" && message.reasoning_content.trim()) {
        throw new Error(
          `当前是推理模型：它把输出长度全部用于思考过程，没有产出最终回答（finish_reason=${choice?.finish_reason ?? "unknown"}）。请在「设置 → 模型」把输出长度调到「长文/代码」（6000）或更高，或改用非推理模型。`
        );
      }
      throw new Error("模型没有返回有效内容。");
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: choice?.finish_reason ?? undefined
    };
  },

  mapError(error: unknown): Error {
    if (error instanceof ProviderRequestError) {
      return new Error(buildOpenAiCompatibleErrorMessage(error));
    }

    if (error instanceof Error) {
      return error;
    }

    return new Error("模型连接暂时不可用。");
  }
};

function buildOpenAiCompatibleBody(
  request: ProviderRequest,
  config: ModelConfig,
  stream: boolean
) {
  const body: Record<string, unknown> = {
    model: config.modelName,
    messages: request.messages.map(serializeOpenAiCompatibleMessage),
    temperature: normalizeOpenAiCompatibleTemperature(config.temperature),
    max_tokens: config.maxOutputTokens,
    ...buildOpenAiCompatibleReasoningOptions(config),
    stream
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = request.toolChoice ?? "auto";
  }

  return body;
}

/**
 * 多模态消息序列化为 OpenAI 兼容格式：
 *   text → { type:"text", text }；image → { type:"image_url", image_url:{ url: dataURL } }。
 * document 块在该协议无原生支持，能力判定层应已在上游降级为 text，此处兜底转为文件名占位说明。
 */
function serializeOpenAiCompatibleMessage(message: ProviderMessage) {
  if (!Array.isArray(message.content)) {
    return message;
  }

  const content = message.content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` }
      };
    }
    return { type: "text", text: `[附件文档：${part.name ?? "未命名"}，当前模型不支持直接读取该格式]` };
  });

  return { ...message, content };
}

function normalizeToolCalls(
  raw: OpenAiCompatibleToolCall[] | undefined
): ProviderToolCall[] {
  if (!raw || raw.length === 0) {
    return [];
  }

  const calls: ProviderToolCall[] = [];
  for (const item of raw) {
    const name = item.function?.name?.trim();
    if (!name) {
      continue;
    }
    calls.push({
      id: item.id?.trim() || `call_${calls.length + 1}`,
      type: "function",
      function: {
        name,
        arguments:
          typeof item.function?.arguments === "string"
            ? item.function.arguments
            : "{}"
      }
    });
  }
  return calls;
}

function normalizeOpenAiCompatibleTemperature(temperature: number) {
  return Math.min(Math.max(temperature, 0.01), 1);
}

function buildBearerToken(apiKey: string) {
  return `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}`;
}

function buildOpenAiCompatibleReasoningOptions(config: ModelConfig) {
  if (!config.thinkingModeEnabled || !isOpenAiConfig(config)) {
    return {};
  }

  return {
    reasoning_effort: mapThinkingModeToReasoningEffort(config.modelStrength)
  };
}

function isOpenAiConfig(config: ModelConfig) {
  try {
    return new URL(config.baseUrl).hostname.endsWith("openai.com");
  } catch {
    return false;
  }
}

function isOllamaLocalConfig(config: ModelConfig) {
  try {
    const hostname = new URL(config.baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function mapThinkingModeToReasoningEffort(strength: ModelConfig["modelStrength"]) {
  if (strength === "low") {
    return "low";
  }

  if (strength === "high" || strength === "max") {
    return "high";
  }

  return "medium";
}

function buildOpenAiCompatibleErrorMessage(error: ProviderRequestError) {
  if (error.kind === "proxy-unavailable") {
    return error.message;
  }

  if (error.kind === "network") {
    return "模型网络请求失败。请检查 Base URL、网络连通性或目标接口配置。";
  }

  const status = error.status ?? 0;
  const errorMessage = error.serviceMessage;

  if (status === 401 || status === 403) {
    return `模型请求失败：${status} 鉴权失败。请确认 API Key 可用且请求头格式正确。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status === 404) {
    return `模型请求失败：404。请确认 Base URL、接口路径和模型名是否正确。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status === 429) {
    return `模型请求失败：429，请求过于频繁或额度不足。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  if (status >= 500) {
    const lower = (errorMessage || "").toLowerCase();
    if (lower.includes("no_available_channel") || lower.includes("no available channel")) {
      return `模型请求失败：${status}，当前模型「${status >= 500 ? "在该中转站暂时没有可用通道" : ""}」—— 这是中转站侧该模型的所有渠道都挂了/被限流，不是 VOID 拼错参数。你在别的产品里能通，很可能是那边用了不同模型或没走工具调用。建议：在 VOID 设置里把模型名换成 gpt-4o-mini 再试，或等几分钟后重试。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
    }
    return `模型请求失败：${status}，目标模型服务暂时异常。${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
  }

  return `模型请求失败：${status}${errorMessage ? ` 服务端信息：${errorMessage}` : ""}`;
}

function isVolcengineArkConfig(config: ModelConfig) {
  try {
    return new URL(config.baseUrl).hostname.endsWith("volces.com");
  } catch {
    return false;
  }
}

function buildOpenAiCompatibleServiceMessage(status: number, errorMessage: string, config: ModelConfig) {
  if (status === 401 && isVolcengineArkConfig(config)) {
    return [
      "豆包 Ark 鉴权失败。",
      "请确认 API Key 填的是 API Key Secret，不是 API Key ID、Access Key ID、Secret Access Key 或火山 AK/SK。",
      errorMessage
    ].filter(Boolean).join(" ");
  }

  return errorMessage;
}

function logOpenAiCompatibleRequest(mode: "send" | "stream", endpointUrl: string, config: ModelConfig) {
  const isViteDev = Boolean(
    typeof import.meta !== "undefined"
    && import.meta.env
    && import.meta.env.DEV
  );
  if (!isViteDev) {
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
  let reasoningLength = 0;
  // 流式 tool_calls 按 index 累积（部分中转站会边流边吐 arguments）
  const toolCallBuffers = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

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

      try {
        const parsedPayload = JSON.parse(payload) as OpenAiCompatibleResponse;
        const delta = parsedPayload.choices?.[0]?.delta;
        const token = typeof delta?.content === "string" ? delta.content : "";
        if (token) {
          content += token;
          onToken?.(token);
        }

        // 推理模型的思考块（delta.reasoning_content）不进入回复与 TTS；
        // 仅累计长度，用于流结束后 content 为空时的精确诊断。
        if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
          reasoningLength += delta.reasoning_content.length;
        }

        if (delta?.tool_calls) {
          for (const partial of delta.tool_calls) {
            const index = typeof partial.index === "number" ? partial.index : 0;
            const current = toolCallBuffers.get(index) ?? {
              id: "",
              name: "",
              arguments: ""
            };
            if (partial.id) {
              current.id = partial.id;
            }
            if (partial.function?.name) {
              current.name += partial.function.name;
            }
            if (typeof partial.function?.arguments === "string") {
              current.arguments += partial.function.arguments;
            }
            toolCallBuffers.set(index, current);
          }
        }
      } catch {
        // 忽略单行坏包
      }
    }
  }

  const toolCalls = Array.from(toolCallBuffers.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, item], index) => ({
      id: item.id || `call_${index + 1}`,
      type: "function" as const,
      function: {
        name: item.name,
        arguments: item.arguments || "{}"
      }
    }))
    .filter((item) => item.function.name.trim());

  const finalContent = content.trim();
  if (!finalContent && toolCalls.length === 0) {
    if (reasoningLength > 0) {
      throw new Error(
        "当前是推理模型：它把输出长度全部用于思考过程，没有产出最终回答。请在「设置 → 模型」把输出长度调到「长文/代码」（6000）或更高，或改用非推理模型。"
      );
    }
    throw new Error("模型没有返回有效内容。");
  }

  return {
    content: finalContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined
  };
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
