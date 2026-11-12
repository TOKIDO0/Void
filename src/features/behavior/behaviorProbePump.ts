/**
 * BEH-01 采样泵：把 Rust 传感器读到的空闲秒数搬到 owner。
 *
 * 只做搬运：
 * - 每 60s 问一次 owner 开关（owner 是唯一真源），按开关启停传感器；
 * - 取走环缓冲并原样上报，不判定活跃、不聚合、不写存储；
 * - 失败静默：样本留在 Rust 环缓冲里（上限 24h），下一轮再送。
 */

import {
  fetchBehaviorStatus,
  postBehaviorSamples,
  type BehaviorProbeSample
} from "./behaviorBridgeClient";

const PUMP_INTERVAL_MS = 60_000;
const FIRST_TICK_DELAY_MS = 20_000;

type ProbeTakeResult = {
  samples: BehaviorProbeSample[];
  running: boolean;
  readFailures: number;
};

async function configureProbe(enabled: boolean): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<boolean>("behavior_probe_configure", { enabled });
  } catch {
    // 非 Tauri 环境（纯 vite 预览）或旧安装包：没有传感器，静默跳过。
  }
}

async function pumpOnce(): Promise<void> {
  const status = await fetchBehaviorStatus();
  if (!status.enabled) {
    await configureProbe(false);
    return;
  }
  await configureProbe(true);
  const { invoke } = await import("@tauri-apps/api/core");
  const taken = await invoke<ProbeTakeResult>("behavior_probe_take");
  if (taken.samples.length === 0) {
    return;
  }
  await postBehaviorSamples(taken.samples, taken.readFailures);
}

/** 启动泵；返回停止函数。重复启动由调用方保证只调一次（跟随组件生命周期）。 */
export function startBehaviorProbePump(): () => void {
  let cancelled = false;
  let timer = 0;
  const tick = async () => {
    if (cancelled) {
      return;
    }
    try {
      await pumpOnce();
    } catch {
      // 桥接未起 / 传感器不可用：不打扰用户，下一轮继续。
    }
    if (!cancelled) {
      timer = window.setTimeout(() => void tick(), PUMP_INTERVAL_MS);
    }
  };
  timer = window.setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
