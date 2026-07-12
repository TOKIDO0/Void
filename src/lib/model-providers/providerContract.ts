import type { ModelConfig } from "../../features/settings/modelConfig";

export type ProviderRole = "system" | "user" | "assistant" | "tool";

/**
 * OpenAI-compatible 函数工具定义（模型可见部分）。
 */
export type ProviderToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema object */
    parameters: Record<string, unknown>;
  };
};

/**
 * 模型发起的一次工具调用。
 */
export type ProviderToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    /** 模型返回的参数 JSON 字符串 */
    arguments: string;
  };
};

/**
 * 发给模型的消息。assistant 可带 tool_calls；tool 角色回写结果。
 */
export type ProviderMessage = {
  role: ProviderRole;
  content: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ProviderRequest = {
  messages: ProviderMessage[];
  /** 可选：本轮暴露给模型的工具列表 */
  tools?: ProviderToolDefinition[];
  /** 默认 auto；none 表示禁止调工具 */
  toolChoice?: "auto" | "none";
  onToken?: (token: string) => void;
  signal?: AbortSignal;
};

export type ProviderResponse = {
  /** 纯文本回复；仅有 tool_calls 时可能为空串 */
  content: string;
  toolCalls?: ProviderToolCall[];
  finishReason?: string;
};

export type ProviderValidationResult = {
  valid: boolean;
  message?: string;
};

export type ModelProvider = {
  sendMessage: (request: ProviderRequest, config: ModelConfig) => Promise<ProviderResponse>;
  streamMessage: ((request: ProviderRequest, config: ModelConfig) => Promise<ProviderResponse>) | null;
  /**
   * 是否支持 tools / tool_calls。
   * 不支持时对话层不得强行进入 agent loop。
   */
  supportsTools?: boolean;
  validateConfig: (config: ModelConfig) => ProviderValidationResult;
  normalizeResponse: (response: unknown) => ProviderResponse;
  mapError: (error: unknown) => Error;
};
