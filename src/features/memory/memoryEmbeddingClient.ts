// VOID 记忆语义召回 —— 前端 embedding 客户端（M4）
// 职责单一：把文本发给本地 bridge 的 /void-memory/embed 换取句向量。
// 不做融合、不做排序、不判开关 —— 那些在 ranker / retriever 里。
//
// 降级契约：任何不可用情形（bridge 未起、超时、HTTP 非 2xx、响应异常）一律返回 null，
// 由 retriever 据此回退纯全文检索，绝不把异常抛给对话主路径。
// 首次调用可能因 bridge 侧模型尚在加载而超时返回 null（本轮降级）；bridge 侧模型会在
// 后台继续加载完成并常驻，下一轮召回即可命中，无需前端额外预热。

import { resolveBridgeHttpOrigin } from "../../lib/runtime/voidBridgeRuntime";
import { bridgeAuthHeadersForUrl } from "../../lib/runtime/voidBridgeAuth";

/** 召回场景默认超时：够一次本地推理，又不至于把发消息卡太久；超时即本轮降级。 */
const EMBED_TIMEOUT_MS = 6000;

type EmbedOptions = {
  /** 查询侧为 true（bridge 会补检索指令前缀）；被检索文本为 false。 */
  isQuery: boolean;
  /** 外部取消信号（如整轮对话被取消）。 */
  signal?: AbortSignal;
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number;
};

type EmbedResponse = {
  ok?: boolean;
  data?: { vectors?: unknown; dim?: unknown; model?: unknown };
};

/**
 * 把一批文本编码成句向量。
 * @returns 与入参顺序一一对应的向量数组；不可用时返回 null（降级信号）。
 */
export async function embedMemoryTexts(
  texts: string[],
  options: EmbedOptions
): Promise<number[][] | null> {
  if (texts.length === 0) {
    return [];
  }

  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  try {
    const url = `${resolveBridgeHttpOrigin()}/void-memory/embed`;
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ texts, isQuery: options.isQuery }),
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as EmbedResponse;
    if (!payload || payload.ok !== true || !payload.data) {
      return null;
    }
    const vectors = payload.data.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      return null;
    }
    // 逐条校验为数字数组，任一异常即整体降级，避免脏向量污染相似度计算。
    const normalized: number[][] = [];
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
        return null;
      }
      normalized.push(vector as number[]);
    }
    return normalized;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
