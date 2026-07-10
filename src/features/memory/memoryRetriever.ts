// VOID 记忆系统 —— 按意图召回
// 职责单一：根据当前用户问题判出意图，只召回相关分区的有界条数记忆，绝不全量塞 prompt。
// 分区映射对齐 04 号第 4 节召回规则。读库走 memoryStore，不写、不分类、不投影。

import type { MemoryEntry, MemoryType } from "./memoryTypes";
import { listMemories } from "./memoryStore";

/** 召回意图：从用户当前问题推断，决定拉哪些分区。 */
export type RetrievalIntent =
  | "health" // 健康咨询
  | "emotion" // 情绪倾诉
  | "task" // 任务整理
  | "professional" // 专业问题
  | "relationship" // 人际关系
  | "general"; // 泛化 / 无强意图

/**
 * 意图 → 目标分区映射（04 号第 4 节）：
 * - 健康：健康档案 + 用户画像
 * - 情绪：情绪状态 + 用户画像（近期相关上下文）
 * - 任务：任务待办 + 长期目标
 * - 专业：专业知识缓存（当前模型检索结果不在本模块）
 * - 人际：人际关系 + 情绪状态
 * - 泛化：用户画像 + 偏好（提供最小人设底座）
 */
const INTENT_TYPE_MAP: Record<RetrievalIntent, readonly MemoryType[]> = {
  health: ["healthRecord", "userProfile"],
  emotion: ["emotionTrend", "userProfile"],
  task: ["task", "longTermGoal"],
  professional: ["knowledgeCache"],
  relationship: ["relationship", "emotionTrend"],
  general: ["userProfile", "preference"]
};

/** 意图识别关键词表（按判定优先级排列，命中即定意图）。 */
const INTENT_RULES: readonly { intent: RetrievalIntent; keywords: readonly string[] }[] = [
  { intent: "health", keywords: ["病", "身体", "健康", "药", "睡眠", "血压", "血糖", "体检", "医院", "医生"] },
  { intent: "task", keywords: ["提醒", "待办", "安排", "计划", "截止", "deadline", "日程", "要做", "别忘"] },
  { intent: "relationship", keywords: ["朋友", "同事", "家人", "关系", "矛盾", "吵架", "相处", "沟通"] },
  { intent: "emotion", keywords: ["焦虑", "压力", "难过", "情绪", "低落", "崩溃", "烦", "孤独", "累"] },
  { intent: "professional", keywords: ["资料", "原理", "怎么实现", "技术", "研究", "文档", "科普", "为什么"] }
];

/** 单次召回默认返回上限，防止 prompt 膨胀。 */
const DEFAULT_MAX_ENTRIES = 6;

export type RetrieveOptions = {
  /** 返回条数上限，默认 6 */
  maxEntries?: number;
  /** 现在时间 epoch ms，用于过滤过期条目；默认取运行时当前时间 */
  now?: number;
};

/** 召回结果：命中的意图 + 召回条目（已排序、已截断）。 */
export type RetrieveResult = {
  intent: RetrievalIntent;
  entries: MemoryEntry[];
};

/**
 * 按用户当前问题召回相关记忆。
 * 流程：判意图 → 取目标分区 → 过滤（分区匹配 + 未过期）→ 排序 → 截断。
 */
export function retrieveMemories(query: string, options: RetrieveOptions = {}): RetrieveResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now();

  const intent = detectIntent(query);
  const targetTypes = INTENT_TYPE_MAP[intent];

  const entries = listMemories()
    .filter((entry) => targetTypes.includes(entry.memoryType))
    .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now)
    .sort(compareByRelevance)
    .slice(0, maxEntries);

  return { intent, entries };
}

/** 从用户问题推断召回意图，无强特征则归 general。 */
export function detectIntent(query: string): RetrievalIntent {
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((keyword) => query.includes(keyword))) {
      return rule.intent;
    }
  }
  return "general";
}

/** 相关性排序：置信度优先，其次更新时间更近者优先。 */
function compareByRelevance(a: MemoryEntry, b: MemoryEntry): number {
  if (b.confidence !== a.confidence) {
    return b.confidence - a.confidence;
  }
  return b.updatedAt - a.updatedAt;
}
