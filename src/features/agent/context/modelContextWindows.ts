// 模型上下文窗口表（阶段 AD-P1，43 号总规划）。
// 内置主流模型映射，未知回退 32k（宁早提醒）。

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 1047576,
  "gpt-4.1-mini": 1047576,
  "gpt-3.5-turbo": 16385,
  // Anthropic
  "claude-3-5-sonnet": 200000,
  "claude-3-5-haiku": 200000,
  "claude-sonnet-4": 200000,
  "claude-opus-4": 200000,
  // DeepSeek
  "deepseek-chat": 64000,
  "deepseek-reasoner": 64000,
  "deepseek-v4-flash": 64000,
  "deepseek-coder": 64000,
  // Google
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000,
  "gemini-2.0-flash": 1000000,
  // Alibaba
  "qwen2.5-72b": 131072,
  "qwen-max": 32000,
  "qwen-turbo": 8000,
  // Zhipu
  "glm-4": 128000,
  "glm-4-plus": 128000,
  // Fallback handled below
};

const DEFAULT_WINDOW = 32768;

export function resolveModelContextWindow(modelName: string): number {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return DEFAULT_WINDOW;
  // 精确匹配优先
  if (MODEL_CONTEXT_WINDOWS[normalized] !== undefined) {
    return MODEL_CONTEXT_WINDOWS[normalized];
  }
  // 前缀匹配（处理带版本后缀如 gpt-4o-2024-08-06）
  for (const [key, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized.startsWith(key)) {
      return window;
    }
  }
  // 关键词回退
  if (normalized.includes("claude")) return 200000;
  if (normalized.includes("gemini")) return 1000000;
  if (normalized.includes("qwen")) return 32000;
  if (normalized.includes("glm")) return 128000;
  if (normalized.includes("gpt-4")) return 128000;
  return DEFAULT_WINDOW;
}

export function getKnownModelWindowEntries(): Array<{ model: string; window: number }> {
  return Object.entries(MODEL_CONTEXT_WINDOWS).map(([model, window]) => ({ model, window }));
}
