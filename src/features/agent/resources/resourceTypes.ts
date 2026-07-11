// 资源锁类型。设计依据：`.md/27` §5.5 / §7.2。

export type ResourceMode = "shared" | "exclusive";

export type ResourceLock = {
  id: string;
  kind: string;
  key: string;
  mode: ResourceMode;
  taskId: string;
  stepId: string;
  acquiredAt: number;
};

export type ResourceRequest = {
  kind: string;
  key: string;
  mode: ResourceMode;
  taskId: string;
  stepId: string;
};

export type ResourceAcquireResult =
  | { ok: true; locks: ResourceLock[] }
  | {
      ok: false;
      conflict: {
        kind: string;
        key: string;
        heldByTaskId: string;
        heldByStepId: string;
        heldMode: ResourceMode;
      };
    };
