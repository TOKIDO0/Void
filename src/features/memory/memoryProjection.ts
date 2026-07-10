// VOID 记忆系统 —— 投影为模型可读上下文
// 职责单一：把召回结果投影成一段简短、结构清晰的字符串，供收尾阶段注入 System Prompt。
// 纯函数，无副作用、不读库、不接线（21 号 §0.3 铁律 2 / B3）。接线留给两窗口都完成后串行做。

import type { MemoryEntry } from "./memoryTypes";
import { MEMORY_TYPE_LABELS } from "./memoryTypes";
import type { RetrieveResult } from "./memoryRetriever";

export type ProjectOptions = {
  /** 段落标题，默认「已知的用户长期记忆」 */
  heading?: string;
  /** 单条内容最大字符数，超出截断，默认 80 */
  maxContentLength?: number;
};

const DEFAULT_HEADING = "已知的用户长期记忆";
const DEFAULT_MAX_CONTENT_LENGTH = 80;

/**
 * 把召回结果投影成可注入字符串。
 * 无召回条目时返回空字符串（调用方据此决定是否注入，避免塞空段落）。
 * 输出示例：
 *   已知的用户长期记忆：
 *   - [健康档案·亲属·母亲] 血压偏高，需定期监测
 *   - [用户画像·用户本人] 喜欢被叫「小陈」
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

  const lines = entries.map((entry) => formatEntryLine(entry, maxContentLength));
  return `${heading}：\n${lines.join("\n")}`;
}

/** 单条投影：[分区·主体名] 内容（超长截断）。 */
function formatEntryLine(entry: MemoryEntry, maxContentLength: number): string {
  const typeLabel = MEMORY_TYPE_LABELS[entry.memoryType];
  const subject = entry.subjectName.trim() || "用户本人";
  const content = truncate(entry.content.trim(), maxContentLength);
  return `- [${typeLabel}·${subject}] ${content}`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}…`;
}
