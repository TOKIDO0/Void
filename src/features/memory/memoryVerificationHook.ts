// VOID 记忆自验钩子（阶段 3 用户要求：功能/记忆自验收，不依赖 TTS/STT）。
// 记录最近写入的候选，供自测工具随时拉取快照；不直接依赖 memoryStore 以避免循环引用。

type VerificationRecord = {
  content: string;
  memoryType: string;
  subjectType: string;
  writtenAt: number;
};

let recentVerifications: VerificationRecord[] = [];
const MAX_RECORDS = 20;

export function recordMemoryVerification(content: string, memoryType: string, subjectType: string): void {
  recentVerifications.unshift({ content, memoryType, subjectType, writtenAt: Date.now() });
  if (recentVerifications.length > MAX_RECORDS) {
    recentVerifications = recentVerifications.slice(0, MAX_RECORDS);
  }
}

export function getMemoryVerificationSnapshot(): {
  recentVerifications: VerificationRecord[];
} {
  return { recentVerifications: [...recentVerifications] };
}
