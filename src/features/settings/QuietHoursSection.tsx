/**
 * PRO-04 安静时段设置区（设置 → 高级）。
 * 只展示 owner 返回的状态并提交配置；不在前端判断“现在是否安静”。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProactivityStatus,
  saveQuietHours,
  type ProactivityStatus
} from "../proactivity/proactivityBridgeClient";
import type { SettingsLanguage } from "./settingsI18n";

function minutesToTimeValue(minutes: number): string {
  const hour = Math.floor(minutes / 60).toString().padStart(2, "0");
  const minute = (minutes % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

function timeValueToMinutes(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function formatClock(ms: number, zh: boolean): string {
  return new Date(ms).toLocaleTimeString(zh ? "zh-CN" : "en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function QuietHoursSection({ language }: { language: SettingsLanguage }) {
  const zh = language === "zh-CN";
  const [status, setStatus] = useState<ProactivityStatus | null>(null);
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [startDraft, setStartDraft] = useState("23:00");
  const [endDraft, setEndDraft] = useState("08:00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  /** 防止“时间 onBlur”与“开关 onChange”并发时，旧响应覆盖新状态。 */
  const saveSequenceRef = useRef(0);

  const applyStatus = useCallback((next: ProactivityStatus) => {
    setStatus(next);
    setEnabledDraft(next.config.enabled);
    setStartDraft(minutesToTimeValue(next.config.startMinutes));
    setEndDraft(minutesToTimeValue(next.config.endMinutes));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      applyStatus(await fetchProactivityStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? "安静时段读取失败" : "Failed to load quiet hours");
    } finally {
      setLoading(false);
    }
  }, [applyStatus, zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (nextEnabled: boolean, nextStart: string, nextEnd: string): Promise<boolean> => {
      const startMinutes = timeValueToMinutes(nextStart);
      const endMinutes = timeValueToMinutes(nextEnd);
      if (startMinutes === null || endMinutes === null) {
        setError(zh ? "时间格式无效，请使用 HH:mm" : "Invalid time; use HH:mm");
        return false;
      }
      if (startMinutes === endMinutes) {
        setError(zh ? "开始时间与结束时间不能相同" : "Start and end cannot be the same");
        return false;
      }
      // 正常配置且值没变时不重复写盘；缺失/损坏时允许用同值保存来覆盖坏文件。
      if (
        status?.configStatus === "ok"
        && status.config.enabled === nextEnabled
        && status.config.startMinutes === startMinutes
        && status.config.endMinutes === endMinutes
      ) {
        setError("");
        return true;
      }
      const sequence = saveSequenceRef.current + 1;
      saveSequenceRef.current = sequence;
      setSaving(true);
      try {
        const next = await saveQuietHours({ enabled: nextEnabled, startMinutes, endMinutes });
        if (sequence === saveSequenceRef.current) {
          applyStatus(next);
          setError("");
        }
        return true;
      } catch (err) {
        if (sequence === saveSequenceRef.current) {
          setError(err instanceof Error ? err.message : zh ? "安静时段保存失败" : "Failed to save quiet hours");
        }
        return false;
      } finally {
        if (sequence === saveSequenceRef.current) {
          setSaving(false);
        }
      }
    },
    [applyStatus, status, zh]
  );

  const statusText = (() => {
    if (!status) {
      return loading ? (zh ? "读取中…" : "Loading…") : "";
    }
    if (!status.config.enabled) {
      return zh ? "已关闭，任何时段都可能主动打扰。" : "Off; proactive contact may happen at any time.";
    }
    if (status.quiet && status.windowEndsAt) {
      return zh
        ? `生效中，至 ${formatClock(status.windowEndsAt, true)}`
        : `Active until ${formatClock(status.windowEndsAt, false)}`;
    }
    if (status.nextChangeAt) {
      return zh
        ? `当前不在安静时段；下次 ${formatClock(status.nextChangeAt, true)}`
        : `Not active; next ${formatClock(status.nextChangeAt, false)}`;
    }
    return zh ? "当前不在安静时段" : "Not active";
  })();

  const configWarning = status?.configStatus === "corrupt"
    ? zh
      ? "配置损坏，已隔离并按默认 23:00–08:00 运行；保存后覆盖。"
      : "Config corrupted; isolated and running with default 23:00–08:00. Save to replace."
    : status?.configStatus === "missing"
      ? zh
        ? "当前使用默认 23:00–08:00；修改后保存到本机。"
        : "Using default 23:00–08:00; changes are saved locally."
      : "";

  const detail = zh
    ? "安静时段内，代理主动发起的系统通知与语音播报会延后到结束；托盘只更新未读数。你主动发起的对话回复不受影响。"
    : "During quiet hours, agent-initiated notifications and speech are deferred until the window ends. Tray unread counts still update. Your own conversations are unaffected.";

  return (
    <>
      <label className="model-settings-modal__advanced-toggle">
        <span>
          <strong>{zh ? "安静时段" : "Quiet hours"}</strong>
          <p title={detail}>
            {zh ? "代理主动通知与语音延后；你的对话不受影响。" : "Agent notifications and speech are deferred; your conversations are not."}
            <span aria-hidden="true" style={{ marginLeft: 4, cursor: "help", opacity: 0.6, fontSize: 12 }}>ⓘ</span>
          </p>
        </span>
        <span className="model-settings-modal__switch">
          <input
            type="checkbox"
            checked={enabledDraft}
            disabled={saving || loading || status === null}
            onChange={(event) => {
              const next = event.target.checked;
              setEnabledDraft(next);
              void save(next, startDraft, endDraft).then((ok) => {
                if (!ok) {
                  setEnabledDraft(!next);
                }
              });
            }}
          />
          <span className="model-settings-modal__switch-slider" />
        </span>
      </label>

      <div className="model-settings-modal__grid">
        <label className="model-settings-modal__field">
          <span>{zh ? "开始" : "Start"}</span>
          <input
            type="time"
            value={startDraft}
            disabled={saving || loading || status === null || !enabledDraft}
            onChange={(event) => setStartDraft(event.target.value)}
            onBlur={(event) => void save(enabledDraft, event.target.value, endDraft)}
          />
        </label>
        <label className="model-settings-modal__field">
          <span>{zh ? "结束" : "End"}</span>
          <input
            type="time"
            value={endDraft}
            disabled={saving || loading || status === null || !enabledDraft}
            onChange={(event) => setEndDraft(event.target.value)}
            onBlur={(event) => void save(enabledDraft, startDraft, event.target.value)}
          />
        </label>
      </div>

      {statusText ? <p className="model-settings-modal__hint">{statusText}</p> : null}
      {configWarning ? <p className="model-settings-modal__hint">{configWarning}</p> : null}
      {error ? <p className="model-settings-modal__hint model-settings-modal__hint--error">{error}</p> : null}
    </>
  );
}
