// VOID 高权限模式（阶段 AC-P1，对应反馈 5 的 Codex 式 full-access）。
// 默认关闭；用户在设置面板主动开启后生效。存储于 localStorage，键与现有设置体系一致。
// 高权限的真实作用由 riskLevelPolicy 统一映射：普通 L2→L1 免确认，但红线/敏感文件读取不降级。

const STORAGE_KEY = "void.highPermissionMode";

export function isHighPermissionMode(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHighPermissionMode(enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 存储失败静默忽略——高权限保持关闭态
  }
}
