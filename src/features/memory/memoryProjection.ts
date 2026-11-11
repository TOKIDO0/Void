// VOID 记忆系统 —— 投影为模型可读上下文
// 职责单一：把召回结果投影成一段简短、结构清晰的字符串，供收尾阶段注入 System Prompt。
// 纯函数，无副作用、不读库、不接线（21 号 §0.3 铁律 2 / B3）。接线留给两窗口都完成后串行做。
//
// CORE-03：投影必须带时效线索。记忆写入时是事实，召回时不一定还是事实；
// 把过期内容当现状陈述，是"私人顾问"最致命的错误。

import type { MemoryEntry, MemoryType } from "./memoryTypes";
import { MEMORY_TYPE_LABELS } from "./memoryTypes";
import type { RetrieveResult } from "./memoryRetriever";

export type ProjectOptions = {
  /** 段落标题，默认「已知的用户长期记忆」 */
  heading?: string;
  /** 单条内容最大字符数，超出截断，默认 80 */
  maxContentLength?: number;
  /** 是否显示时效标记；默认显示。关闭仅用于调试对照。 */
  showStaleness?: boolean;
  /** 判定基准时间，默认 Date.now()；测试可注入。 */
  now?: number;
};

const DEFAULT_HEADING = "已知的用户长期记忆";
const DEFAULT_MAX_CONTENT_LENGTH = 80;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 会随现实变化而失效的分区及阈值。
 * 不在这里的类型（task / knowledgeCache / emotionTrend / longTermGoal）要么天生短期，
 * 要么不涉及"当前是否仍然成立"，标过期只会让模型频繁追问。
 */
const STALENESS_THRESHOLDS: Partial<Record<MemoryType, number>> = {
  userProfile: 90,
  agentRelationship: 90,
  healthRecord: 90,
  relationship: 90,
  preference: 180
};

/** 记忆使用纪律：只在存在过期标记时注入，避免每次都念一遍。 */
const STALENESS_DISCIPLINE =
  "【记忆使用纪律】带 ⚠ 的条目可能已过期。凡涉及「现在是否仍然成立」（职业、住址、关系、健康状况、文件或代码是否存在），"
  + "必须当轮先用工具核实或自然地向用户确认一次，不得直接当作现状陈述。";

/**
 * 把召回结果投影成可注入字符串。
 * 无召回条目时返回空字符串（调用方据此决定是否注入，避免塞空段落）。
 * 输出示例：
 *   已知的用户长期记忆：
 *   - [健康档案·亲属·母亲] 血压偏高，需定期监测（记录于 4 个月前 ⚠可能过期）
 *   - [用户画像·用户本人] 喜欢被叫「小陈」（记录于 5 天前）
 */
export function projectMemories(result: RetrieveResult, options: ProjectOptions = {}): string {
  return projectEntries(result.entries, options);
}

/** 直接投影一组条目（供 UI 预览或收尾接线复用）。 */
export function projectEntries(entries: MemoryEntry[], options: ProjectOptions = {}): string {
  if (entries.length === 0) {
    return "";
  }

  const heading = options.heading ?? DEFAULT_HEADING;
  const maxContentLength = options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const showStaleness = options.showStaleness !== false;
  const now = options.now ?? Date.now();

  let staleCount = 0;
  const lines = entries.map((entry) => {
    const line = formatEntryLine(entry, maxContentLength, showStaleness, now);
    if (line.stale) {
      staleCount += 1;
    }
    return line.text;
  });

  const body = `${heading}：\n${lines.join("\n")}`;
  if (!showStaleness || staleCount === 0) {
    return body;
  }
  return `${body}\n\n${STALENESS_DISCIPLINE}`;
}

/** 单条投影：[分区·主体名] 内容（超长截断）+ 时效线索。 */
function formatEntryLine(
  entry: MemoryEntry,
  maxContentLength: number,
  showStaleness: boolean,
  now: number
): { text: string; stale: boolean } {
  const typeLabel = MEMORY_TYPE_LABELS[entry.memoryType];
  const subject = entry.subjectName.trim() || "用户本人";
  const content = truncate(entry.content.trim(), maxContentLength);
  const base = `- [${typeLabel}·${subject}] ${content}`;

  if (!showStaleness) {
    return { text: base, stale: false };
  }

  const recordedAt = entry.updatedAt || entry.createdAt;
  const ageText = describeAge(now - recordedAt);
  const thresholdDays = STALENESS_THRESHOLDS[entry.memoryType];
  const stale = typeof thresholdDays === "number"
    && now - recordedAt > thresholdDays * DAY_MS;

  const suffix = stale
    ? `（记录于${ageText} ⚠可能过期）`
    : `（记录于${ageText}）`;
  return { text: `${base}${suffix}`, stale };
}

/** 粗粒度年龄描述：只给模型一个量级，不做精确到日的噪音。 */
function describeAge(ageMs: number): string {
  const days = Math.max(0, Math.floor(ageMs / DAY_MS));
  if (days <= 0) {
    return "今天";
  }
  if (days === 1) {
    return "1 天前";
  }
  if (days < 30) {
    return `${days} 天前`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} 个月前`;
  }
  return `${Math.floor(months / 12)} 年前`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
