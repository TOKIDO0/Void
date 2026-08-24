// VOID 记忆语义检索开关（M4，前端唯一 owner）
// 职责单一：只读写「本地语义检索是否开启」这一个布尔开关的持久化，不碰模型、不碰召回。
// 载体：localStorage，键 void.memory.semanticSearchEnabled。默认关闭（false）。
// 关闭时召回完全等价 M3 全文，不加载任何模型、不下载权重、无隐私外发。

/** 持久化键：语义检索开关。改键名等于重置为默认关。 */
const SEMANTIC_SEARCH_ENABLED_KEY = "void.memory.semanticSearchEnabled";

/** 读取开关。无值 / 非法值 / 无 localStorage 一律回落关闭，绝不误开。 */
export function isSemanticSearchEnabled(): boolean {
  try {
    return window.localStorage.getItem(SEMANTIC_SEARCH_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

/** 写入开关。写盘失败静默吞掉，不影响主流程。 */
export function setSemanticSearchEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SEMANTIC_SEARCH_ENABLED_KEY, enabled ? "true" : "false");
  } catch {
    // localStorage 不可用时忽略：下次读取回落默认关闭。
  }
}
