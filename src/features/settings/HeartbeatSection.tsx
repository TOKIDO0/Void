/**
 * PRO-05 静默巡检设置区（设置 → 高级）。
 * 只展示 owner 返回的状态、提交开关与手动巡检；不在前端判断“该不该巡检/算不算问题”。
 * 手动巡检仍走去重与 PRO-06/PRO-04 投递闸门，不绕过安静时段。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchHeartbeatStatus,
  runHeartbeatNow,
  saveHeartbeatEnabled,
  type HeartbeatRoundResult,
  type HeartbeatStatus
} from "../heartbeat/heartbeatBridgeClient";
import type { SettingsLanguage } from "./settingsI18n";

function formatClock(ms: number, zh: boolean): string {
  return new Date(ms).toLocaleTimeString(zh ? "zh-CN" : "en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateTime(ms: number, zh: boolean): string {
  return new Date(ms).toLocaleString(zh ? "zh-CN" : "en-US", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** 巡检结果 → 一句可核对的话；不把“已入队”说成“已送达”。 */
function describeResult(result: HeartbeatRoundResult, zh: boolean): string {
  switch (result.outcome) {
    case "NO_ISSUES":
      return zh ? "无异常" : "No issues";
    case "NOTIFIED":
      return zh ? `已入队 ${result.notified} 项` : `${result.notified} queued`;
    case "SUPPRESSED_DUPLICATE":
      return zh ? `无新问题（已提醒 ${result.suppressed} 项）` : `Nothing new (${result.suppressed} already notified)`;
    case "SUPPRESSED_STATE_CORRUPT":
      return zh ? "状态重建，本轮未通知" : "State rebuilt; this round stayed silent";
    case "ENQUEUE_FAILED":
      return zh ? `入队失败（${result.errorCode ?? "UNKNOWN"}）` : `Enqueue failed (${result.errorCode ?? "UNKNOWN"})`;
    case "SKIPPED":
      switch (result.skippedReason) {
        case "DISABLED":
          return zh ? "已关闭" : "Off";
        case "NO_CHECKLIST":
          return zh ? "清单缺失" : "Checklist missing";
        case "INVALID_CHECKLIST":
          return zh ? "清单无效" : "Checklist invalid";
        case "DAILY_CAP":
          return zh ? "今日已达上限" : "Daily cap reached";
        case "LEVEL_RESTRAINED":
          return zh ? "被主动等级暂停" : "Paused by proactivity level";
        default:
          return zh ? "已跳过" : "Skipped";
      }
    default:
      return zh ? "未知结果" : "Unknown result";
  }
}

function describeInvalidReason(reason: string | undefined, zh: boolean): string {
  switch (reason) {
    case "TOO_LARGE":
      return zh ? "清单超过 8 KB，巡检不会运行。" : "Checklist exceeds 8 KB; checks stay off.";
    case "UNREADABLE":
      return zh ? "清单无法读取，巡检不会运行。" : "Checklist unreadable; checks stay off.";
    case "TOO_MANY_LINES":
      return zh ? "清单超过 100 行，巡检不会运行。" : "Checklist exceeds 100 lines; checks stay off.";
    case "TOO_MANY_CHECKS":
      return zh ? "清单超过 32 项，巡检不会运行。" : "Checklist exceeds 32 checks; checks stay off.";
    default:
      return zh ? "清单里没有可识别的检查，巡检不会运行。" : "No recognized checks; checks stay off.";
  }
}

