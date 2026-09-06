/**
 * B 自动更新区（设置 → 高级）：当前版本 + 检查更新 + 下载安装重启。
 * feed 与公钥在 tauri.conf.json；真更新流需首个签名 release 发布后才走得通。
 */

import { useCallback, useEffect, useState } from "react";
import type { SettingsLanguage } from "./settingsI18n";

type Phase =
  | { kind: "idle"; currentVersion: string }
  | { kind: "checking" }
  | { kind: "latest"; currentVersion: string }
  | { kind: "available"; currentVersion: string; version: string; body: string }
  | { kind: "downloading"; percent: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function UpdaterSection({ language }: { language: SettingsLanguage }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle", currentVersion: "" });
  const zh = language === "zh-CN";

  useEffect(() => {
    let cancelled = false;
    void import("@tauri-apps/api/app")
      .then(async ({ getVersion }) => {
        try {
          const currentVersion = await getVersion();
          if (!cancelled) {
            setPhase({ kind: "idle", currentVersion });
          }
        } catch {
          // 非桌面无版本信息
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCheck = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        const { getVersion } = await import("@tauri-apps/api/app");
        setPhase({ kind: "latest", currentVersion: await getVersion().catch(() => "") });
        return;
      }
      setPhase({
        kind: "available",
        currentVersion: update.currentVersion,
        version: update.version,
        body: update.body ?? ""
      });
      await update.close();
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "检查更新失败"
      });
    }
  }, []);

  const handleDownloadInstall = useCallback(async () => {
    if (phase.kind !== "available") {
      return;
    }
    setPhase({ kind: "downloading", percent: 0 });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        setPhase({ kind: "latest", currentVersion: phase.currentVersion });
        return;
      }
      let downloaded = 0;
      let total = 0;
      await update.download((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setPhase({ kind: "downloading", percent: Math.min(99, Math.round((downloaded / total) * 100)) });
          }
        } else if (event.event === "Finished") {
          setPhase({ kind: "downloading", percent: 100 });
        }
      });
      await update.install();
      setPhase({ kind: "ready" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : "下载安装失败"
      });
    }
  }, [phase]);

  return (
    <div>
      <span>
        <strong>{zh ? "应用更新" : "App updates"}</strong>
        <p>
          {zh
            ? "检查 GitHub Releases 新版本，下载后安装重启。签名公钥内置，安装包验签通过才装。"
            : "Check GitHub Releases, download, install and restart. Bundles are signature-verified."}
        </p>
      </span>
      {phase.kind !== "idle" && phase.kind !== "checking" && "currentVersion" in phase && phase.currentVersion ? (
        <p className="model-settings-modal__hint">
          {zh ? `当前版本 ${phase.currentVersion}` : `Current ${phase.currentVersion}`}
        </p>
      ) : null}
      {phase.kind === "checking" && (
        <p className="model-settings-modal__hint">{zh ? "正在检查…" : "Checking…"}</p>
      )}
      {phase.kind === "latest" && (
        <p className="model-settings-modal__hint">{zh ? "已是最新版本。" : "Already up to date."}</p>
      )}
      {phase.kind === "available" && (
        <p className="model-settings-modal__hint">
          {zh ? `发现新版本 ${phase.version}` : `New version ${phase.version}`}
          {phase.body ? `：${phase.body.slice(0, 120)}` : ""}
        </p>
      )}
      {phase.kind === "downloading" && (
        <p className="model-settings-modal__hint">
          {zh ? `下载中 ${phase.percent}%…` : `Downloading ${phase.percent}%…`}
        </p>
      )}
      {phase.kind === "ready" && (
        <p className="model-settings-modal__hint">{zh ? "安装完成，正在重启…" : "Installed, relaunching…"}</p>
      )}
      {phase.kind === "error" && <p className="model-settings-modal__hint">{phase.message}</p>}
      <div className="model-settings-modal__confirm-actions">
        <button type="button" disabled={phase.kind === "checking" || phase.kind === "downloading"} onClick={() => void handleCheck()}>
          {zh ? "检查更新" : "Check for updates"}
        </button>
        {phase.kind === "available" && (
          <button type="button" className="is-primary" onClick={() => void handleDownloadInstall()}>
            {zh ? "下载并安装" : "Download & install"}
          </button>
        )}
      </div>
    </div>
  );
}
