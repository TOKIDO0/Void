/**
 * BEH-02 画像同步泵：定时拉 owner 派生结果，交给记忆适配层。
 *
 * 只做调度与失败隔离：
 * - 启动后 90s 首次，之后每 60min 一次；
 * - 不判定画像、不生成文案、不写原始数据；
 * - bridge 未起/网络抖动静默跳过，下轮继续，不影响主流程。
 */

import { fetchBehaviorProfile } from "./behaviorBridgeClient";
import { applyBehaviorProfileToMemory } from "./behaviorProfileMemory";

const FIRST_TICK_DELAY_MS = 90_000;
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

async function syncOnce(): Promise<void> {
  const profile = await fetchBehaviorProfile();
  applyBehaviorProfileToMemory(profile);
}

/** 启动画像同步；返回停止函数。重复启动由调用方保证只调一次（跟随组件生命周期）。 */
export function startBehaviorProfileSync(): () => void {
  let cancelled = false;
  let timer = 0;

  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      await syncOnce();
    } catch {
      // 桥接未起 / 网络抖动：不打扰用户，下一轮继续。
    }
    if (!cancelled) {
      timer = window.setTimeout(() => void tick(), SYNC_INTERVAL_MS);
    }
  };

  timer = window.setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
