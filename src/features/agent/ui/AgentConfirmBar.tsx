// 极简确认条：L2/L3 敏感步骤的辅路径。
// 主路径仍是对话/语音；这里不是工具试跑模态，只是一条可点的确认/拒绝条。

import type { CSSProperties } from "react";
import type { ConfirmationRequest } from "../permissions";

type AgentConfirmBarProps = {
  request: ConfirmationRequest;
  onApprove: () => void;
  onReject: () => void;
};

export function AgentConfirmBar({ request, onApprove, onReject }: AgentConfirmBarProps) {
  return (
    <div style={shellStyle} role="alertdialog" aria-labelledby="agent-confirm-bar-title">
      <div style={mainStyle}>
        <p style={eyebrowStyle}>
          需要你的确认 · {request.riskLevel} · {request.toolName}
        </p>
        <h3 id="agent-confirm-bar-title" style={titleStyle}>
          {request.title}
        </h3>
        <pre style={descriptionStyle}>{request.description}</pre>
      </div>
      <div style={actionsStyle}>
        <button type="button" style={rejectStyle} onClick={onReject}>
          拒绝
        </button>
        <button type="button" style={approveStyle} onClick={onApprove}>
          确认
        </button>
      </div>
    </div>
  );
}

const shellStyle: CSSProperties = {
  position: "absolute",
  left: "50%",
  bottom: 108,
  zIndex: 8,
  width: "min(520px, calc(100vw - 40px))",
  transform: "translateX(-50%)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "14px 16px 12px",
  border: "1px solid rgba(255, 215, 138, 0.36)",
  background:
    "linear-gradient(135deg, rgba(255, 220, 150, 0.08), rgba(16, 57, 75, 0.34) 40%, rgba(3, 13, 20, 0.92)), rgba(5, 20, 29, 0.92)",
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.48)",
  color: "rgba(235, 252, 255, 0.94)",
  backdropFilter: "blur(18px) saturate(1.15)",
  WebkitBackdropFilter: "blur(18px) saturate(1.15)",
  pointerEvents: "auto"
};

const mainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: "rgba(255, 220, 160, 0.72)"
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 520,
  lineHeight: 1.3
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  maxHeight: 120,
  overflowY: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: 1.5,
  color: "rgba(210, 240, 255, 0.86)"
};

const actionsStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8
};

const rejectStyle: CSSProperties = {
  border: "1px solid rgba(255, 154, 103, 0.35)",
  padding: "7px 14px",
  background: "rgba(60, 20, 10, 0.42)",
  color: "rgba(255, 210, 180, 0.92)",
  fontSize: 13,
  cursor: "pointer"
};

const approveStyle: CSSProperties = {
  border: "1px solid rgba(132, 226, 255, 0.4)",
  padding: "7px 16px",
  background: "rgba(86, 167, 255, 0.2)",
  color: "rgba(230, 250, 255, 0.95)",
  fontSize: 13,
  cursor: "pointer"
};
