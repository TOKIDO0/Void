// VOID 记忆系统 —— 冲突合并与衰减（M5）
// 职责：判断「同事实槽」是否冲突并产出更新决策；提供仅影响排序的时间衰减分。
// 不写库、不接 LLM；禁止静默编造用户未说过的内容。

import type { MemoryEntry, MemoryType } from "./memoryTypes";

/** 冲突裁决结果：要么无冲突可追加，要么更新已有 id。 */
export type ConflictResolution =
  | { action: "append" }
  | {
      action: "update";
      /** 被更新的旧条目 id */
      targetId: string;
      /** 写入库的最终内容（通常用新条表述） */
      content: string;
      confidence: number;
    };

/** 分区半衰期（毫秒）：越短，旧条在排序里掉得越快。仅排序，不删除。 */
const HALF_LIFE_MS_BY_TYPE: Record<MemoryType, number> = {
  // 情绪易变：约 7 天
  emotionTrend: 7 * 24 * 60 * 60 * 1000,
  // 任务会过期：约 14 天
  task: 14 * 24 * 60 * 60 * 1000,
  // 偏好/画像较稳：约 90 天
  preference: 90 * 24 * 60 * 60 * 1000,
  userProfile: 90 * 24 * 60 * 60 * 1000,
  longTermGoal: 120 * 24 * 60 * 60 * 1000,
  healthRecord: 120 * 24 * 60 * 60 * 1000,
  relationship: 60 * 24 * 60 * 60 * 1000,
  knowledgeCache: 45 * 24 * 60 * 60 * 1000,
  // 关系事件档案：约 180 天
  agentRelationship: 180 * 24 * 60 * 60 * 1000
};

/** 不做对立覆盖的分区：只靠原 dedupe/时间窗。 */
const SKIP_CONFLICT_TYPES: ReadonlySet<MemoryType> = new Set([
  "emotionTrend",
  "agentRelationship",
  "task"
]);

/**
 * 话题槽关键词表：命中任一关键词 → 同一 topicKey。
 * 用于把「喜欢猫 / 不喜欢猫」收进同一槽，而不是和「喜欢咖啡」冲突。
 */
const TOPIC_KEYWORD_GROUPS: readonly { topicKey: string; keywords: readonly string[] }[] = [
  { topicKey: "称呼", keywords: ["叫我", "称呼", "名字", "昵称"] },
  { topicKey: "作息", keywords: ["晚睡", "早睡", "作息", "熬夜", "早起"] },
  { topicKey: "宠物-猫", keywords: ["猫"] },
  { topicKey: "宠物-狗", keywords: ["狗", "犬"] },
  { topicKey: "饮食-香菜", keywords: ["香菜"] },
  { topicKey: "饮食-辣椒", keywords: ["辣椒", "辣椒酱", "辣"] },
  { topicKey: "饮食-湘菜", keywords: ["湘菜"] },
  { topicKey: "饮食-新疆菜", keywords: ["新疆菜"] },
  { topicKey: "饮食-大盘羊", keywords: ["大盘羊"] },
  { topicKey: "交通-国产车", keywords: ["国产车"] },
  { topicKey: "交通-特斯拉", keywords: ["特斯拉"] },
  { topicKey: "交通-丰田", keywords: ["丰田"] },
  { topicKey: "交通-日产", keywords: ["日产"] },
  { topicKey: "交通-国外车", keywords: ["国外车", "外企车", "进口车"] },
  { topicKey: "职业", keywords: ["工作", "职业", "程序员", "上班"] },
  { topicKey: "语言", keywords: ["中文", "英文", "普通话", "粤语"] }
];

const POSITIVE_MARKERS: readonly string[] = [
  "喜欢",
  "爱吃",
  "爱",
  "偏好",
  "更喜欢",
  "擅长",
  "支持",
  "是"
];

