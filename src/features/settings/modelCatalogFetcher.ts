import type { ModelProviderType, ModelStrength } from "./modelConfig";
import { buildFetchTarget, buildProviderEndpointUrl, fetchWithProxyFallback } from "../../lib/model-providers/providerUrl";

/**
 * 模型列表自动拉取。
 *
 * 目标：用户填好 Base URL + API Key 后，直接向厂商的 `GET {baseUrl}/models` 拉取
 * 该 Key 可用的全部模型，按最新在前排列，填进「模型选择」下拉框。
 *
 * 请求链路复用 buildFetchTarget（与聊天同路径：Tauri→sidecar / dev→vite 代理 / prod→/api/model），
 * 从而天然规避浏览器/WebView 的 CORS，无需新增任何直连逻辑。
 *
 * 接口事实（已按官方文档/ SDK 核实）：
 *   - OpenAI 兼容：GET {baseUrl}/models，Authorization: Bearer；响应 { object:"list", data:[{ id, created?, owned_by }] }。
 *     DeepSeek 的响应【没有 created 字段】，排序必须对缺失容错。
 *   - Anthropic：GET {baseUrl}/models，x-api-key + anthropic-version；响应 data:[{ id, display_name, created_at }]，默认最新在前。
 */

export type FetchedModel = {
  modelName: string;
  label: string;
  strength: ModelStrength;
};

export type ModelCatalogResult =
  | { ok: true; models: FetchedModel[] }
  | { ok: false; message: string };

const MODELS_TERMINAL_PATH = "models";
const ANTHROPIC_VERSION = "2023-06-01";

/** OpenAI 兼容的单条模型记录（created 可能缺失，如 DeepSeek）。 */
type OpenAiModelRecord = {
  id?: string;
  created?: number;
  owned_by?: string;
};

/** Anthropic 的单条模型记录。 */
type AnthropicModelRecord = {
  id?: string;
  display_name?: string;
  created_at?: string;
};

type ModelListResponse = {
  data?: Array<OpenAiModelRecord & AnthropicModelRecord>;
};

/**
 * 拉取并归一化模型列表。失败时返回 { ok:false, message }，由调用方降级到内置列表。
 */
export async function fetchModelCatalog(
  provider: ModelProviderType,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelCatalogResult> {
  const trimmedBaseUrl = baseUrl.trim();
  const trimmedApiKey = apiKey.trim().replace(/^Bearer\s+/i, "");
  if (!trimmedBaseUrl) {
    return { ok: false, message: "需要先填写 Base URL。" };
  }
  if (!trimmedApiKey) {
    return { ok: false, message: "需要先填写 API Key。" };
  }

  let endpointUrl: string;
  try {
    endpointUrl = buildProviderEndpointUrl(trimmedBaseUrl, MODELS_TERMINAL_PATH);
    new URL(endpointUrl);
  } catch {
    return { ok: false, message: "Base URL 格式不正确。" };
  }

  const fetchTarget = buildFetchTarget(endpointUrl);
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": trimmedApiKey, "anthropic-version": ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${trimmedApiKey}` };

  let response: Response;
  try {
    response = await fetchWithProxyFallback(fetchTarget, {
      method: "GET",
      headers,
      signal
    });
  } catch (error) {
    return { ok: false, message: resolveNetworkErrorMessage(error) };
  }

  if (!response.ok) {
    return { ok: false, message: `获取模型列表失败（HTTP ${response.status}）。` };
  }

  let payload: ModelListResponse;
  try {
    payload = (await response.json()) as ModelListResponse;
  } catch {
    return { ok: false, message: "模型列表响应解析失败。" };
  }

  const records = Array.isArray(payload.data) ? payload.data : [];
  if (!records.length) {
    return { ok: false, message: "该 Key 未返回任何可用模型。" };
  }

  const models = provider === "anthropic"
    ? normalizeAnthropicModels(records)
    : normalizeOpenAiModels(records);

  if (!models.length) {
    return { ok: false, message: "模型列表为空或格式不符。" };
  }

  return { ok: true, models };
}

/** OpenAI 兼容：按 created 降序（缺失则保持服务端返回顺序，稳定排序保证）。 */
function normalizeOpenAiModels(records: Array<OpenAiModelRecord & AnthropicModelRecord>): FetchedModel[] {
  const indexed = records
    .filter((record) => typeof record.id === "string" && record.id.trim())
    .map((record, index) => ({ record, index }));

  indexed.sort((left, right) => {
    const leftCreated = typeof left.record.created === "number" ? left.record.created : null;
    const rightCreated = typeof right.record.created === "number" ? right.record.created : null;
    // 两者都有 created：新的在前；否则保持原始返回顺序（稳定）。
    if (leftCreated !== null && rightCreated !== null && leftCreated !== rightCreated) {
      return rightCreated - leftCreated;
    }
    return left.index - right.index;
  });

  return indexed.map(({ record }) => {
    const modelName = record.id!.trim();
    return {
      modelName,
      label: modelName,
      strength: inferModelStrength(modelName)
    };
  });
}

/** Anthropic：按 created_at 降序（缺失则保持返回顺序，其默认即最新在前）。 */
function normalizeAnthropicModels(records: Array<OpenAiModelRecord & AnthropicModelRecord>): FetchedModel[] {
  const indexed = records
    .filter((record) => typeof record.id === "string" && record.id.trim())
    .map((record, index) => ({ record, index }));

  indexed.sort((left, right) => {
    const leftTime = parseIsoTime(left.record.created_at);
    const rightTime = parseIsoTime(right.record.created_at);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return left.index - right.index;
  });

  return indexed.map(({ record }) => {
    const modelName = record.id!.trim();
    const label = typeof record.display_name === "string" && record.display_name.trim()
      ? record.display_name.trim()
      : modelName;
    return {
      modelName,
      label,
      strength: inferModelStrength(modelName)
    };
  });
}

function parseIsoTime(value: string | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/**
 * 从模型名推断强度档位（仅作为下拉框默认值，用户可在「模型强度」手动改）。
 * 自动拉取的模型没有官方强度标注，用命名习惯做轻量映射。
 */
function inferModelStrength(modelName: string): ModelStrength {
  const name = modelName.toLowerCase();
  if (/(opus|max|ultra|-pro\b|pro-|405b|-large)/.test(name)) {
    return "max";
  }
  if (/(sonnet|plus|-32k|reasoner|thinking|-70b)/.test(name)) {
    return "high";
  }
  if (/(flash|lite|mini|nano|haiku|tiny|small|turbo|-8b)/.test(name)) {
    return "low";
  }
  return "middle";
}

function resolveNetworkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `获取模型列表失败：${error.message}`;
  }
  return "获取模型列表失败：网络异常。";
}
