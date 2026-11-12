/**
 * BEH-01 行为观察区（设置 → 高级）：开关 + 今日活跃摘要 + 最近采样时间。
 * 只展示 owner 返回的事实，不做活跃判定、不做聚合、不缓存结论。
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchBehaviorStatus,
  setBehaviorEnabled,
  type BehaviorStatusView
} from "../behavior/behaviorBridgeClient";
import type { SettingsLanguage } from "./settingsI18n";

function formatClock(ms: number, zh: boolean): string {
  if (!ms) {
    return "—";
  }
  return new Date(ms).toLocaleTimeString(zh ? "zh-CN" : "en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function BehaviorSection({ language }: { language: SettingsLanguage }) {
  const zh = language === "zh-CN";
  const [status, setStatus] = useState<BehaviorStatusView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchBehaviorStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? "行为观察读取失败" : "Failed to read behavior status");
    }
  }, [zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      try {
        await setBehaviorEnabled(enabled);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : zh ? "开关保存失败" : "Failed to save toggle");
      } finally {
        setSaving(false);
      }
    },
    [load, zh]
  );

  const detail = zh
    ? "每分钟记录一次系统空闲时长，只在本机折算成每小时活跃分钟数；不记录应用名、窗口标题、键盘、屏幕或剪贴板。每日聚合保留 90 天，关闭后立即停止采样并丢弃未上送的原始样本。"
    : "Reads system idle time once per minute and aggregates it into per-hour active minutes on this device only. No app names, window titles, keystrokes, screen or clipboard are recorded. Daily aggregates are kept for 90 days; turning it off stops sampling immediately and drops unsent raw samples.";

  const today = status?.today ?? null;
  const summary = today
    ? zh
      ? `今日活跃 ${today.activeMinutes} 分钟 · 最近采样 ${formatClock(status?.lastSampleAt ?? 0, true)} · 保留 ${status?.retentionDays ?? 90} 天`
      : `Active today ${today.activeMinutes} min · Last sample ${formatClock(status?.lastSampleAt ?? 0, false)} · Kept for ${status?.retentionDays ?? 90} days`
    : zh
      ? "今日暂无活跃记录"
      : "No activity recorded today";

  return (
    <div>
      <label className="model-settings-modal__advanced-toggle">
        <span>
          <strong>{zh ? "行为观察" : "Behavior insight"}</strong>
          <p title={detail}>
            {zh ? "本机聚合活跃时段，不记录窗口内容。" : "Local active-time aggregates; no window content."}
            <span aria-hidden="true" style={{ marginLeft: 4, cursor: "help", opacity: 0.6, fontSize: 12 }}>ⓘ</span>
          </p>
        </span>
        <span className="model-settings-modal__switch">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={saving || status === null}
            onChange={(event) => void handleToggle(event.target.checked)}
          />
          <span className="model-settings-modal__switch-slider" />
        </span>
      </label>
      {error ? <p className="model-settings-modal__hint model-settings-modal__hint--error">{error}</p> : null}
      {status ? <p className="model-settings-modal__hint">{summary}</p> : null}
    </div>
  );
}
