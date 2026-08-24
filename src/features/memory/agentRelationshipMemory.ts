// P6：VOID 与用户显著关系事件 → 长期记忆（agentRelationship 分区）。
// 设计真源：04 §7-§9、33 §8.1。
// 职责：从 SocialEventReading + AgentAffectState 派生中性摘要候选；
// 不识别社会事件、不改 affect、不改工具 gate。

import type { AgentAffectState, SocialEventReading } from "../emotion/agentAffectTypes";
import type { MemoryEntry } from "./memoryTypes";

/** 固定主体：VOID 与用户（禁止混入用户现实人际关系） */
export const AGENT_RELATIONSHIP_SUBJECT_NAME = "VOID 与用户";

/** 固定来源标记：来自关系情感链路，而非普通用户事实分类 */
export const AGENT_RELATIONSHIP_SOURCE = "agentAffect";

/** 同类显著事件合并窗：6 小时（04 §7.2） */
export const AGENT_RELATIONSHIP_MERGE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** 显式关系话题单次最多召回条数 */
export const AGENT_RELATIONSHIP_RECALL_LIMIT = 2;

/**
 * 显著关系事件类别（与 SocialEventKind 解耦，只保留可归档白名单）。
 * - high_offense：高强度冒犯
 * - formal_apology：正式道歉
 * - clear_repair：明显关系修复
 */
export type AgentRelationshipEventCategory =
  | "high_offense"
  | "formal_apology"
  | "clear_repair";

/** 写入候选：字段固定，内容为中性摘要，绝不带原话或内部分数 */
export type AgentRelationshipMemoryCandidate = {
  memoryType: "agentRelationship";
  subjectType: "other";
  subjectName: typeof AGENT_RELATIONSHIP_SUBJECT_NAME;
  content: string;
  sensitivity: "normal";
  source: typeof AGENT_RELATIONSHIP_SOURCE;
  confidence: number;
  category: AgentRelationshipEventCategory;
  mergeWindowMs: typeof AGENT_RELATIONSHIP_MERGE_WINDOW_MS;
};

/**
 * 高强度冒犯门槛：明确、可信的严重 insult / mock / dismiss。
 * 普通 tease、单次无礼、order_only 不进长期记忆。
 */
const HIGH_OFFENSE_MIN_INTENSITY = 0.55;
const HIGH_OFFENSE_MIN_CONFIDENCE = 0.55;

/**
 * 正式道歉门槛：明确 apology，且置信度够高。
 * 轻描淡写的「抱歉啊」不写。
 */
const FORMAL_APOLOGY_MIN_INTENSITY = 0.4;
const FORMAL_APOLOGY_MIN_CONFIDENCE = 0.5;

/**
 * 明显修复门槛：soft_repair 且此前确有需要修复的积怨。
 * previousAffect 取事件施加前的状态，避免「先消气再判」漏掉修复。
 */
const CLEAR_REPAIR_MIN_INTENSITY = 0.4;
const CLEAR_REPAIR_MIN_CONFIDENCE = 0.5;
const CLEAR_REPAIR_MIN_PREVIOUS_GRIEVANCE = 0.25;

/** 三类事件的稳定中性摘要：不存辱骂原话、不存分数、不存健康/亲属信息 */
const CATEGORY_SUMMARY: Record<AgentRelationshipEventCategory, string> = {
  high_offense: "用户曾对 VOID 进行高强度冒犯",
  formal_apology: "用户就此前态度正式道歉",
  clear_repair: "用户与 VOID 出现明显关系修复"
};

/**
 * 从本轮社会事件 + 事件前关系状态，派生是否值得写入 agentRelationship。
 * 返回 null 表示本轮不归档。
 *
 * @param reading 本轮社会事件；null 时不写
 * @param previousAffect 事件施加前的关系状态（用于判断「是否确有积怨需修复」）
 */
