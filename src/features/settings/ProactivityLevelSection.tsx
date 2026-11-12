/**
 * PRO-02 主动程度设置区（设置 → 高级）。
 *
 * 三档是「代理主动预算的上限」：只决定主动巡检能否生成、频率与日上限。
 * 不放宽安静时段，也不接管具体投递通道（PRO-01）。展示与保存全部以 owner 返回为准。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProactivityLevelStatus,
  saveProactivityLevel,
  type ProactivityLevel,
  type ProactivityLevelStatus
} from "../proactivity/proactivityLevelClient";
import type { SettingsLanguage } from "./settingsI18n";

type LevelOption = {
  id: ProactivityLevel;
  zh: string;
  en: string;
};

const LEVEL_OPTIONS: readonly LevelOption[] = [
  { id: "restrained", zh: "克制", en: "Restrained" },
  { id: "balanced", zh: "平衡", en: "Balanced" },
  { id: "attentive", zh: "积极", en: "Attentive" }
];

function describeLevel(status: ProactivityLevelStatus, zh: boolean): string {
  if (!status.budget) {
    return zh
      ? "代理主动暂停；用户提醒与日程提醒照常。"
      : "Agent-initiated checks paused; user and calendar reminders still fire.";
  }
  const minutes = Math.round(status.budget.heartbeatIntervalMs / 60_000);
  return zh
    ? `每 ${minutes} 分钟巡检，每天最多 ${status.budget.heartbeatDailyCap} 轮。`
    : `Checks every ${minutes} min, up to ${status.budget.heartbeatDailyCap} per day.`;
}

export function ProactivityLevelSection({ language }: { language: SettingsLanguage }) {
  const zh = language === "zh-CN";
  const [status, setStatus] = useState<ProactivityLevelStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 防止快速切换时旧响应覆盖新档位。 */
  const saveSequenceRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchProactivityLevelStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? "主动程度读取失败" : "Failed to load proactivity level");
    } finally {
      setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async (level: ProactivityLevel) => {
    if (status?.level === level && status.configStatus === "ok") {
      return;
    }
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    setSaving(true);
    setError("");
    try {
      const next = await saveProactivityLevel(level);
      if (sequence === saveSequenceRef.current) {
        setStatus(next);
      }
    } catch (err) {
      if (sequence === saveSequenceRef.current) {
        setError(err instanceof Error ? err.message : zh ? "主动程度保存失败" : "Failed to save proactivity level");
      }
    } finally {
      if (sequence === saveSequenceRef.current) {
        setSaving(false);
      }
    }
  }, [status?.configStatus, status?.level, zh]);

  const warning = status?.configStatus === "corrupt"
    ? zh
      ? "配置损坏，已按平衡档运行；重新选择后覆盖。"
      : "Config corrupted; running Balanced. Pick a level to replace it."
    : "";

  return (
    <>
      <div>
        <span>
          <strong>{zh ? "主动程度" : "Proactivity"}</strong>
          <p title={zh
            ? "等级是代理主动的上限：克制会暂停静默巡检；平衡与积极只调整巡检频率与每日上限。不影响你自己设置的提醒，也不突破安静时段。"
            : "The level caps agent-initiated checks: Restrained pauses them; Balanced and Attentive only change cadence and the daily ceiling. Your own reminders are unaffected, and quiet hours still apply."}>
            {zh ? "代理主动的上限；不影响你自己的提醒。" : "Caps agent-initiated checks; your own reminders are unaffected."}
            <span aria-hidden="true" style={{ marginLeft: 4, cursor: "help", opacity: 0.6, fontSize: 12 }}>ⓘ</span>
          </p>
        </span>
      </div>

      <div className="model-settings-modal__confirm-actions">
        {LEVEL_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={status?.level === option.id ? "is-primary" : undefined}
            aria-pressed={status?.level === option.id}
            disabled={saving || loading || status === null}
            onClick={() => void handleSave(option.id)}
          >
            {zh ? option.zh : option.en}
          </button>
        ))}
      </div>

      {status ? <p className="model-settings-modal__hint">{describeLevel(status, zh)}</p> : null}
      {warning ? <p className="model-settings-modal__hint">{warning}</p> : null}
      {error ? <p className="model-settings-modal__hint model-settings-modal__hint--error">{error}</p> : null}
    </>
  );
}
