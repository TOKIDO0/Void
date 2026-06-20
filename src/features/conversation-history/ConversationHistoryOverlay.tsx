import { useEffect } from "react";
import type { VoidConversationMessage } from "../agent/voidConversation";

type ConversationHistoryOverlayProps = {
  isOpen: boolean;
  messages: VoidConversationMessage[];
  onClose: () => void;
};

export function ConversationHistoryOverlay({ isOpen, messages, onClose }: ConversationHistoryOverlayProps) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <section className="conversation-history-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="conversation-history-overlay__panel"
        aria-label="Conversation history"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="conversation-history-overlay__header">
          <div>
            <p className="conversation-history-overlay__eyebrow">Session</p>
            <h2>History</h2>
          </div>
          <button
            className="conversation-history-overlay__close"
            type="button"
            aria-label="Close history"
            onClick={onClose}
          />
        </div>

        {messages.length > 0 ? (
          <div className="conversation-history-overlay__messages">
            {messages.map((message, index) => (
              <article
                className={`conversation-history-overlay__message conversation-history-overlay__message--${message.role}`}
                key={`${message.role}-${index}`}
              >
                <span>{message.role === "user" ? "You" : "VOID"}</span>
                <p>{message.content}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="conversation-history-overlay__empty">No conversation in this session.</p>
        )}
      </div>
    </section>
  );
}