export function HeartbeatSection({ language }: { language: SettingsLanguage }) {
  const zh = language === "zh-CN";
  const [status, setStatus] = useState<HeartbeatStatus | null>(null);
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** 防止快速连点开关时，旧响应覆盖新状态。 */
  const saveSequenceRef = useRef(0);

  const applyStatus = useCallback((next: HeartbeatStatus) => {
    setStatus(next);
    setEnabledDraft(next.enabled);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      applyStatus(await fetchHeartbeatStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? "静默巡检读取失败" : "Failed to load heartbeat status");
    } finally {
      setLoading(false);
    }
  }, [applyStatus, zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(async (next: boolean) => {
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    setEnabledDraft(next);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await saveHeartbeatEnabled(next);
      if (sequence === saveSequenceRef.current) {
        applyStatus(response.status);
        if (response.createdChecklist) {
          setNotice(zh ? "已生成清单模板，可直接编辑。" : "Checklist template created; edit it anytime.");
        }
      }
    } catch (err) {
      if (sequence === saveSequenceRef.current) {
        setEnabledDraft(!next);
        setError(err instanceof Error ? err.message : zh ? "静默巡检保存失败" : "Failed to save heartbeat setting");
      }
    } finally {
      if (sequence === saveSequenceRef.current) {
        setSaving(false);
      }
    }
  }, [applyStatus, zh]);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError("");
    setNotice("");
    try {
      const response = await runHeartbeatNow();
      applyStatus(response.status);
      setNotice(
        response.result.outcome === "NOTIFIED"
          ? zh
            ? "已加入投递队列；是否送达受安静时段与通知权限约束。"
            : "Queued; delivery still depends on quiet hours and notification permission."
          : describeResult(response.result, zh)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : zh ? "巡检执行失败" : "Failed to run a check");
    } finally {
      setRunning(false);
    }
  }, [applyStatus, zh]);

  const statusText = (() => {
    if (!status) {
      return loading ? (zh ? "读取中…" : "Loading…") : "";
    }
    if (!status.enabled) {
      return zh ? "已关闭，不会定时巡检。" : "Off; no scheduled checks.";
    }
    if (status.levelRestrained) {
      return zh
        ? "被「克制」主动等级暂停，不会定时巡检。"
        : "Paused by the Restrained proactivity level.";
    }
    if (status.checklist.status === "missing") {
      return zh ? "清单缺失，巡检不会运行。" : "Checklist missing; checks will not run.";
    }
    if (status.checklist.status === "invalid") {
      return describeInvalidReason(status.checklist.reason, zh);
    }
    if (!status.lastResult) {
      return zh ? "等待首次巡检。" : "Waiting for the first check.";
    }
    const parts = [
      `${zh ? "上次" : "Last"} ${formatDateTime(status.lastResult.at, zh)}`,
      describeResult(status.lastResult, zh)
    ];
    if (status.nextRunAt) {
      parts.push(`${zh ? "下次" : "Next"} ${formatClock(status.nextRunAt, zh)}`);
    }
    return parts.join(" · ");
  })();

  const unsupportedText = status && status.checklist.unsupported.length > 0
    ? zh
      ? `未识别 ${status.checklist.unsupported.length} 行：${status.checklist.unsupported.slice(0, 3).join("、")}`
      : `${status.checklist.unsupported.length} unrecognized line(s): ${status.checklist.unsupported.slice(0, 3).join(", ")}`
    : "";

  const warningText = status?.configStatus === "corrupt"
    ? zh
      ? "配置损坏，已按关闭处理；重新开启后覆盖。"
      : "Config corrupted; treated as off. Toggle again to replace it."
    : status?.stateStatus === "corrupt"
      ? zh
        ? "状态文件已隔离重建，本轮暂停通知。"
        : "State file was isolated and rebuilt; this round stayed silent."
      : "";

  const runDisabled = running || loading || saving || !enabledDraft
    || status?.checklist.status !== "ok"
    || status?.levelRestrained === true;

  return (
    <>
      <label className="model-settings-modal__advanced-toggle">
        <span>
          <strong>{zh ? "静默巡检" : "Silent check-in"}</strong>
          <p title={zh
            ? "每 60 分钟读一次本机清单与日程/任务事实，只把可行动的问题送进投递队列；无变化不打扰，仍受安静时段约束。"
            : "Every 60 minutes it reads the local checklist plus calendar and task facts, and queues only actionable issues. No change means no interruption, and quiet hours still apply."}>
            {zh ? "定时检查日程与后台任务；无变化不打扰。" : "Periodic checks of calendar and background tasks; silence when nothing changed."}
            <span aria-hidden="true" style={{ marginLeft: 4, cursor: "help", opacity: 0.6, fontSize: 12 }}>ⓘ</span>
          </p>
        </span>
        <span className="model-settings-modal__switch">
          <input
            type="checkbox"
            checked={enabledDraft}
            disabled={saving || loading || status === null}
            onChange={(event) => void handleToggle(event.target.checked)}
          />
          <span className="model-settings-modal__switch-slider" />
        </span>
      </label>

      {statusText ? <p className="model-settings-modal__hint">{statusText}</p> : null}
      {status ? (
        <p className="model-settings-modal__hint" title={status.checklist.path}>
          {zh ? "清单：" : "Checklist: "}
          {status.checklist.path}
        </p>
      ) : null}
      {unsupportedText ? <p className="model-settings-modal__hint">{unsupportedText}</p> : null}
      {warningText ? <p className="model-settings-modal__hint">{warningText}</p> : null}
      {notice ? <p className="model-settings-modal__hint">{notice}</p> : null}
      {error ? <p className="model-settings-modal__hint model-settings-modal__hint--error">{error}</p> : null}

      <div className="model-settings-modal__confirm-actions">
        <button type="button" disabled={runDisabled} onClick={() => void handleRun()}>
          {running ? (zh ? "巡检中…" : "Checking…") : zh ? "立即巡检" : "Check now"}
        </button>
      </div>
    </>
  );
}
