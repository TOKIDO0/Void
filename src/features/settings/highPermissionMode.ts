// VOID 高权限模式（P0-5 已降级为 permissive profile 的快捷开关，对应反馈 5 的 Codex 式 full-access）。
// 默认关闭；用户在设置面板主动开启后生效。存储于 localStorage，键与现有设置体系一致。
// 真实语义由 toolSafetyPolicy.getToolPermissionProfile() 统一解释：ask→allow 放宽，但 deny 红线
// 与动态敏感信号（密钥文件/内网 URL）不放宽。高权限的静态风险映射仍由 riskLevelPolicy 执行。

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
