// 健康时间线投影 —— 按人物分组时序展示 healthRecord
// 依据 05 号文档 §2-3：动态建档、人物区分；T2 要求时序可追溯

import type { MemoryEntry } from "./memoryTypes";
import { listMemories } from "./memoryStore";

export type HealthTimelineGroup = {
  subjectName: string;
  subjectType: string;
  entries: MemoryEntry[];
};

export function buildHealthTimeline(): HealthTimelineGroup[] {
  const all = listMemories().filter((e) => e.memoryType === "healthRecord");
  const map = new Map<string, HealthTimelineGroup>();
  for (const entry of all) {
    const key = `${entry.subjectType}:${entry.subjectName}`;
    const group = map.get(key);
    if (group) group.entries.push(entry);
    else map.set(key, { subjectName: entry.subjectName, subjectType: entry.subjectType, entries: [entry] });
  }
  const groups = Array.from(map.values());
  for (const g of groups) g.entries.sort((a, b) => a.createdAt - b.createdAt);
  groups.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  return groups;
}

export function formatHealthMonth(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function filterHealthTimelineByMonth(groups: HealthTimelineGroup[], month: string | null): HealthTimelineGroup[] {
  if (!month) return groups;
  const filtered: HealthTimelineGroup[] = [];
  for (const g of groups) {
    const entries = g.entries.filter((e) => formatHealthMonth(e.createdAt) === month);
    if (entries.length > 0) filtered.push({ ...g, entries });
  }
  return filtered;
}

export function formatHealthTimelineDate(timestamp: number, lang: "zh-CN" | "en-US" = "zh-CN"): string {
  const d = new Date(timestamp);
  if (lang === "en-US") return d.toLocaleDateString("en-US");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function renderHealthTimelineMarkdown(groups: HealthTimelineGroup[] = buildHealthTimeline()): string {
  if (groups.length === 0) return "# 健康档案\n\n暂无健康记录\n";
  const lines: string[] = ["# 健康档案", "", `共 ${groups.length} 人，${groups.reduce((s, g) => s + g.entries.length, 0)} 条记录`, ""];
  for (const group of groups) {
    lines.push(`## ${group.subjectName}（${group.subjectType}）`, "");
    for (const entry of group.entries) {
      const date = formatHealthTimelineDate(entry.createdAt);
      lines.push(`- ${date}：${entry.content}`);
    }
    lines.push("");
  }
  lines.push("---", "本档案仅作记录与整理，不作诊断；如有不适请咨询专业医生。");
  return lines.join("\n");
}
