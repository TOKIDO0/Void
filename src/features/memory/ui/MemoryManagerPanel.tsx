// VOID 记忆系统 —— 记忆管理面板（只建不挂载）
// 职责：按分区分组展示本地记忆条目，支持删除单条 / 清空某个分区。
// 只消费 memoryStore 的读写 API，不做分类 / 召回 / 投影。
// 视觉对齐现有 ModelSettingsModal（深青玻璃、直角、青色描边），此处用内联样式自包含，
// 不耦合共享样式表。挂载点在 VoidStage（属窗口 A），收尾串行阶段再接（21 号 §0.3 铁律 4）。

import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryEntry } from "../memoryTypes";
import {
  MEMORY_TYPES,
  MEMORY_TYPE_LABELS,
  SUBJECT_TYPE_LABELS,
  SENSITIVITY_LABELS
} from "../memoryTypes";
import { listMemories, removeMemory, clearMemories } from "../memoryStore";

interface MemoryManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MemoryManagerPanel({ isOpen, onClose }: MemoryManagerPanelProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);

  // 打开时从本地存储加载最新记忆快照。
  const refresh = useCallback(() => {
    setEntries(listMemories());
  }, []);

  useEffect(() => {
    if (isOpen) {
      refresh();
    }
  }, [isOpen, refresh]);

  // 按分区顺序分组：只保留有条目的分区，避免空分区占位。
  const groups = useMemo(() => {
    return MEMORY_TYPES.map((type) => ({
      type,
      label: MEMORY_TYPE_LABELS[type],
      items: entries.filter((entry) => entry.memoryType === type)
    })).filter((group) => group.items.length > 0);
  }, [entries]);

  const handleRemoveOne = useCallback(
    (id: string) => {
      removeMemory(id);
      refresh();
    },
    [refresh]
  );

  const handleClearGroup = useCallback(
    (type: MemoryEntry["memoryType"]) => {
      listMemories()
        .filter((entry) => entry.memoryType === type)
        .forEach((entry) => removeMemory(entry.id));
      refresh();
    },
    [refresh]
  );

  // 清空全部记忆：破坏性操作，先二次确认再执行。
  const handleClearAll = useCallback(() => {
    const confirmed = window.confirm("确定要清空全部记忆吗？此操作不可撤销。");
    if (!confirmed) {
      return;
    }
    clearMemories();
    refresh();
  }, [refresh]);

  if (!isOpen) {
    return null;
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <div>
            <p style={eyebrowStyle}>本地长期记忆</p>
            <h2 style={titleStyle}>记忆管理</h2>
          </div>
          <button style={closeButtonStyle} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {groups.length === 0 ? (
            <p style={emptyStyle}>暂无任何记忆条目。</p>
          ) : (
            groups.map((group) => (
              <section key={group.type} style={groupStyle}>
                <div style={groupHeaderStyle}>
                  <span style={groupTitleStyle}>
                    {group.label}
                    <span style={groupCountStyle}>{group.items.length}</span>
                  </span>
                  <button style={clearButtonStyle} onClick={() => handleClearGroup(group.type)}>
                    清空本区
                  </button>
                </div>

                <ul style={listStyle}>
                  {group.items.map((entry) => (
                    <li key={entry.id} style={itemStyle}>
                      <div style={itemMainStyle}>
                        <div style={itemMetaRowStyle}>
                          <span style={subjectBadgeStyle}>
                            {SUBJECT_TYPE_LABELS[entry.subjectType]}
                            {entry.subjectName ? `·${entry.subjectName}` : ""}
                          </span>
                          <span style={sensitivityBadgeStyle(entry.sensitivity)}>
                            {SENSITIVITY_LABELS[entry.sensitivity]}
                          </span>
                        </div>
                        <p style={contentStyle}>{entry.content}</p>
                      </div>
                      <button
                        style={removeButtonStyle}
                        onClick={() => handleRemoveOne(entry.id)}
                        aria-label="删除该条记忆"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {groups.length > 0 && (
          <div style={footerStyle}>
            <button style={clearAllButtonStyle} onClick={handleClearAll}>
              清空全部记忆
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 内联样式：配色对齐 ModelSettingsModal（深青玻璃、直角、青色描边）
// ---------------------------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 8,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background:
    "linear-gradient(180deg, rgba(11, 38, 52, 0.5), rgba(0, 0, 0, 0.58)), rgba(0, 0, 0, 0.36)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)"
};

const panelStyle: CSSProperties = {
  width: "min(720px, calc(100vw - 40px))",
  maxHeight: "calc(100dvh - 48px)",
  display: "flex",
  flexDirection: "column",
  border: "1px solid rgba(132, 226, 255, 0.38)",
  padding: "22px 24px 20px",
  background:
    "linear-gradient(135deg, rgba(172, 238, 255, 0.12), rgba(16, 57, 75, 0.28) 42%, rgba(3, 13, 20, 0.86)), rgba(5, 20, 29, 0.88)",
  boxShadow: "inset 0 1px 0 rgba(188, 244, 255, 0.16), 0 22px 76px rgba(0, 0, 0, 0.5)",
  color: "rgba(235, 252, 255, 0.92)",
  backdropFilter: "blur(24px) saturate(1.2)",
  WebkitBackdropFilter: "blur(24px) saturate(1.2)"
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 18,
  marginBottom: 18
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: "rgba(174, 231, 245, 0.58)",
  fontSize: 12,
  lineHeight: 1.3
};

const titleStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: 22,
  fontWeight: 520,
  lineHeight: 1.2
};

const closeButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  flex: "0 0 auto",
  border: "1px solid rgba(132, 226, 255, 0.28)",
  padding: 0,
  background: "rgba(0, 25, 38, 0.46)",
  color: "rgba(218, 248, 255, 0.8)",
  fontSize: 20,
  lineHeight: 1,
  cursor: "pointer"
};

const bodyStyle: CSSProperties = {
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  paddingRight: 4
};

const emptyStyle: CSSProperties = {
  margin: "12px 0",
  color: "rgba(174, 231, 245, 0.5)",
  fontSize: 13
};

const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10
};

const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  paddingBottom: 6,
  borderBottom: "1px solid rgba(132, 226, 255, 0.18)"
};

const groupTitleStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 520,
  color: "rgba(223, 250, 255, 0.9)"
};

const groupCountStyle: CSSProperties = {
  minWidth: 20,
  height: 18,
  padding: "0 6px",
  display: "inline-grid",
  placeItems: "center",
  background: "rgba(86, 167, 255, 0.14)",
  border: "1px solid rgba(132, 226, 255, 0.24)",
  fontSize: 11,
  color: "rgba(200, 240, 255, 0.85)"
};

const clearButtonStyle: CSSProperties = {
  border: "1px solid rgba(132, 226, 255, 0.24)",
  padding: "4px 10px",
  background: "rgba(0, 20, 30, 0.52)",
  color: "rgba(200, 236, 250, 0.75)",
  fontSize: 12,
  cursor: "pointer"
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8
};

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
  border: "1px solid rgba(132, 226, 255, 0.16)",
  background: "rgba(6, 24, 34, 0.5)"
};

const itemMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0
};

const itemMetaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap"
};

const subjectBadgeStyle: CSSProperties = {
  padding: "1px 7px",
  border: "1px solid rgba(132, 226, 255, 0.22)",
  background: "rgba(0, 20, 30, 0.42)",
  fontSize: 11,
  color: "rgba(196, 236, 250, 0.82)"
};

// 敏感级别徽标：普通青、敏感琥珀、高敏橙红，颜色对齐现有辉光渐变。
function sensitivityBadgeStyle(sensitivity: MemoryEntry["sensitivity"]): CSSProperties {
  const palette: Record<MemoryEntry["sensitivity"], { border: string; color: string }> = {
    normal: { border: "rgba(132, 226, 255, 0.22)", color: "rgba(196, 236, 250, 0.82)" },
    sensitive: { border: "rgba(255, 215, 138, 0.4)", color: "rgba(255, 224, 168, 0.9)" },
    highSensitive: { border: "rgba(255, 154, 103, 0.48)", color: "rgba(255, 184, 150, 0.92)" }
  };
  const tone = palette[sensitivity];
  return {
    padding: "1px 7px",
    border: `1px solid ${tone.border}`,
    background: "rgba(0, 20, 30, 0.3)",
    fontSize: 11,
    color: tone.color
  };
}

const contentStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: "rgba(235, 252, 255, 0.88)",
  wordBreak: "break-word"
};

const removeButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  border: "1px solid rgba(255, 154, 103, 0.4)",
  padding: "4px 10px",
  background: "rgba(40, 14, 10, 0.4)",
  color: "rgba(255, 190, 160, 0.85)",
  fontSize: 12,
  cursor: "pointer"
};

// 底部全局操作区：与列表用描边分隔，清空全部按钮靠右。
const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: 16,
  paddingTop: 14,
  borderTop: "1px solid rgba(132, 226, 255, 0.18)"
};

const clearAllButtonStyle: CSSProperties = {
  border: "1px solid rgba(255, 154, 103, 0.45)",
  padding: "6px 14px",
  background: "rgba(40, 14, 10, 0.45)",
  color: "rgba(255, 190, 160, 0.9)",
  fontSize: 12,
  cursor: "pointer"
};
