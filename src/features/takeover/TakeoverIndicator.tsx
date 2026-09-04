/**
 * P6 接管指示器：会话有效时常显徽标（剩余时间 + 白名单数 + 一键停止）， supervisory 可见性。
 * 非桌面/无会话时渲染空。
 */

import { useCallback, useEffect, useState } from "react";
import { takeoverStatus, takeoverStop, type TakeoverStatusView } from "../agent/takeover/takeoverBridgeClient";

function formatRemaining(totalSec: number): string {
  const clamped = Math.max(0, Math.floor(totalSec));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TakeoverIndicator() {
  const [view, setView] = useState<TakeoverStatusView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await takeoverStatus();
      setView(status.active ? status : null);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleStop = useCallback(async () => {
    try {
      await takeoverStop();
    } catch {
      // 停止失败也刷新一次，以真实状态为准
    } finally {
      await refresh();
    }
  }, [refresh]);

  if (!view) {
    return null;
  }

  return (
    <div className="takeover-indicator" role="status" aria-label="键鼠接管进行中">
      <span className="takeover-indicator__dot" aria-hidden="true" />
      <span>接管中 · 剩余{formatRemaining(view.expiresInSec)} · {view.allow.length} 白名单</span>
      <button type="button" className="takeover-indicator__stop" onClick={() => void handleStop()}>
        停止
      </button>
    </div>
  );
}
