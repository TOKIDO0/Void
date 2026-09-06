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

/** 归因首行：spawn 失败 > 进程异常退出 > 单纯不可达。 */
export function describeBridgeDownCause(result: Extract<BridgeProbeResult, { kind: "down" }>): string {
  if (result.sidecar?.spawnError) {
    return `sidecar 启动失败：${result.sidecar.spawnError}`;
  }
  if (result.sidecar?.terminated) {
    return `sidecar 进程异常：${result.sidecar.terminated}`;
  }
  if (result.sidecar && !result.sidecar.spawned) {
    return "sidecar 未被拉起（开发期请用 npm run dev:all 启动）。";
  }
  return "未能连上本地工具服务端口。";
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
