import { useState } from "react";
import { Pin } from "lucide-react";
import type { WhatsAppPinnedMessage } from "../application/ports";

interface PinnedMessagesBarProps {
  pinned: WhatsAppPinnedMessage[];
  loadedIds: ReadonlySet<string>;
  onScrollTo(messageRowId: string): void;
}

export function PinnedMessagesBar({
  pinned,
  loadedIds,
  onScrollTo,
}: PinnedMessagesBarProps): JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (pinned.length === 0) return null;

  return (
    <div data-testid="wa-pinned-bar" className="border-b bg-muted/40 px-4 py-2">
      <p className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Pin className="h-3 w-3" />
        Pinned
      </p>
      <ul className="space-y-1">
        {pinned.map((item) => {
          const loaded = loadedIds.has(item.message_row_id);
          const expanded = expandedId === item.message_row_id;
          return (
            <li key={item.message_row_id}>
              <button
                type="button"
                className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
                onClick={() => {
                  if (loaded) {
                    onScrollTo(item.message_row_id);
                    setExpandedId(null);
                    return;
                  }
                  setExpandedId(expanded ? null : item.message_row_id);
                }}
              >
                {item.preview || "Pinned message"}
              </button>
              {expanded && !loaded ? (
                <div className="mt-1 rounded-md bg-background px-2 py-2 text-sm">
                  <p className="whitespace-pre-wrap">{item.preview}</p>
                  <p className="mt-1 text-[11px] italic text-muted-foreground">
                    not loaded in this view
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
