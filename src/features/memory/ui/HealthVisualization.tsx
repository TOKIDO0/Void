// 健康可视化 —— 纯 SVG 柱状+饼图，无额外依赖，适配深色玻璃面板
import { useMemo } from "react";
import type { HealthTimelineGroup } from "../healthTimeline";
import { computeHealthStats } from "../healthStats";

const BAR_PALETTE = ["#3B82F6", "#0EA5E9", "#6366F1", "#22D3EE", "#818CF8", "#38BDF8"];
const PIE_PALETTE: Record<string, string> = { "敏感": "#F59E0B", "普通": "#10B981", "高敏感": "#EF4444" };

function BarChart({ data }: { data: { name: string; count: number }[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  const W = 280, H = 120, padL = 36, padB = 22, padT = 8, padR = 8;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const barW = Math.max(14, Math.min(36, (chartW / data.length) * 0.6));
  const gap = data.length > 1 ? (chartW - barW * data.length) / (data.length - 1) : 0;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="120" role="img" aria-label="按人物统计">
      {/* 网格 */}
      {[0, 1, 2, 3].map((i) => {
        const y = padT + (chartH * i) / 3;
        return <line key={i} x1={padL} x2={W - padR} y1={y} y2={y} stroke="#334155" strokeOpacity={0.35} strokeWidth={0.7} />;
      })}
      {data.map((d, i) => {
        const h = (d.count / max) * chartH;
        const x = padL + i * (barW + gap);
        const y = padT + chartH - h;
        return (
          <g key={d.name}>
            <rect x={x} y={y} width={barW} height={h} rx={3} fill={BAR_PALETTE[i % BAR_PALETTE.length]} />
            <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize={9} fill="#94A3B8">{d.name.slice(0, 6)}</text>
            <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="#E2E8F0" fontWeight={600}>{d.count}</text>
          </g>
        );
      })}
      <text x={padL} y={padT - 1} fontSize={9} fill="#64748B">人物 · 条数</text>
    </svg>
  );
}

function PieChart({ data }: { data: { label: string; count: number }[] }) {
  if (data.length === 0) return null;
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  const cx = 56, cy = 56, r = 44;
  let angle = -90;
  const arcs = data.map((d) => {
    const deg = (d.count / total) * 360;
    const start = angle;
    const end = angle + deg;
    angle = end;
    return { ...d, start, end, deg };
  });
  const polar = (deg: number, rad: number) => {
    const radn = (deg * Math.PI) / 180;
    return [cx + Math.cos(radn) * rad, cy + Math.sin(radn) * rad];
  };
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="敏感度分布">
      {arcs.map((a) => {
        const [x1, y1] = polar(a.start, r);
        const [x2, y2] = polar(a.end, r);
        const large = a.deg > 180 ? 1 : 0;
        const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        return <path key={a.label} d={d} fill={PIE_PALETTE[a.label] ?? "#64748B"} stroke="#0F172A" strokeWidth={1.2} />;
      })}
      <circle cx={cx} cy={cy} r={16} fill="#0F172A" />
      <text x={cx} y={cy + 3} textAnchor="middle" fontSize={9} fill="#E2E8F0" fontWeight={700}>{total}</text>
    </svg>
  );
}

export function HealthVisualization({ groups }: { groups: HealthTimelineGroup[] }) {
  const stats = useMemo(() => computeHealthStats(groups), [groups]);
  if (stats.totalEntries === 0) return null;
  const monthly = stats.perMonth;
  return (
    <div className="memory-manager__health-viz" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
      <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 12, padding: "10px 10px 6px" }}>
        <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
          <span>按人物</span><span style={{ color: "#64748B" }}>{stats.totalGroups}人 · {stats.totalEntries}条</span>
        </div>
        <BarChart data={stats.perSubject.slice(0, 6)} />
        {monthly.length > 0 ? (
          <div style={{ fontSize: 10, color: "#64748B", marginTop: 4, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {monthly.map((m) => <span key={m.month}>{m.month}×{m.count}</span>)}
          </div>
        ) : null}
      </div>
      <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 12, padding: "10px 10px 6px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ fontSize: 11, color: "#94A3B8", alignSelf: "stretch", marginBottom: 6 }}>敏感度分布</div>
        <PieChart data={stats.sensitivityDist} />
        <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 10, color: "#94A3B8" }}>
          {stats.sensitivityDist.map((d) => (
            <span key={d.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: PIE_PALETTE[d.label] ?? "#64748B", display: "inline-block" }} />
              {d.label} {d.count}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
