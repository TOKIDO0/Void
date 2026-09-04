/**
 * P4d 后台投递轮询：每 60s 拉未投递终态 runs → 系统通知 → ack。
 * 窗口隐藏时同样生效（定时器节流下限约 1/min）；桥接未起静默跳过。
 * 非 Tauri（纯 Web dev）无通知能力时只 ack，前端台账仍可查。
 */

import { isVoidBridgeReachable } from "../bridge/bridgeHealthClient";
import {
  acknowledgeRuns,
  fetchPendingRuns,
  type SchedulerRunView
} from "./schedulerBridgeClient";

function statusText(status: string): string {
  switch (status) {
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "timed_out":
      return "超时";
    case "paused_needs_user":
      return "需你处理";
    case "missed":
      return "错过";
    default:
      return status || "有更新";
  }
}

async function notifyRun(run: SchedulerRunView): Promise<void> {
  const title = `VOID 后台任务：${run.jobName || "未命名"}`.slice(0, 60);
  const summary = (run.summary ?? "").trim().slice(0, 120);
  const body = summary ? `${statusText(run.status)}：${summary}` : statusText(run.status);
  try {
    const { sendNotification, isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) {
      return;
    }
    sendNotification({ title, body });
  } catch {
    // 非 Tauri 无通知能力：静默跳过
  }
}

/** 拉取并投递，返回本次投递条数（失败不抛）。 */
export async function pollSchedulerDeliveries(): Promise<number> {
  try {
    const reachable = await isVoidBridgeReachable().catch(() => false);
    if (!reachable) {
      return 0;
    }
    const pending = await fetchPendingRuns().catch((): SchedulerRunView[] => []);
    if (!pending.length) {
      return 0;
    }
    const delivered: string[] = [];
    for (const run of pending) {
      try {
        await notifyRun(run);
        delivered.push(run.id);
      } catch {
        // 单条失败不挡其它
      }
    }
    if (delivered.length) {
      await acknowledgeRuns(delivered).catch(() => {});
    }
    return delivered.length;
  } catch {
    return 0;
  }
}
