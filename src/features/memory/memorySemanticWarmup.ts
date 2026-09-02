// VOID 记忆语义检索 —— 空闲预热（M4 显性化闭环）
// 职责单一：开关开时在空闲时段静默 warmup bridge 侧 embedding 模型；关时零成本（绝不发请求）。
// 不做排序、不做存盘、失败自愈 —— 仅触发 bridge 侧 pipeline 懒加载，首轮召回即可命中，超时与失败均静默降级。

import { isSemanticSearchEnabled } from "./memorySemanticConfig";
import { embedMemoryTexts } from "./memoryEmbeddingClient";

/** 预热去重：单次页面生命周期内最多预热 1 次，避免重复触发下载/推理。 */
let hasWarmedUp = false;
let warmupPromise: Promise<void> | null = null;

/** 静默预热：仅当开关开且尚未预热过时，发一次短文本 embed 触发 bridge 模型加载。 */
export function warmupSemanticEmbedIfEnabled(): Promise<void> {
  if (!isSemanticSearchEnabled() || hasWarmedUp) {
    return Promise.resolve();
  }
  if (warmupPromise) {
    return warmupPromise;
  }
  warmupPromise = embedMemoryTexts(["你好"], { isQuery: true, timeoutMs: 8000 })
    .then(() => {
      hasWarmedUp = true;
    })
    .catch(() => {
      // 预热失败不记为已预热，允许下一次召回/空闲再试；但本轮 promise 已落地，避免悬垂。
    })
    .finally(() => {
      warmupPromise = null;
    });
  // embed 内部已吞异常并返回 null，then 已处理；这里再包一层保证绝不抛到调用方。
  return warmupPromise.catch(() => {});
}

/** 空闲时段调度预热：优先 requestIdleCallback，回落 setTimeout 1.2s；返回取消句柄。 */
export function scheduleIdleSemanticWarmup(): () => void {
  if (!isSemanticSearchEnabled() || hasWarmedUp) {
    return () => {};
  }
  const run = () => {
    void warmupSemanticEmbedIfEnabled();
  };
  const idle = (
    window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(run, { timeout: 2000 });
    return () => {
      const cancelIdle = (
        window as unknown as { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback;
      if (typeof cancelIdle === "function") cancelIdle(handle);
    };
  }
  const timer = window.setTimeout(run, 1200);
  return () => window.clearTimeout(timer);
}

/** 供单测/开关回显重置：切换关→开后允许再次预热。 */
export function resetSemanticWarmupForTest(): void {
  hasWarmedUp = false;
  warmupPromise = null;
}
