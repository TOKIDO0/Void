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
  const tip =
    percent >= 0.95
      ? "已接近上限，将自动摘要早期轮次"
      : percent >= 0.8
        ? "将自动摘要早期轮次的中"
        : `距自动摘要阈值还剩约 ${formatTokens(remainingToThreshold)} tokens`;

  return (
    <div className={`context-budget-bar${compact ? " is-compact" : ""}`} role="status" aria-label="上下文预算">
      <div className="context-budget-bar__row">
        <span className="context-budget-bar__label">上下文</span>
        <span className="context-budget-bar__value">
          {formatTokens(usedTokens)} / {formatTokens(windowTokens)} · {barPercent}%
        </span>
        <span className={`context-budget-bar__tip is-${status}`}>{tip}</span>
      </div>
      <div className="context-budget-bar__track" aria-hidden="true">
        <div
          className={`context-budget-bar__fill is-${status}`}
          style={{ width: `${Math.min(100, barPercent)}%` }}
        />
        <span className="context-budget-bar__threshold" style={{ left: `${AUTO_SUMMARY_THRESHOLD * 100}%` }} />
      </div>
    </div>
  );
}
