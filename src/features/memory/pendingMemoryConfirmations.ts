// VOID 记忆系统 —— 敏感记忆写入确认队列（42 号文档，阶段 AA）。
// 职责：暂存需要用户点头才写入的候选（健康/敏感），提供对话式结算词表。
// 纪律：
//   - 一次只问一条；队列上限 3、FIFO 丢最旧（有界运行面）。
//   - 内存态：刷新即清——用户没确认的东西不该「复活」。
//   - 词表窄解析：解析不了返回 null 走正常对话，禁止瞎批准（对齐 voiceConfirmationParser 纪律）。

import type { MemoryType, Sensitivity, SubjectType } from "./memoryTypes";
import { normalizeVoiceConfirmationText } from "../agent/permissions/voiceConfirmationParser";

export type PendingMemoryCandidate = {
  memoryType: MemoryType;
  subjectType: SubjectType;
  subjectName: string;
  content: string;
  sensitivity: Sensitivity;
  /** 去重合并时间窗；透传给 upsertMemoryDeduped。 */
  mergeWindowMs?: number;
  source?: string;
  confidence?: number;
  askedAt: number;
};

export type MemoryConfirmationIntent = "approve" | "reject";

const MAX_PENDING_MEMORY_CONFIRMATIONS = 3;

let queue: PendingMemoryCandidate[] = [];

export function enqueuePendingMemoryConfirmation(
  candidate: Omit<PendingMemoryCandidate, "askedAt">
): void {
  queue.push({ ...candidate, askedAt: Date.now() });
  while (queue.length > MAX_PENDING_MEMORY_CONFIRMATIONS) {
    queue.shift();
  }
}

export function peekPendingMemoryConfirmation(): PendingMemoryCandidate | null {
  return queue[0] ?? null;
}

export function dequeuePendingMemoryConfirmation(): PendingMemoryCandidate | null {
  return queue.shift() ?? null;
}

export function clearPendingMemoryConfirmations(): void {
  queue = [];
}

export function hasPendingMemoryConfirmations(): boolean {
  return queue.length > 0;
}

/**
 * 把用户语音/文字定稿解析为记忆确认意图。
 * @returns approve | reject | null（无法判断则 null，交回正常对话）
 */
export function parseMemoryConfirmationIntent(rawText: string): MemoryConfirmationIntent | null {
  const normalized = normalizeVoiceConfirmationText(rawText);
  if (!normalized) {
    return null;
  }

  // 否定优先：避免「不用记了」被「记」误判为批准。
  if (REJECT_PHRASES.some((phrase) => normalized === phrase)) {
    return "reject";
  }
  if (APPROVE_PHRASES.some((phrase) => normalized === phrase)) {
    return "approve";
  }
  return null;
}

const APPROVE_PHRASES: readonly string[] = [
  "记下来",
  "记一下",
  "记着",
  "记着吧",
  "记住",
  "记吧",
  "记",
  "保存",
  "保存吧",
  "存",
  "存吧",
  "记上",
  "好",
  "好的",
  "好啊",
  "可以",
  "可以啊",
  "行",
  "行啊",
  "嗯",
  "要",
  "要记"
];

const REJECT_PHRASES: readonly string[] = [
  "不用",
  "不用了",
  "不用记",
  "不用记了",
  "别记",
  "别记了",
  "别存",
  "不要记",
  "不要记了",
  "不记",
  "不记了",
  "算了",
  "算了不用",
  "删了吧",
  "不用保存",
  "不要",
  "不"
];
