// 上下文 Token 预算透明化（只读）
// 职责：轻量预算条，展示 当前占用 / 窗口上限 / 距自动摘要阈值
// 只读消费 modelContextWindows + tokenBudget，不改截断逻辑

import { useMemo } from "react";
import { resolveModelContextWindow } from "./modelContextWindows";
import { estimateTokens } from "./tokenBudget";
import { loadModelConfig } from "../../settings/modelConfig";
import type { VoidConversationMessage } from "../voidConversation";
import { loadCurrentConversationHistory } from "../voidConversation";

type ContextBudgetBarProps = {
  messages?: VoidConversationMessage[];
  compact?: boolean;
};

const AUTO_SUMMARY_THRESHOLD = 0.8;

function formatTokens(value: number): string {
  if (value >= 100000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
}

export function ContextBudgetBar({ messages, compact = false }: ContextBudgetBarProps) {
  const { usedTokens, windowTokens, percent, remainingToThreshold, status } = useMemo(() => {
    const modelName = loadModelConfig().modelName;
    const windowTokens = resolveModelContextWindow(modelName);
    const history = messages ?? loadCurrentConversationHistory();
    const historyText = history.map((m) => m.content).join("\n");
    const usedTokens = estimateTokens(historyText);
    const percent = windowTokens > 0 ? Math.min(1, usedTokens / windowTokens) : 0;
    const thresholdTokens = Math.floor(windowTokens * AUTO_SUMMARY_THRESHOLD);
    const remainingToThreshold = Math.max(0, thresholdTokens - usedTokens);
    const status = percent >= 0.95 ? "danger" : percent >= 0.8 ? "warn" : "ok";
    return { usedTokens, windowTokens, percent, remainingToThreshold, status };
  }, [messages]);

  const barPercent = Math.round(percent * 100);
  const thresholdTokens = Math.floor(windowTokens * AUTO_SUMMARY_THRESHOLD);
  const willSummarize = percent >= AUTO_SUMMARY_THRESHOLD;
  const tip =
    percent >= 0.95
      ? `已超阈值，将自动摘要早期轮次（阈值 ${formatTokens(thresholdTokens)}）`
      : percent >= 0.8
        ? `已达阈值，超出将自动摘要早期轮次（阈值 ${formatTokens(thresholdTokens)}）`
        : `距自动摘要阈值还剩约 ${formatTokens(remainingToThreshold)} tokens（阈值 ${formatTokens(thresholdTokens)}）`;
  const detailTitle = willSummarize
    ? "上下文已达 80% 阈值，后续请求将把更早轮次折叠为工作摘要（不写入长期记忆），近窗保留最新轮次原文"
    : `当前 ${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}，80% 阈值约 ${formatTokens(thresholdTokens)}，越过后自动折叠早期轮次为工作摘要`;

  return (
    <div className={`context-budget-bar${compact ? " is-compact" : ""} is-${status}`} role="status" aria-label="上下文预算" title={detailTitle}>
      <div className="context-budget-bar__row">
        <span className="context-budget-bar__label">上下文</span>
        <span className="context-budget-bar__value">
          {formatTokens(usedTokens)} / {formatTokens(windowTokens)} · {barPercent}%
        </span>
        <span className={`context-budget-bar__tip is-${status}`}>{willSummarize ? "⚠ " : ""}{tip}</span>
      </div>
      <div className="context-budget-bar__track" aria-hidden="true">
        <div
          className={`context-budget-bar__fill is-${status}${willSummarize ? " is-pulsing" : ""}`}
          style={{ width: `${Math.min(100, barPercent)}%` }}
        />
        <span className="context-budget-bar__threshold" style={{ left: `${AUTO_SUMMARY_THRESHOLD * 100}%` }} title={`自动摘要阈值 ${AUTO_SUMMARY_THRESHOLD * 100}%`} />
        <span className="context-budget-bar__threshold-label" style={{ left: `${AUTO_SUMMARY_THRESHOLD * 100}%` }}>摘要</span>
      </div>
    </div>
  );
}
