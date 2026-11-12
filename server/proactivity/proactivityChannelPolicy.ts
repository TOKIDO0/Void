/**
 * PRO-01 主动触达通道策略 —— 唯一语义 owner。
 *
 * 当前只有一条需要策略的通道差异：**语音播报**。
 * 系统通知仍是所有主动内容的兜底通道（不提供“关通知”策略：PRO-02 的克制档
 * 已经能整体停止代理主动，再加一层会让两个语义重叠）。
 *
 * 规则：
 * - 代理主动（origin=agent，静默巡检）：永不播报。巡检是可行动提示，不该在用户
 *   专注或半睡时开口；通知 + 托盘足够。
 * - 用户提醒 / 日程提醒：只有任务显式要求（speakOnDeliver=true）才请求播报。
 *
 * 这里只回答“是否请求语音”；窗口可见、语音开关、音色是否可用属于前端能力，
 * 由执行侧如实回报 skipped，不在这里猜。
 */

import type { DeliverySpeechPlan, ScheduleOrigin } from "../scheduler/schedulerTypes";

export type DeliverySpeechPlanInput = {
  origin?: ScheduleOrigin;
  speakOnDeliver: boolean;
};

export function resolveDeliverySpeechPlan(input: DeliverySpeechPlanInput): DeliverySpeechPlan {
  if (input.origin === "agent") {
    return { allowed: false, reason: "AGENT_SILENT" };
  }
  if (!input.speakOnDeliver) {
    return { allowed: false, reason: "NOT_REQUESTED" };
  }
  return { allowed: true, reason: "REQUESTED" };
}
