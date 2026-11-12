/**
 * P4/B 后台任务台账（设置模态「任务台账」页签内嵌使用）。
 * 职责：调度任务（列表/立即触发/删除）+ 近期 runs + 接管会话（状态/一键停止）一次看清。
 * 纪律：删除走两步确认（不可逆）；触发/停止为单步明确手势（显式用户意图即确认）；
 * 降级如实；非桌面无接管时只隐藏接管区，不谎报。
 * 视觉复用设置模态中性深色玻璃体系（base.css .security-status* + .tasks*）。
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchRecentRuns,
  getSchedulerStatus,
  listScheduledJobs,
  removeScheduledJob,
  runScheduledJobNow,
  type SchedulerDeliveryView,
  type SchedulerJobView,
  type SchedulerRunView,
  type SchedulerStatusView
} from "./schedulerBridgeClient";
import { takeoverStatus, takeoverStop, type TakeoverStatusView } from "../takeover/takeoverBridgeClient";
import { loadSettingsLanguage, type SettingsLanguage } from "../../settings/settingsI18n";

type FetchState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | {
    phase: "ready";
    status: SchedulerStatusView;
    jobs: SchedulerJobView[];
    runs: SchedulerRunView[];
    takeover: TakeoverStatusView | null;
  };

const COPY: Record<SettingsLanguage, Record<string, string>> = {
  "zh-CN": {
    refresh: "刷新",
    refreshing: "刷新中…",
    loadingTitle: "正在读取台账…",
    errorTitle: "台账读取失败",
    retry: "重试",
    jobsTitle: "定时任务",
    emptyJobs: "暂无后台任务。",
    runsTitle: "近期执行",
    emptyRuns: "暂无执行记录。",
    takeoverTitle: "键鼠接管",
    takeoverInactive: "未开启。",
    runNow: "立即触发",
    remove: "删除",
    confirmRemove: "确认删除？",
    stopTakeover: "停止接管",
    nextRun: "下次",
    lastStatus: "上次",
    disabled: "已停用",
    na: "—"
  },
  "en-US": {
    refresh: "Refresh",
    refreshing: "Refreshing…",
    loadingTitle: "Loading ledger…",
    errorTitle: "Failed to load ledger",
    retry: "Retry",
    jobsTitle: "Scheduled jobs",
    emptyJobs: "No background jobs yet.",
    runsTitle: "Recent runs",
    emptyRuns: "No run records yet.",
    takeoverTitle: "Takeover",
    takeoverInactive: "Inactive.",
    runNow: "Run now",
    remove: "Delete",
    confirmRemove: "Confirm delete?",
    stopTakeover: "Stop takeover",
    nextRun: "Next",
    lastStatus: "Last",
    disabled: "Disabled",
    na: "—"
  }
};

// 存活门禁重查间隔：报错期间静默重查，恢复即停。
const BRIDGE_AUTO_RETRY_MS = 5000;

/**
 * PRO-06：投递状态补充说明（接在执行状态后）。
 * sent/suppressed 不占位；未送达要如实写出来，否则用户会以为提醒已经到过。
 * PRO-04：pending 且被安静时段拦下时，必须写清“延后到几点”，不能只显示“待投递”。
 */
function formatDeliveryNote(delivery: SchedulerDeliveryView, language: SettingsLanguage): string {
  const zh = language === "zh-CN";
  switch (delivery.state) {
    case "pending": {
      if (delivery.holdReason === "QUIET_HOURS" && delivery.holdUntil && delivery.holdUntil > Date.now()) {
        const clock = new Date(delivery.holdUntil).toLocaleTimeString(
          zh ? "zh-CN" : "en-US",
          { hour12: false, hour: "2-digit", minute: "2-digit" }
        );
        return zh
          ? ` · 待投递（安静时段延后至 ${clock}）`
          : ` · Pending (quiet hours, deferred until ${clock})`;
      }
      if (delivery.holdReason === "QUIET_POLICY_ERROR") {
        return zh
          ? " · 待投递（安静时段策略异常，已暂停投递）"
          : " · Pending (quiet-hours policy error, delivery paused)";
      }
      return zh ? " · 待投递" : " · Pending delivery";
    }
    case "delivering":
      return zh ? " · 投递中" : " · Delivering";
    case "failed":
      return zh
        ? ` · 未送达${delivery.errorCode ? `（${delivery.errorCode}）` : ""}`
        : ` · Not delivered${delivery.errorCode ? ` (${delivery.errorCode})` : ""}`;
    case "expired":
      if (delivery.holdReason === "QUIET_HOURS") {
        return zh
          ? " · 投递已过期（安静时段延后后仍未送达）"
          : " · Delivery expired after quiet-hours deferral";
      }
      return zh ? " · 投递已过期" : " · Delivery expired";
    default:
      return "";
  }
}

