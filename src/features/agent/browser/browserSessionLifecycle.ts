/**
 * 浏览器会话生命周期：任务终态时关闭 sidecar 侧 BrowserContext。
 * 与资源锁释放配合，满足 27 号「任务结束后释放」验收。
 */

import { closeBrowserSession } from "./browserBridgeClient";

/**
 * 尽力关闭任务对应的浏览器上下文。
 * sidecar 未启动或本任务从未打开浏览器时静默成功（hadSession=false）。
 */
export async function releaseBrowserSessionForTask(taskId: string): Promise<void> {
  const normalized = taskId.trim();
  if (!normalized) {
    return;
  }

  try {
    await closeBrowserSession(normalized);
  } catch {
    // 终态清理不得抛错阻断任务收尾；桥接不可达时由调用方日志观察。
  }
}
