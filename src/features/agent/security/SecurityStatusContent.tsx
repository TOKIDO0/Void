// VOID 本机安全状态内容（设置模态「安全状态」页签内嵌使用，41/40 号文档）。
// 职责：只读呈现 /void-bridge/security-status 的结构化结果（S19）。
// 纪律：纯只读零操作（唯一动作是重新检查）；降级如实，禁止伪健康；
// 不显示真实网卡 IP（服务端本就不返回）。
// 视觉对齐设置模态的中性深色玻璃体系（base.css .security-status*）。

import { useCallback, useEffect, useState } from "react";
import {
  getSecurityBridgeErrorInfo,
  inspectLocalRuntimeSecurity
} from "./localRuntimeSecurityClient";
import {
  getSecurityStatusCopy,
  loadSecurityPanelLanguage,
  type SecuritySeverityLabel
} from "./securityStatusI18n";
import type { SettingsLanguage } from "../../settings/settingsI18n";
import type { LocalRuntimeSecurityCheck, LocalRuntimeSecurityStatusData } from "./localRuntimeSecurityClient";

type FetchState =
  | { phase: "loading" }
  | { phase: "error"; code: string; message: string }
  | { phase: "ready"; data: LocalRuntimeSecurityStatusData };

export function SecurityStatusContent() {
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSecurityPanelLanguage());
  const [fetchState, setFetchState] = useState<FetchState>({ phase: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const copy = getSecurityStatusCopy(language);

  const runInspection = useCallback(async (signal: AbortSignal) => {
    setFetchState({ phase: "loading" });
    try {
      const data = await inspectLocalRuntimeSecurity(signal);
      if (!signal.aborted) {
        setFetchState({ phase: "ready", data });
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const info = getSecurityBridgeErrorInfo(error);
      setFetchState({ phase: "error", code: info.code, message: info.message });
    }
  }, []);

  // 挂载时同步设置语言并立即发起一次只读检查；卸载时中止进行中的请求。
  useEffect(() => {
    setLanguage(loadSecurityPanelLanguage());
    const controller = new AbortController();
    void runInspection(controller.signal);
    return () => controller.abort();
  }, [runInspection]);

  const handleRefresh = useCallback(() => {
    if (isRefreshing) {
      return;
    }
    const controller = new AbortController();
    setIsRefreshing(true);
    void runInspection(controller.signal).finally(() => setIsRefreshing(false));
  }, [isRefreshing, runInspection]);

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString(
      language === "zh-CN" ? "zh-CN" : "en-US",
      { hour12: false }
    );
  };

  const renderBooleanValue = (value: boolean): string =>
    value ? copy.valueLabels.yes : copy.valueLabels.no;

  const renderSeverityBadge = (severity: LocalRuntimeSecurityCheck["severity"]) => {
    const label = copy.severityLabels[severity as SecuritySeverityLabel];
    return (
      <span className={`security-status__check-badge security-status__check-badge--${severity}`}>
        {label}
      </span>
    );
  };

  return (
    <div className="security-status__embedded">
      <div className="security-status__toolbar">
        <p className="security-status__intro">{copy.intro}</p>
        <button
          type="button"
          className="security-status__refresh"
          onClick={handleRefresh}
          disabled={isRefreshing}
        >
          {isRefreshing ? copy.refreshing : copy.refresh}
        </button>
      </div>

      {fetchState.phase === "loading" && (
        <div className="security-status__placeholder">
          <h3>{copy.loadingTitle}</h3>
          <p>{copy.loadingText}</p>
        </div>
      )}

      {fetchState.phase === "error" && (
        <div className="security-status__placeholder security-status__placeholder--error">
          <h3>{copy.errorTitle}</h3>
          <p>
            {copy.errorTextPrefix}：{fetchState.message}
          </p>
          <p className="security-status__error-code">
            {copy.errorCodeLabel}: {fetchState.code}
          </p>
          <button type="button" className="security-status__refresh" onClick={handleRefresh}>
            {copy.refresh}
          </button>
        </div>
      )}

      {fetchState.phase === "ready" && (() => {
        const data = fetchState.data;
        return (
          <>
            <div className={`security-status__overall security-status__overall--${data.overall}`}>
              <span className="security-status__overall-dot" aria-hidden="true" />
              <span className="security-status__overall-label">
                {copy.overallLabels[data.overall]}
              </span>
              <span className="security-status__overall-time">
                {copy.inspectedAt} {formatTimestamp(data.inspectedAt)}
              </span>
            </div>

            <div className="security-status__grid">
              <section className="security-status__card">
                <h3>{copy.sections.bridge}</h3>
                <dl>
                  <div>
                    <dt>{copy.bridgeFields.origin}</dt>
                    <dd>{data.bridge.origin}</dd>
                  </div>
                  <div>
                    <dt>{copy.bridgeFields.listenIsLoopback}</dt>
                    <dd>{renderBooleanValue(data.bridge.listenIsLoopback)}</dd>
                  </div>
                  <div>
                    <dt>{copy.bridgeFields.tokenRequired}</dt>
                    <dd>{renderBooleanValue(data.bridge.tokenRequired)}</dd>
                  </div>
                  <div>
                    <dt>{copy.bridgeFields.allowedOrigins}</dt>
                    <dd>{data.bridge.allowedOrigins.length > 0 ? data.bridge.allowedOrigins.join("、") : copy.valueLabels.none}</dd>
                  </div>
                  <div>
                    <dt>{copy.bridgeFields.securityHeaders}</dt>
                    <dd>{data.bridge.securityHeaders.length > 0 ? data.bridge.securityHeaders.length : copy.valueLabels.none}</dd>
                  </div>
                </dl>
              </section>

              <section className="security-status__card">
                <h3>{copy.sections.proxy}</h3>
                <dl>
                  <div>
                    <dt>{copy.proxyFields.requestBodyMaxBytes}</dt>
                    <dd>{formatBytes(data.proxy.requestBodyMaxBytes)}</dd>
                  </div>
                  <div>
                    <dt>{copy.proxyFields.maxConcurrentRequests}</dt>
                    <dd>{data.proxy.maxConcurrentRequests}</dd>
                  </div>
                  <div>
                    <dt>{copy.proxyFields.activeRequests}</dt>
                    <dd>{data.proxy.activeRequests}</dd>
                  </div>
                </dl>
              </section>

              <section className="security-status__card">
                <h3>{copy.sections.browser}</h3>
                <dl>
                  <div>
                    <dt>{copy.browserFields.browserReady}</dt>
                    <dd>{data.browser.browserReady ? copy.valueLabels.ready : copy.valueLabels.notReady}</dd>
                  </div>
                  <div>
                    <dt>{copy.browserFields.sessions}</dt>
                    <dd>{data.browser.activeSessions} / {data.browser.maxSessions}</dd>
                  </div>
                  <div>
                    <dt>{copy.browserFields.sessionIdleTtlMs}</dt>
                    <dd>{Math.round(data.browser.sessionIdleTtlMs / 60000)} min</dd>
                  </div>
                  <div>
                    <dt>{copy.browserFields.headless}</dt>
                    <dd>{data.browser.headless ? copy.valueLabels.headlessOn : copy.valueLabels.headlessOff}</dd>
                  </div>
                </dl>
              </section>

              <section className="security-status__card">
                <h3>{copy.sections.network}</h3>
                <dl>
                  <div>
                    <dt>{copy.networkFields.interfaceCount}</dt>
                    <dd>{data.network.interfaceCount}</dd>
                  </div>
                  <div>
                    <dt>{copy.networkFields.nonLoopbackAddressCount}</dt>
                    <dd>{data.network.nonLoopbackAddressCount}</dd>
                  </div>
                  <div>
                    <dt>{copy.networkFields.addressCounts}</dt>
                    <dd>
                      {Object.entries(data.network.addressCounts)
                        .filter(([, count]) => count > 0)
                        .map(([range, count]) => `${range}:${count}`)
                        .join(" · ") || copy.valueLabels.none}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            <section className="security-status__checks">
              <h3>{copy.sections.checks}</h3>
              <ul>
                {data.checks.map((check) => (
                  <li key={check.id}>
                    {renderSeverityBadge(check.severity)}
                    <span className="security-status__check-message">{check.message}</span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="security-status__note">{copy.privacyNote}</p>
          </>
        );
      })()}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
