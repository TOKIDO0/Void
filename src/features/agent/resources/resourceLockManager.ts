// 最小资源锁管理器：进程内内存实现，保证同 key 的 exclusive 互斥。

import type {
  ResourceAcquireResult,
  ResourceLock,
  ResourceRequest
} from "./resourceTypes";

const activeLocks: ResourceLock[] = [];
let lockSequence = 0;

function makeLockId() {
  lockSequence += 1;
  return `lock_${Date.now().toString(36)}_${lockSequence}`;
}

/**
 * 尝试为一步申请多个资源。全部成功才写入；任一冲突则整批失败。
 */
export function acquireResources(requests: ResourceRequest[]): ResourceAcquireResult {
  for (const request of requests) {
    const conflict = findConflict(request);
    if (conflict) {
      return {
        ok: false,
        conflict: {
          kind: conflict.kind,
          key: conflict.key,
          heldByTaskId: conflict.taskId,
          heldByStepId: conflict.stepId,
          heldMode: conflict.mode
        }
      };
    }
  }

  const now = Date.now();
  const acquired: ResourceLock[] = requests.map((request) => ({
    id: makeLockId(),
    kind: request.kind,
    key: request.key,
    mode: request.mode,
    taskId: request.taskId,
    stepId: request.stepId,
    acquiredAt: now
  }));

  activeLocks.push(...acquired);
  return { ok: true, locks: acquired };
}

/**
 * 释放某一步持有的全部锁。
 */
export function releaseStepResources(taskId: string, stepId: string) {
  for (let index = activeLocks.length - 1; index >= 0; index -= 1) {
    const lock = activeLocks[index];
    if (lock.taskId === taskId && lock.stepId === stepId) {
      activeLocks.splice(index, 1);
    }
  }
}

/**
 * 释放某个任务的全部锁（取消/终态清理）。
 */
export function releaseTaskResources(taskId: string) {
  for (let index = activeLocks.length - 1; index >= 0; index -= 1) {
    if (activeLocks[index].taskId === taskId) {
      activeLocks.splice(index, 1);
    }
  }
}

/**
 * 当前锁快照（调试 / 验收用）。
 */
export function listActiveResourceLocks(): ResourceLock[] {
  return activeLocks.map((lock) => ({ ...lock }));
}

/**
 * 清空全部锁（本地自检重置）。
 */
export function clearAllResourceLocks() {
  activeLocks.splice(0, activeLocks.length);
}

function findConflict(request: ResourceRequest): ResourceLock | undefined {
  return activeLocks.find((lock) => {
    if (lock.kind !== request.kind || lock.key !== request.key) {
      return false;
    }
    // 任一端 exclusive 即冲突；shared 与 shared 可并存。
    return lock.mode === "exclusive" || request.mode === "exclusive";
  });
}