const NEGATIVE_MARKERS: readonly string[] = [
  "不喜欢",
  "讨厌",
  "别",
  "不要",
  "不再",
  "不爱",
  "反感",
  "不是",
  "不吃"
];

/**
 * 在已有条目中查找与 candidate 冲突的同槽事实。
 * - 无冲突 → append
 * - 同槽一致或对立 → update 最新表述（对立时也用新条覆盖旧条）
 */
export function resolveMemoryConflict(
  candidate: MemoryEntry,
  existingEntries: readonly MemoryEntry[]
): ConflictResolution {
  if (SKIP_CONFLICT_TYPES.has(candidate.memoryType)) {
    return { action: "append" };
  }

  const candidateSlot = buildFactSlotKey(candidate);
  if (!candidateSlot.topicKey) {
    // 抽不出话题槽：不冒险对立合并，交给原文 dedupe
    return { action: "append" };
  }

  let best: MemoryEntry | null = null;
  for (const entry of existingEntries) {
    if (entry.id === candidate.id) {
      continue;
    }
    if (
      entry.memoryType !== candidate.memoryType ||
      entry.subjectType !== candidate.subjectType ||
      entry.subjectName !== candidate.subjectName
    ) {
      continue;
    }
    const existingSlot = buildFactSlotKey(entry);
    if (existingSlot.topicKey !== candidateSlot.topicKey) {
      continue;
    }
    // 同槽即视为可合并/可覆盖（一致刷新 or 对立更新）
    if (!best || entry.updatedAt > best.updatedAt) {
      best = entry;
    }
  }

  if (!best) {
    return { action: "append" };
  }

  return {
    action: "update",
    targetId: best.id,
    content: candidate.content,
    confidence: Math.max(best.confidence, candidate.confidence)
  };
}

/**
 * 时间衰减后的排序分：base 默认用 confidence。
 * half-life 指数衰减，永不物理删除。
 */
export function applyMemoryDecayScore(
  entry: MemoryEntry,
  now: number = Date.now(),
  baseScore?: number
): number {
  const base = baseScore ?? entry.confidence;
  const halfLife = HALF_LIFE_MS_BY_TYPE[entry.memoryType] ?? 90 * 24 * 60 * 60 * 1000;
  const age = Math.max(0, now - entry.updatedAt);
  if (halfLife <= 0) {
    return base;
  }
  const decayFactor = Math.pow(0.5, age / halfLife);
  return base * decayFactor;
}

/** 供调试/面板扩展：导出槽位键。 */
export function buildFactSlotKey(entry: Pick<MemoryEntry, "memoryType" | "subjectType" | "subjectName" | "content">): {
  slotKey: string;
  topicKey: string | null;
} {
  const topicKey = extractTopicKey(entry.content);
  const slotKey = [
    entry.memoryType,
    entry.subjectType,
    entry.subjectName,
    topicKey ?? "_"
  ].join("|");
  return { slotKey, topicKey };
}

/** 从内容抽话题键：先匹配关键词组，否则 null。 */
export function extractTopicKey(content: string): string | null {
  const text = content.trim();
  if (!text) {
    return null;
  }
  for (const group of TOPIC_KEYWORD_GROUPS) {
    if (group.keywords.some((keyword) => text.includes(keyword))) {
      return group.topicKey;
    }
  }
  return null;
}

/** 判断两段文本在同槽下是否语义对立（规则版，不调模型）。 */
export function isOpposingPolarity(a: string, b: string): boolean {
  const polA = detectPolarity(a);
  const polB = detectPolarity(b);
  if (polA === "unknown" || polB === "unknown") {
    return false;
  }
  return polA !== polB;
}

function detectPolarity(text: string): "positive" | "negative" | "unknown" {
  // 先匹配更长的否定，避免「不喜欢」被「喜欢」误判为正
  if (NEGATIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "negative";
  }
  if (POSITIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "positive";
  }
  return "unknown";
}
