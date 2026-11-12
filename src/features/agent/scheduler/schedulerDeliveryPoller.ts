/**
 * PRO-06 投递器：每 60s 原子领取待投递 runs → 系统通知 → 按真实结果上报。
 *
 * 与旧实现的区别（这是本文件存在的理由）：
 * - 旧：通知失败被内部吞掉，调用方仍把记录标记为已投递 → 提醒静默消失。
 * - 新：只有 sendNotification 真正执行才报 sent；权限缺失报 failed/PERMISSION_DENIED，
 *   记录保留在台账里，用户能看到"没送达"以及原因。
 * - 领取由 sidecar 写租约，避免多窗口重复通知；进程崩溃后租约过期自动重投。
 * - PRO-04 安静时段由 sidecar 的 claim 闸门统一处理；这里禁止再写一份本地时间判断。
 * - PRO-01 语音通道：sidecar 在 claim 时给出 speechPlan，这里只执行并按真实结果回报；
 *   能力不满足（窗口隐藏/语音关/无音色）记 skipped，不伪装成已播报。
 *
 * 窗口隐藏时同样生效；非 Tauri（纯 Web dev）无通知能力时报 failed，不伪造成功。
 */

import { isVoidBridgeReachable } from "../bridge/bridgeHealthClient";
import {
  claimPendingDeliveries,
  fetchDeliverySummary,
  reportDeliveryResults,
  type SchedulerRunView
} from "./schedulerBridgeClient";
import { speakDeliveryText } from "./deliverySpeaker";

/** 通知正文上限：与 PRO-06 设计一致。 */
const MAX_NOTIFICATION_BODY_CHARS = 200;

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

type DeliveryAttempt = {
  runId: string;
  result: "sent" | "failed";
  errorCode?: string;
  /** PRO-01：语音通道实际结果；不改变投递终态，只用于台账可观测。 */
  speech?: { state: "sent" | "skipped" | "failed"; reason?: string };
};

/**
 * 尝试展示一条通知。
 * 返回 sent 仅代表系统通知接口已接受；返回 failed 时携带原因码。
 */
async function notifyRun(run: SchedulerRunView): Promise<DeliveryAttempt> {
  const title = `VOID 后台任务：${run.jobName || "未命名"}`.slice(0, 60);
  const summary = (run.summary ?? "").trim().slice(0, MAX_NOTIFICATION_BODY_CHARS);
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
      return { runId: run.id, result: "failed", errorCode: "PERMISSION_DENIED" };
    }
    sendNotification({ title, body });
    return { runId: run.id, result: "sent" };
  } catch {
    // 非 Tauri / 通知插件不可用：如实报失败，不冒充已送达。
    return { runId: run.id, result: "failed", errorCode: "NOTIFICATION_UNAVAILABLE" };
  }
}

/** A3：通知点击打开主窗口（注册一次；非桌面静默跳过）。 */
let interactionsReady = false;

export async function initDeliveryInteractions(): Promise<void> {
  if (interactionsReady) {
    return;
  }
  interactionsReady = true;
  try {
    const { onAction } = await import("@tauri-apps/plugin-notification");
    await onAction(() => {
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        try {
          const window = getCurrentWindow();
          await window.show();
          await window.setFocus();
        } catch {
          // 显示失败静默
        }
      });
    });
  } catch {
    // 非桌面无通知动作能力
  }
}

/** A1：托盘 tooltip 同步未送达数（失败静默，不挡投递）。 */
async function syncTrayUnread(count: number): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("tray_set_unread", { count });
  } catch {
    // 非桌面无托盘
  }
}

export async function pollSchedulerDeliveries(): Promise<number> {
  try {
    const reachable = await isVoidBridgeReachable().catch(() => false);
    if (!reachable) {
      // 桥接不可达：不领取、不上报，记录保持 pending 等下次。
      return 0;
    }

    const claimed = await claimPendingDeliveries().catch((): SchedulerRunView[] => []);
    if (!claimed.length) {
      const summary = await fetchDeliverySummary().catch(() => ({ undelivered: 0 }));
      await syncTrayUnread(summary.undelivered);
      return 0;
    }

    // PRO-01：语音计划由 sidecar 在 claim 时给出；这里只执行并如实回报能力结果。
    const attempts: DeliveryAttempt[] = [];
    for (const run of claimed) {
      const attempt = await notifyRun(run);
      const speechPlan = run.delivery.speechPlan;
      if (attempt.result === "sent" && speechPlan?.allowed) {
        const speech = await speakDeliveryText(run.summary ?? "");
        attempt.speech = speech.state === "sent"
          ? { state: "sent" }
          : { state: speech.state, reason: speech.reason };
      } else if (speechPlan?.allowed && attempt.result !== "sent") {
        // 通知没送达时不再播报，避免“没弹通知却在念摘要”。
        attempt.speech = { state: "skipped", reason: "NOTIFICATION_FAILED" };
      }
      attempts.push(attempt);
    }

    await reportDeliveryResults(attempts).catch(() => undefined);

    const summary = await fetchDeliverySummary().catch(() => ({ undelivered: 0 }));
    await syncTrayUnread(summary.undelivered);
    return attempts.filter((attempt) => attempt.result === "sent").length;
  } catch {
    return 0;
  }
}
