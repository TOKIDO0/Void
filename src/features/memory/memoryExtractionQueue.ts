// VOID 记忆系统 —— 后台提炼队列
// 职责：把「值得记」的用户句串行交给 LLM 提炼，再回调落库；不阻塞 UI / TTS / 主回复。
// 资源纪律：同时最多 1 路提炼；积压有上限；失败静默丢弃（不回退写整句）。

import type { ModelConfig } from "../settings/modelConfig";
import {
  extractMemoryFactsFromUserMessage,
  type ExtractedMemoryFact
} from "./memoryLlmExtractor";

export type MemoryExtractionPersistHandler = (facts: ExtractedMemoryFact[]) => void;

type QueueItem = {
  id: string;
  userMessage: string;
  modelConfig: ModelConfig;
  onPersist: MemoryExtractionPersistHandler;
};

/** 同时只跑 1 个提炼请求，避免和主对话抢带宽/占满机器。 */
const MAX_CONCURRENT = 1;
/** 排队上限：超出时丢最旧，保证后台不会无限堆积。 */
const MAX_QUEUE_LENGTH = 3;

const pending: QueueItem[] = [];
let activeCount = 0;

/**
 * 将一句用户原话排入后台提炼。立即返回，绝不 await。
 * 调用方应在 success 回合后调用；情绪/P6 专线不要走这里。
 */
export function enqueueMemoryExtraction(input: {
  userMessage: string;
  modelConfig: ModelConfig;
  onPersist: MemoryExtractionPersistHandler;
}): void {
  const userMessage = input.userMessage.trim();
  if (!userMessage) {
    return;
  }

  const item: QueueItem = {
    id: createQueueId(),
    userMessage,
    modelConfig: input.modelConfig,
    onPersist: input.onPersist
  };

  pending.push(item);
  // 积压超限：丢掉最旧任务，优先服务最近对话
  while (pending.length > MAX_QUEUE_LENGTH) {
    pending.shift();
  }

  void pumpQueue();
}

/** 当前排队 + 在飞数量（调试/以后可观测用）。 */
export function getMemoryExtractionQueueSize(): number {
  return pending.length + activeCount;
}

async function pumpQueue(): Promise<void> {
  if (activeCount >= MAX_CONCURRENT) {
    return;
  }
  const next = pending.shift();
  if (!next) {
    return;
  }

  activeCount += 1;
  try {
    const result = await extractMemoryFactsFromUserMessage(next.userMessage, next.modelConfig);
    if (result.facts.length > 0) {
      try {
        next.onPersist(result.facts);
      } catch {
        // 落库回调失败不影响队列
      }
    }
  } catch {
    // 提炼异常已在 extractor 内消化；这里再兜一层
  } finally {
    activeCount -= 1;
    if (pending.length > 0) {
      void pumpQueue();
    }
  }
}

function createQueueId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `mem-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
