// 本地工具服务启动探针横幅（设置内安全/台账/高级三页签顶部复用）。
// 职责：只读展示 sidecar 真实状态 + 直连 health 双证据；ok 时不占位，down 时给原因与重试。
// 纪律：纯展示，不拉起进程、不写配置；文案跟随设置语言。

import { useCallback, useEffect, useState } from "react";
import {
  describeBridgeDownCause,
  getBridgeOriginForDisplay,
  probeBridgeStatus,
  type BridgeProbeResult
} from "./bridgeStatusClient";
import { loadSettingsLanguage } from "../../settings/settingsI18n";

type BannerState =
  | { phase: "checking" }
  | { phase: "ok" }
  | { phase: "down"; result: Extract<BridgeProbeResult, { kind: "down" }> };

// 存活门禁重查间隔：down 期间静默重探，恢复即停。
const BRIDGE_AUTO_RETRY_MS = 5000;

export function BridgeStatusBanner() {
  const [state, setState] = useState<BannerState>({ phase: "checking" });
  const [isRetrying, setIsRetrying] = useState(false);
  const language = loadSettingsLanguage();
  const zh = language === "zh-CN";

  const runProbe = useCallback(async () => {
    const controller = new AbortController();
    const result = await probeBridgeStatus(controller.signal).catch(() => null);
    if (!result) {
      return;
    }
    setState(result.kind === "ok" ? { phase: "ok" } : { phase: "down", result });
  }, []);

  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  // 存活门禁：down 期间每 5 秒静默重探，bridge 起來横幅自动消失；ok/卸载即停。
  useEffect(() => {
    if (state.phase !== "down") {
      return;
    }
    const timer = window.setInterval(() => {
      void runProbe();
    }, BRIDGE_AUTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [state.phase, runProbe]);

  const handleRetry = useCallback(() => {
    if (isRetrying) {
      return;
    }
    setIsRetrying(true);
    void runProbe().finally(() => setIsRetrying(false));
  }, [isRetrying, runProbe]);

  if (state.phase !== "down") {
    return null;
  }

  const cause = describeBridgeDownCause(state.result);
  const origin = getBridgeOriginForDisplay();
  return (
    <div className="bridge-banner bridge-banner--down" role="alert">
      <div className="bridge-banner__main">
        <strong>{zh ? "本地工具服务未连接" : "Local tool service unreachable"}</strong>
        <p>{cause}</p>
        {origin ? <p className="bridge-banner__origin">{origin}</p> : null}
      </div>
      <button
        type="button"
        className="security-status__refresh"
        onClick={handleRetry}
        disabled={isRetrying}
      >
        {isRetrying ? (zh ? "检查中…" : "Checking…") : (zh ? "重试" : "Retry")}
      </button>
    </div>
  );
}