export function deriveAgentRelationshipMemoryCandidate(
  reading: SocialEventReading | null,
  previousAffect: AgentAffectState
): AgentRelationshipMemoryCandidate | null {
  if (!reading) {
    return null;
  }

  const category = classifySignificantRelationshipEvent(reading, previousAffect);
  if (!category) {
    return null;
  }

  return {
    memoryType: "agentRelationship",
    subjectType: "other",
    subjectName: AGENT_RELATIONSHIP_SUBJECT_NAME,
    content: CATEGORY_SUMMARY[category],
    sensitivity: "normal",
    source: AGENT_RELATIONSHIP_SOURCE,
    confidence: Math.min(1, Math.max(0.55, reading.confidence)),
    category,
    mergeWindowMs: AGENT_RELATIONSHIP_MERGE_WINDOW_MS
  };
}

/**
 * 白名单分类：只放行三类显著事件；其余 kind 一律不归档。
 */
export function classifySignificantRelationshipEvent(
  reading: SocialEventReading,
  previousAffect: AgentAffectState
): AgentRelationshipEventCategory | null {
  const { kind, intensity, confidence } = reading;

  if (
    (kind === "insult" || kind === "mock" || kind === "dismiss")
    && intensity >= HIGH_OFFENSE_MIN_INTENSITY
    && confidence >= HIGH_OFFENSE_MIN_CONFIDENCE
  ) {
    return "high_offense";
  }

  if (
    kind === "apology"
    && intensity >= FORMAL_APOLOGY_MIN_INTENSITY
    && confidence >= FORMAL_APOLOGY_MIN_CONFIDENCE
  ) {
    return "formal_apology";
  }

  if (
    kind === "soft_repair"
    && intensity >= CLEAR_REPAIR_MIN_INTENSITY
    && confidence >= CLEAR_REPAIR_MIN_CONFIDENCE
    && previousAffect.grievance >= CLEAR_REPAIR_MIN_PREVIOUS_GRIEVANCE
  ) {
    return "clear_repair";
  }

  return null;
}

/**
 * 用户是否在明确谈论「与 VOID 的关系」。
 * 只认指向 VOID 自身的关系话题；用户现实人际关系（朋友/家人）不算。
 */
export function isExplicitVoidRelationshipTopic(query: string): boolean {
  const text = query.trim();
  if (!text) {
    return false;
  }

  // 直接命中：明确对 VOID 的关系问句 / 道歉 / 和好
  const directPatterns: readonly RegExp[] = [
    /你还(在)?生气/,
    /你还在不高兴/,
    /你是不是(还)?(在)?生气/,
    /你(?:是不是|是否)?还?(?:在)?生我(的)?气/,
    /你是不是不高兴/,
    /你还怪我/,
    /你讨厌我/,
    /我们和好/,
    /跟你和好/,
    /向你道歉/,
    /跟你道歉/,
    /对你道歉/,
    /刚才我骂(你了)?/,
    /我骂你了/,
    /我刚才对你/,
    /你生我气/,
    /别生我的气/,
    /原谅我/,
    /你还记仇/,
    /你还记得我(刚才|之前)?(骂|怼|吼)/,
    /我们之间的关系/,
    /你和我的关系/,
    /我和你的关系/,
    /VOID.{0,6}(关系|和好|道歉|生气)/i,
    /(关系|和好|道歉|生气).{0,6}VOID/i
  ];

  if (directPatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  // 弱信号：同时出现「你」指向 + 关系动词，且不是明显谈第三方人际
  const hasYou = text.includes("你");
  const hasRelationCue = /(生气|生我气|生我的气|不高兴|怪我|讨厌我|记仇|和好|道歉|原谅|关系|冒犯|顶嘴)/.test(text);
  const talksAboutOthers = /(朋友|同事|家人|母亲|父亲|妈妈|爸爸|对象|男友|女友)/.test(text);
  return hasYou && hasRelationCue && !talksAboutOthers;
}

/**
 * 从已有条目里筛出 agentRelationship 分区，按相关度截断。
 * 调用方负责传入 listMemories() 结果，保持本函数纯。
 */
export function selectAgentRelationshipEntries(
  entries: MemoryEntry[],
  options: { maxEntries?: number; now?: number } = {}
): MemoryEntry[] {
  const maxEntries = options.maxEntries ?? AGENT_RELATIONSHIP_RECALL_LIMIT;
  const now = options.now ?? Date.now();

  return entries
    .filter((entry) => entry.memoryType === "agentRelationship")
    .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now)
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, maxEntries);
}
