// 健康可视化统计 —— 为记忆面板提供聚合数据，无 UI 依赖
import type { HealthTimelineGroup } from "./healthTimeline";

export type HealthStats = {
  totalGroups: number;
  totalEntries: number;
  perSubject: { name: string; count: number }[];
  perMonth: { month: string; count: number }[];
  sensitivityDist: { label: string; count: number }[];
};

export function computeHealthStats(groups: HealthTimelineGroup[]): HealthStats {
  const totalGroups = groups.length;
  let totalEntries = 0;
  const perSubject: { name: string; count: number }[] = [];
  const monthMap = new Map<string, number>();
  const sensMap = new Map<string, number>();

  for (const g of groups) {
    perSubject.push({ name: g.subjectName, count: g.entries.length });
    totalEntries += g.entries.length;
    for (const e of g.entries) {
      const d = new Date(e.createdAt);
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthMap.set(month, (monthMap.get(month) ?? 0) + 1);
      const label = e.sensitivity === "sensitive" ? "敏感" : e.sensitivity === "highSensitive" ? "高敏感" : "普通";
      sensMap.set(label, (sensMap.get(label) ?? 0) + 1);
    }
  }
  perSubject.sort((a, b) => b.count - a.count);
  const perMonth = Array.from(monthMap.entries())
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6); // 最近6月
  const sensitivityDist = Array.from(sensMap.entries()).map(([label, count]) => ({ label, count }));
  return { totalGroups, totalEntries, perSubject, perMonth, sensitivityDist };
}
