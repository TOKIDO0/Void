/**
 * C 模型用量区（设置 → 高级）：今日/近7日 tokens 与每日上限设置。
 * 上限为 0 表示不限；超限后模型请求直接 429（本次不转发）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchModelUsage,
  setDailyTokenCap,
  type ModelUsageOverview
} from "./modelUsageBridgeClient";
import type { SettingsLanguage } from "../../settings/settingsI18n";

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${value}`;
}

export function ModelUsageSection({ language }: { language: SettingsLanguage }) {
  const [overview, setOverview] = useState<ModelUsageOverview | null>(null);
  const [error, setError] = useState("");
  const [capDraft, setCapDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchModelUsage();
      setOverview(data);
      setCapDraft(String(data.dailyTokenCap));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "用量读取失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    const value = Number(capDraft);
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    setSaving(true);
    try {
      await setDailyTokenCap(Math.floor(value));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "上限保存失败");
    } finally {
      setSaving(false);
    }
  }, [capDraft, load]);

  const zh = language === "zh-CN";
  return (
    <div>
      <span>
        <strong>{zh ? "今日用量" : "Today's usage"}</strong>
        <p>
          {zh
            ? "今天花了多少、调了几次，一眼看到。下面填每天最多花多少，0 就是不管，超了直接停掉不再花钱。"
            : "What you spent today and how many calls. Set a daily cap below; 0 means no cap, and over-budget requests are stopped."}
        </p>
      </span>
      {error ? <p className="model-settings-modal__hint model-settings-modal__hint--error">{error}</p> : null}
      {overview ? (
        <p className="model-settings-modal__hint">
          {zh
            ? `今日 ${formatTokens(overview.today.totalTokens)} tokens / ${overview.today.calls} 次`
            : `Today ${formatTokens(overview.today.totalTokens)} tokens / ${overview.today.calls} calls`}
        </p>
      ) : null}
      <div className="model-settings-modal__confirm-actions">
        <input
          type="number"
          min={0}
          step={10000}
          value={capDraft}
          aria-label={zh ? "每日上限" : "Daily cap"}
          placeholder={zh ? "每日上限（0=不限）" : "Daily cap (0=unlimited)"}
          onChange={(event) => setCapDraft(event.target.value)}
        />
        <button type="button" className="is-primary" disabled={saving} onClick={() => void handleSave()}>
          {zh ? "保存上限" : "Save cap"}
        </button>
      </div>
    </div>
  );
}
