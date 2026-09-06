import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Search, MessageCircle, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { Conversation } from "@/hooks/useMessaging";
import { formatListTime } from "@/features/whatsapp-inbox";
import { ConversationLabelChips, ConversationLabelPicker } from "./ConversationLabels";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  onSelect: (conv: Conversation) => void;
  isLoading: boolean;
  showLabels?: boolean;
  // Selection is opt-in and every prop below is optional, so the Facebook, Instagram and
  // Brand Intelligence call sites pass nothing and render exactly as before.
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (conv: Conversation) => void;
  onFilteredChange?: (conversations: Conversation[]) => void;
  /** Controlled search: the owner sends it to the server, so no local filtering happens. */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** WhatsApp style: HH:mm today, dd/MM/yy otherwise. Default keeps the relative label. */
  absoluteTimes?: boolean;
  /** Hover trash on each row; omitted hides it. */
  onDelete?: (conv: Conversation) => void;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  isLoading,
  showLabels,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onFilteredChange,
  search,
  onSearchChange,
  absoluteTimes,
  onDelete,
}: ConversationListProps) {
  const [localSearch, setLocalSearch] = useState("");
  const controlled = search !== undefined && onSearchChange !== undefined;
  const searchValue = controlled ? search : localSearch;
  const setSearch = controlled ? onSearchChange : setLocalSearch;

  const filtered = !controlled && searchValue
    ? conversations.filter((c) => c.participant_name.toLowerCase().includes(searchValue.toLowerCase()))
    : conversations;

  // Select-all must apply to what the user can actually see, so the owner of the selection
  // needs the filtered list rather than the full one.
  useEffect(() => {
    onFilteredChange?.(filtered);
  }, [filtered, onFilteredChange]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchValue}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <MessageCircle className="w-8 h-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">
              {searchValue ? "No conversations match your search" : "No conversations yet"}
            </p>
          </div>
        ) : (
          filtered.map((conv) => (
            <div key={conv.id} className="group relative">
              {onDelete && (
                <button
                  type="button"
                  aria-label={`Delete chat with ${conv.participant_name}`}
                  className="absolute right-1 top-1 z-10 rounded p-1 text-destructive opacity-0 hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(conv);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            <button
              onClick={() => (selectionMode ? onToggleSelect?.(conv) : onSelect(conv))}
              aria-pressed={selectionMode ? selectedIds?.has(conv.id) === true : undefined}
              className={cn(
                "w-full flex items-start gap-3 p-3 text-left hover:bg-accent/50 transition-colors border-b",
                selectedId === conv.id && "bg-accent",
                conv.unread_count > 0 && "font-medium"
              )}
            >
              {selectionMode && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-3 h-4 w-4 shrink-0 rounded-sm border",
                    selectedIds?.has(conv.id)
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40",
                  )}
                />
              )}
              <Avatar className="h-10 w-10 shrink-0">
                <AvatarImage src={conv.participant_avatar || undefined} alt={conv.participant_name} />
                <AvatarFallback className="bg-primary/10 text-primary text-sm">
                  {conv.participant_name?.charAt(0)?.toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className={cn("text-sm truncate", conv.unread_count > 0 && "font-semibold")}>
                    {conv.participant_name}
                  </span>
                  <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                    {!conv.last_message_time
                      ? ""
                      : absoluteTimes
                        ? formatListTime(conv.last_message_time)
                        : formatDistanceToNow(new Date(conv.last_message_time), { addSuffix: true })}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{conv.last_message}</p>
                {showLabels && <ConversationLabelChips conversationId={conv.id} />}
              </div>
              {showLabels && <ConversationLabelPicker conversationId={conv.id} />}
              {conv.unread_count > 0 && (
                <span className="bg-primary text-primary-foreground text-[10px] rounded-full h-5 min-w-[20px] flex items-center justify-center px-1 shrink-0">
                  {conv.unread_count}
                </span>
              )}
            </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