/** PRO-01：语音计划已批准但实际没播时，台账要如实写原因，不能只显示“已送达”。 */
function formatSpeechNote(
  speech: SchedulerDeliveryView["speechResult"],
  language: SettingsLanguage
): string {
  if (!speech || speech.state === "sent") {
    return "";
  }
  const zh = language === "zh-CN";
  const reasons: Record<string, { zh: string; en: string }> = {
    VOICE_OFF: { zh: "语音输出已关闭", en: "voice output off" },
    WINDOW_HIDDEN: { zh: "窗口未显示", en: "window hidden" },
    NO_SPEAKER: { zh: "未配置音色", en: "no voice configured" },
    EMPTY_TEXT: { zh: "无播报内容", en: "empty text" },
    TTS_FAILED: { zh: "语音合成失败", en: "speech synthesis failed" },
    NOTIFICATION_FAILED: { zh: "通知未送达", en: "notification failed" }
  };
  const reason = speech.reason ? reasons[speech.reason] : undefined;
  const reasonText = reason ? (zh ? reason.zh : reason.en) : (speech.reason ?? (zh ? "未知原因" : "unknown"));
  if (speech.state === "skipped") {
    return zh ? ` · 语音已跳过（${reasonText}）` : ` · Speech skipped (${reasonText})`;
  }
  return zh ? ` · 语音失败（${reasonText}）` : ` · Speech failed (${reasonText})`;
}

function formatRunOrigin(origin: SchedulerRunView["origin"], language: SettingsLanguage): string {
  if (!origin) {
    return "";
  }
  const zh = language === "zh-CN";
  switch (origin) {
    case "calendar":
      return zh ? "日程提醒" : "Calendar reminder";
    case "agent":
      return zh ? "代理主动" : "Agent-initiated";
    default:
      return zh ? "用户提醒" : "User reminder";
  }
}

