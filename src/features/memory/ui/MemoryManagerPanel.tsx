// VOID 记忆系统 —— 记忆管理面板
// 职责：双栏展示本地记忆（左筛选 / 右卡片），支持搜索、单条删除、分区/全部清空。
// 只消费 memoryStore 的读写 API，不做分类 / 召回 / 投影。
// 视觉对齐设置模态的中性深色玻璃体系（base.css .memory-manager*）。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryEntry, MemoryType } from "../memoryTypes";
import { MEMORY_TYPES } from "../memoryTypes";
import { listMemories, removeMemory, clearMemories } from "../memoryStore";
import {
  loadSettingsLanguage,
  saveSettingsLanguage,
  type SettingsLanguage
} from "../../settings/settingsI18n";
import {
  formatMemoryTimestamp,
  getMemoryManagerCopy
} from "./memoryManagerI18n";

interface MemoryManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

type ConfirmState =
  | { kind: "none" }
  | { kind: "clear-all" }
  | { kind: "clear-section"; memoryType: MemoryType };

const ALL_CATEGORY = "all" as const;
type CategoryId = typeof ALL_CATEGORY | MemoryType;

export function MemoryManagerPanel({ isOpen, onClose }: MemoryManagerPanelProps) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [language, setLanguage] = useState<SettingsLanguage>(() => loadSettingsLanguage());
  const [selectedCategory, setSelectedCategory] = useState<CategoryId>(ALL_CATEGORY);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmState, setConfirmState] = useState<ConfirmState>({ kind: "none" });

  const copy = getMemoryManagerCopy(language);

  // 打开时从本地存储加载最新记忆快照，并同步设置页语言。
  const refresh = useCallback(() => {
    setEntries(listMemories());
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setLanguage(loadSettingsLanguage());
    setSelectedCategory(ALL_CATEGORY);
    setSearchQuery("");
    setConfirmState({ kind: "none" });
    refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmState.kind !== "none") {
          setConfirmState({ kind: "none" });
          return;
        }
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmState.kind, isOpen, onClose]);

  // 左侧分区：全部始终显示；其它分区仅在有条目时显示。
  const categoryStats = useMemo(() => {
    return MEMORY_TYPES.map((type) => ({
      id: type as CategoryId,
      label: copy.typeLabels[type],
      count: entries.filter((entry) => entry.memoryType === type).length
    })).filter((item) => item.count > 0);
  }, [copy.typeLabels, entries]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return entries.filter((entry) => {
      if (selectedCategory !== ALL_CATEGORY && entry.memoryType !== selectedCategory) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const haystack = [
        entry.content,
        entry.subjectName,
        copy.subjectLabels[entry.subjectType],
        copy.typeLabels[entry.memoryType],
        entry.source
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [copy.subjectLabels, copy.typeLabels, entries, searchQuery, selectedCategory]);

  const activeSectionLabel =
    selectedCategory === ALL_CATEGORY ? copy.all : copy.typeLabels[selectedCategory];

  const handleLanguageChange = (nextLanguage: SettingsLanguage) => {
    setLanguage(nextLanguage);
    saveSettingsLanguage(nextLanguage);
  };

  const handleRemoveOne = useCallback(
    (id: string) => {
      removeMemory(id);
      refresh();
    },
    [refresh]
  );

  const handleConfirmClear = useCallback(() => {
    if (confirmState.kind === "clear-all") {
      clearMemories();
      setSelectedCategory(ALL_CATEGORY);
    }

    if (confirmState.kind === "clear-section") {
      listMemories()
        .filter((entry) => entry.memoryType === confirmState.memoryType)
        .forEach((entry) => removeMemory(entry.id));

      // 清空当前分区后回到「全部」，避免停在空分区。
      setSelectedCategory(ALL_CATEGORY);
    }

    setConfirmState({ kind: "none" });
    refresh();
  }, [confirmState, refresh]);

  if (!isOpen) {
    return null;
  }

  const hasAnyEntries = entries.length > 0;
  const hasVisibleEntries = filteredEntries.length > 0;
  const isSearching = searchQuery.trim().length > 0;
  const canClearSection = selectedCategory !== ALL_CATEGORY && filteredEntries.length > 0;

  return (
    <div className="memory-manager" role="presentation" onMouseDown={onClose}>
      <div
        className="memory-manager__panel"
        role="dialog"
        aria-label={copy.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="memory-manager__header">
          <div className="memory-manager__title-group">
            <div className="memory-manager__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3c-4.97 0-9 2.239-9 5v8c0 2.761 4.03 5 9 5s9-2.239 9-5V8c0-2.761-4.03-5-9-5z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8c0 2.761 4.03 5 9 5s9-2.239 9-5" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 13c0 2.761 4.03 5 9 5s9-2.239 9-5" />
              </svg>
            </div>
            <div>
              <p className="memory-manager__eyebrow">{copy.eyebrow}</p>
              <h2>{copy.title}</h2>
            </div>
          </div>
          <button
            className="memory-manager__close"
            type="button"
            aria-label={copy.close}
            onClick={onClose}
          />
        </div>

        <div className="memory-manager__body">
          <aside className="memory-manager__sidebar">
            <div className="memory-manager__search">
              <svg
                className="memory-manager__search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
              </svg>
              <input
                type="search"
                value={searchQuery}
                placeholder={copy.searchPlaceholder}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>

            <div>
              <div className="memory-manager__sidebar-label">{copy.all}</div>
              <div className="memory-manager__category-list">
                <button
                  type="button"
                  className={`memory-manager__category-card${
                    selectedCategory === ALL_CATEGORY ? " is-active" : ""
                  }`}
                  onClick={() => setSelectedCategory(ALL_CATEGORY)}
                >
                  <span>{copy.all}</span>
                  <span className="memory-manager__category-count">{entries.length}</span>
                </button>

                {categoryStats.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`memory-manager__category-card${
                      selectedCategory === category.id ? " is-active" : ""
                    }`}
                    onClick={() => setSelectedCategory(category.id)}
                  >
                    <span>{category.label}</span>
                    <span className="memory-manager__category-count">{category.count}</span>
                  </button>
                ))}
              </div>
            </div>

            {hasAnyEntries ? (
              <button
                type="button"
                className="memory-manager__clear-all"
                onClick={() => setConfirmState({ kind: "clear-all" })}
              >
                {copy.clearAll}
              </button>
            ) : null}
          </aside>

          <div className="memory-manager__content">
            <div className="memory-manager__list-header">
              <div className="memory-manager__list-heading">
                <h3 className="memory-manager__list-title">{activeSectionLabel}</h3>
                <span className="memory-manager__count-badge">{filteredEntries.length}</span>
              </div>
              {canClearSection ? (
                <button
                  type="button"
                  className="memory-manager__clear-section"
                  onClick={() =>
                    setConfirmState({
                      kind: "clear-section",
                      memoryType: selectedCategory as MemoryType
                    })
                  }
                >
                  {copy.clearSection}
                </button>
              ) : null}
            </div>

            {hasVisibleEntries ? (
              <div className="memory-manager__list">
                {filteredEntries.map((entry) => (
                  <MemoryCard
                    key={entry.id}
                    entry={entry}
                    language={language}
                    copy={copy}
                    onDelete={() => handleRemoveOne(entry.id)}
                  />
                ))}
              </div>
            ) : (
              <div className="memory-manager__empty">
                <div className="memory-manager__empty-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12h6m-6 4h6M7 4h10a2 2 0 012 2v14l-4-2-4 2-4-2-4 2V6a2 2 0 012-2z"
                    />
                  </svg>
                </div>
                <div>
                  <h4>{isSearching ? copy.emptySearchTitle : copy.emptyTitle}</h4>
                  <p>{isSearching ? copy.emptySearchText : copy.emptyText}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="memory-manager__footer">
          <div className="memory-manager__footer-left">
            <div className="memory-manager__sync">
              <span className="memory-manager__sync-dot" />
              <span>{copy.localSynced}</span>
            </div>
            <div className="memory-manager__lang-switch" aria-label="Language">
              <button
                type="button"
                className={language === "zh-CN" ? "is-active" : ""}
                onClick={() => handleLanguageChange("zh-CN")}
              >
                简
              </button>
              <span>/</span>
              <button
                type="button"
                className={language === "en-US" ? "is-active" : ""}
                onClick={() => handleLanguageChange("en-US")}
              >
                EN
              </button>
            </div>
          </div>

          <div className="memory-manager__actions">
            <button type="button" className="is-primary" onClick={onClose}>
              {copy.done}
            </button>
          </div>
        </div>

        {confirmState.kind !== "none" ? (
          <div className="memory-manager__confirm" role="presentation">
            <div className="memory-manager__confirm-card" role="alertdialog" aria-modal="true">
              <div className="memory-manager__confirm-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                  />
                </svg>
              </div>
              <h3>
                {confirmState.kind === "clear-all"
                  ? copy.confirmClearAllTitle
                  : copy.confirmClearSectionTitle}
              </h3>
              <p>
                {confirmState.kind === "clear-all"
                  ? copy.confirmClearAllText
                  : copy.confirmClearSectionText}
              </p>
              <div className="memory-manager__confirm-actions">
                <button type="button" onClick={() => setConfirmState({ kind: "none" })}>
                  {copy.confirmCancel}
                </button>
                <button type="button" className="is-danger" onClick={handleConfirmClear}>
                  {copy.confirmDanger}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MemoryCard({
  entry,
  language,
  copy,
  onDelete
}: {
  entry: MemoryEntry;
  language: SettingsLanguage;
  copy: ReturnType<typeof getMemoryManagerCopy>;
  onDelete: () => void;
}) {
  const subjectLabel = entry.subjectName
    ? `${copy.subjectLabels[entry.subjectType]}·${entry.subjectName}`
    : copy.subjectLabels[entry.subjectType];

  const confidenceDots = Math.max(0, Math.min(5, Math.round(entry.confidence * 5)));

  return (
    <article className="memory-manager__card">
      <div className="memory-manager__card-top">
        <div className="memory-manager__badges">
          <span className="memory-manager__badge">{subjectLabel}</span>
          <span className={`memory-manager__badge memory-manager__badge--${entry.sensitivity}`}>
            {copy.sensitivityLabels[entry.sensitivity]}
          </span>
        </div>
        <button
          type="button"
          className="memory-manager__delete"
          aria-label={copy.deleteAria}
          onClick={onDelete}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 7h12M9 7V5h6v2m-7 0l1 12h6l1-12" />
          </svg>
        </button>
      </div>

      <p className="memory-manager__card-content">{entry.content}</p>

      <div className="memory-manager__card-meta">
        <span>{formatMemoryTimestamp(entry.createdAt, language)}</span>
        <span className="memory-manager__confidence" title={`${copy.confidence}: ${entry.confidence}`}>
          <span>{copy.confidence}</span>
          <span className="memory-manager__confidence-dots" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} className={index < confidenceDots ? "is-on" : ""} />
            ))}
          </span>
        </span>
      </div>
    </article>
  );
}
