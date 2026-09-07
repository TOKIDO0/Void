import { isTauriRuntime, resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { isVoidBridgeReachable } from "./bridgeHealthClient";

/** 与 Rust BridgeSidecarStatus 对齐（rename_all camelCase）。 */
export type BridgeSidecarStatus = {
  spawned: boolean;
  spawnError: string | null;
  terminated: string | null;
};

export type BridgeProbeResult =
  | { kind: "ok" }
  | { kind: "down"; sidecar: BridgeSidecarStatus | null; reachable: boolean };

/** 只读读取 Rust 侧 sidecar 生命周期状态；非 Tauri 或调用失败返回 null（不抛）。 */
export async function getBridgeSidecarStatus(): Promise<BridgeSidecarStatus | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<BridgeSidecarStatus>("get_bridge_status");
    if (!status || typeof status.spawned !== "boolean") {
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

/**
 * 启动探针（P0-1 后半段）：sidecar 状态 + 直连 health 双证据。
 * ok 判定：health 可达（sidecar 真正在监听）。spawned 只做归因，不单独判 ok，
 * 避免“进程在但端口没起来”被误判健康。
 */
export async function probeBridgeStatus(signal?: AbortSignal): Promise<BridgeProbeResult> {
  const [sidecar, reachable] = await Promise.all([
    getBridgeSidecarStatus(),
    isVoidBridgeReachable(signal).catch(() => false)
  ]);
  if (reachable) {
    return { kind: "ok" };
  }
  return { kind: "down", sidecar, reachable };
}

/** 当前 bridge 基地址（诊断展示用，不含敏感信息）。 */
export function getBridgeOriginForDisplay(): string {
  try {
    return resolveVoidBridgeOrigin();
  } catch {
    return "";
  }
}

/** 归因首行：spawn 失败 > 进程异常退出 > 按运行态给可执行的下一步。 */
export function describeBridgeDownCause(result: Extract<BridgeProbeResult, { kind: "down" }>): string {
  if (result.sidecar?.spawnError) {
    return `sidecar 启动失败：${result.sidecar.spawnError}`;
  }
  if (result.sidecar?.terminated) {
    return `sidecar 进程异常：${result.sidecar.terminated}`;
  }
  // Tauri 内：sidecar 只在正式包由 Rust 拉起；开发期需另起桥接进程。
  if (isTauriRuntime()) {
    return "本地工具服务没起来：正式包会自动拉起；开发期请再开一个终端跑 npm run dev:bridge（或 npm run dev:all 后另起 tauri dev）。填了搜索 Key 的话，联网搜索不受影响。";
  }
  // 纯网页预览：本来就没有本地服务，不是故障。
  return "网页预览没有本地工具服务（正常现象）：联网搜索走云 Key 可用，打开应用、读写文件等本机操作请用桌面端。";
}

export async function fetchBridgeHealthSnapshot(signal?: AbortSignal): Promise<string | null> {
  const url = `${getBridgeOriginForDisplay()}/void-bridge/health`;
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, { method: "GET", headers: authHeaders, signal });
    if (!response.ok) {
      return `HTTP ${response.status}`;
    }
    return "ok";
  } catch {
    return null;
  }
}
