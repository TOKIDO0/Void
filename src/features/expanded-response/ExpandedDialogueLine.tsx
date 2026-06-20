import type { CSSProperties } from "react";
import type { VoidConversationMessage } from "../agent/voidConversation";

type ExpandedDialogueLineProps = {
  message: VoidConversationMessage;
  index: number;
};

export function ExpandedDialogueLine({ message, index }: ExpandedDialogueLineProps) {
  const speakerLabel = message.role === "user" ? "You" : "VOID";

  return (
    <article
      className={`expanded-dialogue-line expanded-dialogue-line--${message.role}`}
      style={{ "--line-index": index } as CSSProperties}
    >
      <span className="expanded-dialogue-line__speaker">{speakerLabel}</span>
      <p>{message.content}</p>
    </article>
  );
}