export function TasksContent() {
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [fetchState, setFetchState] = useState<FetchState>({ phase: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const copy = COPY[language];

  // silent=true：后台静默重查，成功转绿，失败保持原报错，不闪 loading。
  const load = useCallback(async (signal: AbortSignal, silent = false) => {
    if (!silent) {
      setFetchState({ phase: "loading" });
    }
    try {
      const [status, jobs, runs] = await Promise.all([
        getSchedulerStatus(signal),
        listScheduledJobs(signal),
        fetchRecentRuns(10, signal)
      ]);
      const takeover = await takeoverStatus().catch(() => null);
      if (!signal.aborted) {
        setFetchState({ phase: "ready", status, jobs, runs, takeover });
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      setFetchState({
        phase: "error",
        message: error instanceof Error ? error.message : "未知错误"
      });
    }
  }, []);

  useEffect(() => {
    setLanguage(loadSettingsLanguage());
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // 存活门禁：报错期间每 5 秒静默重查，bridge 起來自动转绿；恢复或卸载即停。
  useEffect(() => {
    if (fetchState.phase !== "error") {
      return;
    }
    const timer = window.setInterval(() => {
      const controller = new AbortController();
      void load(controller.signal, true);
    }, BRIDGE_AUTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [fetchState.phase, load]);

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    const controller = new AbortController();
    setIsRefreshing(true);
    setConfirmingId(null);
    void load(controller.signal).finally(() => setIsRefreshing(false));
  }, [isRefreshing, load]);

  const handleRunNow = useCallback(async (id: string) => {
    try {
      await runScheduledJobNow(id);
    } catch {
      // 失败由刷新后的台账如实呈现，不弹虚假成功
    } finally {
      handleRefresh();
    }
  }, [handleRefresh]);

  const handleRemove = useCallback(async (id: string) => {
    if (confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    setConfirmingId(null);
    try {
      await removeScheduledJob(id);
    } finally {
      handleRefresh();
    }
  }, [confirmingId, handleRefresh]);

  const handleStopTakeover = useCallback(async () => {
    try {
      await takeoverStop();
    } finally {
      handleRefresh();
    }
  }, [handleRefresh]);

  const formatTime = useCallback((timestamp?: number): string => {
    if (!timestamp) {
      return copy.na;
    }
    return new Date(timestamp).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US", { hour12: false });
  }, [copy.na, language]);


  return (
    <div className="security-status__embedded">
      <div className="security-status__toolbar">
        <button
          type="button"
          className="security-status__refresh"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? copy.refreshing : copy.refresh}
        </button>
      </div>

      {fetchState.phase === "loading" && (
        <div className="security-status__placeholder">
          <h3>{copy.loadingTitle}</h3>
        </div>
      )}

      {fetchState.phase === "error" && (
        <div className="security-status__placeholder security-status__placeholder--error">
          <h3>{copy.errorTitle}</h3>
          <p className="security-status__error-message">{fetchState.message}</p>
          <button type="button" className="security-status__refresh" onClick={handleRefresh}>
            {copy.retry}
          </button>
        </div>
      )}

      {fetchState.phase === "ready" && (
        <>
          <section className="security-status__card tasks__card">
            <h3>
              {copy.jobsTitle}（{fetchState.status.enabledCount}/{fetchState.status.jobCount}）
            </h3>
            {fetchState.jobs.length === 0 && <p className="tasks__empty">{copy.emptyJobs}</p>}
            {fetchState.jobs.map((job) => (
              <div key={job.id} className="tasks__row">
                <div className="tasks__row-main">
                  <div className="tasks__row-title">{job.name}</div>
                  <div className="tasks__row-meta">
                    {job.kind} · {copy.nextRun}{formatTime(job.nextRunAtMs)} · {copy.lastStatus}{job.lastStatus ?? copy.na}
                    {!job.enabled && ` · ${copy.disabled}`}
                  </div>
                </div>
                <div className="tasks__row-actions">
                  <button type="button" className="security-status__refresh" onClick={() => void handleRunNow(job.id)}>
                    {copy.runNow}
                  </button>
                  <button type="button" className="security-status__refresh" onClick={() => void handleRemove(job.id)}>
                    {confirmingId === job.id ? copy.confirmRemove : copy.remove}
                  </button>
                </div>
              </div>
            ))}
          </section>

          <div className="security-status__grid tasks__grid">
            <section className="security-status__card tasks__card">
              <h3>{copy.runsTitle}</h3>
              {fetchState.runs.length === 0 && <p className="tasks__empty">{copy.emptyRuns}</p>}
              {fetchState.runs.slice().reverse().slice(0, 5).map((run) => (
                <div key={run.id} className="tasks__row">
                  <div className="tasks__row-main">
                    <div className="tasks__row-title">{run.jobName}</div>
                    <div className="tasks__row-meta">
                      {run.origin ? `${formatRunOrigin(run.origin, language)} · ` : ""}
                      {run.status} · {formatTime(run.finishedAt ?? run.startedAt)}
                      {run.summary ? ` · ${run.summary.slice(0, 60)}` : ""}
                      {formatDeliveryNote(run.delivery, language)}
                      {formatSpeechNote(run.delivery.speechResult, language)}
                    </div>
                  </div>
                </div>
              ))}
            </section>

            <section className="security-status__card tasks__card">
              <h3>{copy.takeoverTitle}</h3>
              {!fetchState.takeover?.active && <p className="tasks__empty">{copy.takeoverInactive}</p>}
              {fetchState.takeover?.active && (
                <div className="tasks__row">
                  <div className="tasks__row-main">
                    <div className="tasks__row-title">
                      {language === "zh-CN" ? "接管中" : "Active"} · {fetchState.takeover.allow.length}
                      {language === "zh-CN" ? " 白名单" : " allowed"}
                    </div>
                  </div>
                  <div className="tasks__row-actions">
                    <button type="button" className="security-status__refresh" onClick={() => void handleStopTakeover()}>
                      {copy.stopTakeover}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
