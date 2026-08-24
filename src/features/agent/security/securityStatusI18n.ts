// 本机安全状态面板文案：跟随设置页语言（简 / EN）。
// 仅 UI 展示用；数据语义真源是 localRuntimeSecurityClient 的结构化类型。

import {
  loadSettingsLanguage,
  type SettingsLanguage
} from "../../settings/settingsI18n";
import type { LocalRuntimeSecurityCheck } from "./localRuntimeSecurityClient";

type SecuritySeverityLabel = "info" | "warning" | "danger";

type SecurityStatusCopy = {
  eyebrow: string;
  title: string;
  close: string;
  refresh: string;
  refreshing: string;
  inspectedAt: string;
  neverInspected: string;
  overallLabels: Record<"healthy" | "attention" | "unsafe", string>;
  severityLabels: Record<SecuritySeverityLabel, string>;
  sections: {
    bridge: string;
    proxy: string;
    browser: string;
    network: string;
    checks: string;
  };
  bridgeFields: {
    origin: string;
    listenIsLoopback: string;
    tokenRequired: string;
    allowedOrigins: string;
    securityHeaders: string;
    timeouts: string;
  };
  proxyFields: {
    requestBodyMaxBytes: string;
    maxConcurrentRequests: string;
    activeRequests: string;
  };
  browserFields: {
    browserReady: string;
    sessions: string;
    sessionIdleTtlMs: string;
    headless: string;
  };
  networkFields: {
    interfaceCount: string;
    nonLoopbackAddressCount: string;
    addressCounts: string;
  };
  valueLabels: {
    yes: string;
    no: string;
    none: string;
    ready: string;
    notReady: string;
    headlessOn: string;
    headlessOff: string;
  };
  loadingTitle: string;
  loadingText: string;
  errorTitle: string;
  errorTextPrefix: string;
  errorCodeLabel: string;
  privacyNote: string;
};

const SECURITY_STATUS_COPY: Record<SettingsLanguage, SecurityStatusCopy> = {
  "zh-CN": {
    eyebrow: "本机运行时",
    title: "安全状态",
    close: "关闭安全状态面板",
    refresh: "重新检查",
    refreshing: "正在检查…",
    inspectedAt: "检查于",
    neverInspected: "尚未检查",
    overallLabels: {
      healthy: "状态良好",
      attention: "需要留意",
      unsafe: "存在风险"
    },
    severityLabels: {
      info: "通过",
      warning: "提醒",
      danger: "风险"
    },
    sections: {
      bridge: "桥接与令牌",
      proxy: "代理与并发",
      browser: "浏览器会话",
      network: "网络暴露摘要",
      checks: "逐项检查结果"
    },
    bridgeFields: {
      origin: "服务地址",
      listenIsLoopback: "仅监听本机回环",
      tokenRequired: "会话令牌校验",
      allowedOrigins: "允许的来源",
      securityHeaders: "安全响应头",
      timeouts: "连接超时保护"
    },
    proxyFields: {
      requestBodyMaxBytes: "请求体大小上限",
      maxConcurrentRequests: "并发请求上限",
      activeRequests: "当前进行中请求"
    },
    browserFields: {
      browserReady: "自动化浏览器",
      sessions: "活动会话 / 上限",
      sessionIdleTtlMs: "空闲会话回收",
      headless: "无头模式"
    },
    networkFields: {
      interfaceCount: "检测到的网卡数",
      nonLoopbackAddressCount: "非回环地址数量",
      addressCounts: "地址范围计数"
    },
    valueLabels: {
      yes: "已开启",
      no: "未开启",
      none: "无",
      ready: "就绪",
      notReady: "未启动",
      headlessOn: "无界面",
      headlessOff: "有界面"
    },
    loadingTitle: "正在读取本机安全状态",
    loadingText: "正在向本地工具桥发起只读检查，不会扫描磁盘或执行命令。",
    errorTitle: "暂时无法获取安全状态",
    errorTextPrefix: "本地工具桥没有返回有效结果",
    errorCodeLabel: "错误码",
    privacyNote: "本面板只做只读检查：不执行命令、不扫描磁盘、不返回真实网卡 IP。"
  },
  "en-US": {
    eyebrow: "Local runtime",
    title: "Security status",
    close: "Close security status panel",
    refresh: "Check again",
    refreshing: "Checking…",
    inspectedAt: "Checked at",
    neverInspected: "Not checked yet",
    overallLabels: {
      healthy: "Healthy",
      attention: "Attention",
      unsafe: "At risk"
    },
    severityLabels: {
      info: "Pass",
      warning: "Notice",
      danger: "Risk"
    },
    sections: {
      bridge: "Bridge & token",
      proxy: "Proxy & concurrency",
      browser: "Browser sessions",
      network: "Network exposure summary",
      checks: "Detailed checks"
    },
    bridgeFields: {
      origin: "Service address",
      listenIsLoopback: "Loopback-only listening",
      tokenRequired: "Session token required",
      allowedOrigins: "Allowed origins",
      securityHeaders: "Security headers",
      timeouts: "Connection timeouts"
    },
    proxyFields: {
      requestBodyMaxBytes: "Request body limit",
      maxConcurrentRequests: "Concurrency limit",
      activeRequests: "Active requests"
    },
    browserFields: {
      browserReady: "Automation browser",
      sessions: "Active / max sessions",
      sessionIdleTtlMs: "Idle session recycle",
      headless: "Headless mode"
    },
    networkFields: {
      interfaceCount: "Network interfaces",
      nonLoopbackAddressCount: "Non-loopback addresses",
      addressCounts: "Address range counts"
    },
    valueLabels: {
      yes: "On",
      no: "Off",
      none: "None",
      ready: "Ready",
      notReady: "Not started",
      headlessOn: "Headless",
      headlessOff: "Headed"
    },
    loadingTitle: "Reading local security status",
    loadingText: "Running a read-only check against the local tool bridge. No disk scans or commands are executed.",
    errorTitle: "Security status unavailable",
    errorTextPrefix: "The local tool bridge did not return a valid result",
    errorCodeLabel: "Error code",
    privacyNote: "This panel is read-only: no commands, no disk scans, and no real NIC IPs are returned."
  }
};

export function getSecurityStatusCopy(language: SettingsLanguage): SecurityStatusCopy {
  return SECURITY_STATUS_COPY[language];
}

export type { SecurityStatusCopy, SecuritySeverityLabel, LocalRuntimeSecurityCheck };

/** 打开面板时同步一次设置语言；语言切换后由调用方触发重渲染。 */
export function loadSecurityPanelLanguage(): SettingsLanguage {
  return loadSettingsLanguage();
}
