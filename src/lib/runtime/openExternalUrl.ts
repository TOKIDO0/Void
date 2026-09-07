import { isTauriRuntime } from "./voidBridgeRuntime";

/**
 * 统一外部链接出口：官网、控制台、Key 申请页都走这里。
 * Tauri WebView 内 window.open 默认不会跳系统浏览器，必须走 shell open 通道；
 * 纯 Web 预览才用 window.open 兜底。失败返回 false，调用方据此给用户可读提示。
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const target = url.trim();
  if (!target || !/^https?:\/\//i.test(target)) {
    return false;
  }
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("plugin:shell|open", { path: target });
      return true;
    } catch {
      // shell 通道不可用（缺权限或旧壳）时继续走浏览器兜底，不抛错。
    }
  }
  try {
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    if (opened) {
      return true;
    }
  } catch {}
  try {
    window.location.href = target;
    return true;
  } catch {
    return false;
  }
}
