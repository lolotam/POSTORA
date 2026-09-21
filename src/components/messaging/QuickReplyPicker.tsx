import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Zap, Search } from "lucide-react";
import { useWhatsAppQuickReplies } from "@/hooks/useWhatsAppQuickReplies";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface QuickReplyPickerProps {
  onSelect: (message: string) => void;
}

export function QuickReplyPicker({ onSelect }: QuickReplyPickerProps) {
  const { t } = useTranslation("inbox");
  const { data: replies = [] } = useWhatsAppQuickReplies();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const filtered = replies.filter((r) => {
    const q = search.toLowerCase();
    return r.title.toLowerCase().includes(q) || r.message.toLowerCase().includes(q) || (r.shortcut && r.shortcut.toLowerCase().includes(q));
  });

  const handleSelect = (message: string) => {
    onSelect(message);
    setOpen(false);
  };

  if (replies.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9" title={t("quickReply.tooltip", "Quick replies")}>
          <Zap className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="top">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder={t("quickReply.search", "Search quick replies...")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>
        <ScrollArea className="max-h-60">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">{t("quickReply.noMatches", "No matches")}</p>
          ) : (
            <div className="p-1">
              {filtered.map((r) => (
                <button
                  key={r.id}
                  onClick={() => handleSelect(r.message)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-secondary/80 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{r.title}</span>
                    {r.shortcut && <Badge variant="secondary" className="text-[10px] font-mono shrink-0">{r.shortcut}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{r.message}</p>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

interface SlashCommandSuggestionsProps {
  query: string;
  onSelect: (message: string) => void;
  visible: boolean;
}

export function SlashCommandSuggestions({ query, onSelect, visible }: SlashCommandSuggestionsProps) {
  const { data: replies = [] } = useWhatsAppQuickReplies();

  if (!visible || !query.startsWith("/") || replies.length === 0) return null;

  const search = query.toLowerCase();
  const filtered = replies.filter((r) => r.shortcut && r.shortcut.toLowerCase().startsWith(search));

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-popover border rounded-md shadow-md z-50 max-h-40 overflow-y-auto">
      <div className="p-1">
        {filtered.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.message)}
            className="w-full text-left px-3 py-2 rounded-md hover:bg-secondary/80 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] font-mono">{r.shortcut}</Badge>
              <span className="text-sm truncate">{r.title}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
