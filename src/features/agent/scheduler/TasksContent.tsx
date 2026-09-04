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
    intro: "后台定时任务与键鼠接管会话一览。删除需点两次确认；触发与停止点一次即执行。",
    refresh: "刷新",
    refreshing: "刷新中…",
    loadingTitle: "正在读取台账…",
    errorTitle: "台账读取失败",
    retry: "重试",
    jobsTitle: "定时任务",
    emptyJobs: "暂无后台任务。对 VOID 说“每天早上8点给我做早报”即可创建。",
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
    intro: "Scheduled jobs and takeover sessions. Delete needs two taps; run and stop execute on tap.",
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

export function TasksContent() {
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [fetchState, setFetchState] = useState<FetchState>({ phase: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const copy = COPY[language];

  const load = useCallback(async (signal: AbortSignal) => {
    setFetchState({ phase: "loading" });
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
        <p className="security-status__intro">{copy.intro}</p>
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
          <p>{fetchState.message}</p>
          <button type="button" className="security-status__refresh" onClick={handleRefresh}>
            {copy.retry}
          </button>
        </div>
      )}

      {fetchState.phase === "ready" && (
        <>
          <h3 className="tasks__section-title">
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

          <h3 className="tasks__section-title">{copy.runsTitle}</h3>
          {fetchState.runs.length === 0 && <p className="tasks__empty">{copy.emptyRuns}</p>}
          {fetchState.runs.slice().reverse().slice(0, 5).map((run) => (
            <div key={run.id} className="tasks__row">
              <div className="tasks__row-main">
                <div className="tasks__row-title">{run.jobName}</div>
                <div className="tasks__row-meta">
                  {run.status} · {formatTime(run.finishedAt ?? run.startedAt)}
                  {run.summary ? ` · ${run.summary.slice(0, 60)}` : ""}
                </div>
              </div>
            </div>
          ))}

          <h3 className="tasks__section-title">{copy.takeoverTitle}</h3>
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
        </>
      )}
    </div>
  );
}
