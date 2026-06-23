import { Icon } from "@iconify/react";
import type { CSSProperties, FormEvent } from "react";
import type { VoidConversationMessage } from "../agent/voidConversation";

type ExpandedDialogueLineProps = {
  message: VoidConversationMessage;
  index: number;
  canEdit: boolean;
  copiedMessageIndex: number | null;
  editingMessageIndex: number | null;
  editingDraft: string;
  isRegenerating: boolean;
  onCopy: (message: VoidConversationMessage, index: number) => void;
  onStartEdit: (index: number, content: string) => void;
  onCancelEdit: () => void;
  onEditingDraftChange: (draft: string) => void;
  onSubmitEdit: (index: number, content: string) => void;
};

export function ExpandedDialogueLine({
  message,
  index,
  canEdit,
  copiedMessageIndex,
  editingMessageIndex,
  editingDraft,
  isRegenerating,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onEditingDraftChange,
  onSubmitEdit
}: ExpandedDialogueLineProps) {
  const speakerLabel = message.role === "user" ? "You" : "VOID";
  const isCopied = copiedMessageIndex === index;
  const isEditing = editingMessageIndex === index;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmitEdit(index, editingDraft);
  };

  return (
    <article
      className={`expanded-dialogue-line expanded-dialogue-line--${message.role}`}
      style={{ "--line-index": index } as CSSProperties}
    >
      <div className="expanded-dialogue-line__meta">
        <span className="expanded-dialogue-line__speaker">{speakerLabel}</span>
        <div className="expanded-dialogue-line__actions">
          <button
            className="expanded-dialogue-line__icon-button"
            type="button"
            aria-label="复制消息"
            onClick={() => onCopy(message, index)}
          >
            <Icon icon="solar:copy-linear" aria-hidden="true" />
          </button>
          {canEdit ? (
            <button
              className="expanded-dialogue-line__icon-button"
              type="button"
              aria-label="编辑最新消息"
              disabled={isRegenerating}
              onClick={() => onStartEdit(index, message.content)}
            >
              <Icon icon="solar:pen-linear" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {isCopied ? <span className="expanded-dialogue-line__copy-bubble">复制成功</span> : null}

      {isEditing ? (
        <form className="expanded-dialogue-line__edit-form" onSubmit={handleSubmit}>
          <textarea
            value={editingDraft}
            autoFocus
            disabled={isRegenerating}
            onChange={(event) => onEditingDraftChange(event.target.value)}
          />
          <div className="expanded-dialogue-line__edit-actions">
            <button type="button" disabled={isRegenerating} onClick={onCancelEdit}>
              取消
            </button>
            <button type="submit" disabled={isRegenerating || !editingDraft.trim()}>
              <Icon icon="solar:plain-linear" aria-hidden="true" />
              发布
            </button>
          </div>
        </form>
      ) : (
        <p>{message.content}</p>
      )}
    </article>
  );
}
