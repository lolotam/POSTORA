import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Loader2, Check, Clock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBrandSearchHistory, type BrandSearchScope } from "@/hooks/useBrandSearchHistory";

interface BrandSearchBarProps {
  platform: string;
  onSearch: (username: string) => void;
  isLoading: boolean;
  /** Required to persist & show per-tab search history. */
  scope?: BrandSearchScope;
}

function extractUsername(input: string, platform: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const igRegex = /(?:instagram\.com|instagr\.am)\/([a-zA-Z0-9_.]+)/;
  const threadsRegex = /threads\.net\/@?([a-zA-Z0-9_.]+)/;
  const fbRegex = /(?:facebook\.com|fb\.com)\/([a-zA-Z0-9_.]+)/;
  const tiktokRegex = /tiktok\.com\/@?([a-zA-Z0-9_.]+)/;

  if (platform === "instagram") {
    const match = trimmed.match(igRegex);
    if (match) return match[1];
  }
  if (platform === "threads") {
    const match = trimmed.match(threadsRegex);
    if (match) return match[1];
  }
  if (platform === "facebook") {
    const match = trimmed.match(fbRegex);
    if (match) return match[1];
  }
  if (platform === "tiktok") {
    const match = trimmed.match(tiktokRegex);
    if (match) return match[1];
  }

  const clean = trimmed.replace(/^@/, "").toLowerCase();
  if (/^[a-zA-Z0-9_.]{1,30}$/.test(clean)) return clean;

  return null;
}

export function BrandSearchBar({ platform, onSearch, isLoading, scope }: BrandSearchBarProps) {
  const { t } = useTranslation("analytics");
  const [input, setInput] = useState("");
  const [parsed, setParsed] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  const history = useBrandSearchHistory(platform, scope ?? "analyze");
  const showHistory = !!scope && history.items.length > 0;

  const placeholders: Record<string, string> = {
    instagram: t("form.placeholderInstagram", "Enter @username or instagram.com/username"),
    threads: t("form.placeholderThreads", "Enter @username or threads.net/username"),
    facebook: t("form.placeholderFacebook", "Enter page name or facebook.com/pagename"),
    tiktok: t("form.placeholderTiktok", "Enter @username or tiktok.com/@username"),
  };
  const placeholder = placeholders[platform] || placeholders.instagram;

  const runSearch = (value: string) => {
    const username = extractUsername(value, platform);
    if (!username) {
      setInvalid(true);
      setParsed(null);
      setTimeout(() => setInvalid(false), 600);
      return;
    }
    setParsed(username);
    setInvalid(false);
    setOpen(false);
    onSearch(username);
    if (scope) history.save(username).catch(() => undefined);
  };

  const handlePick = (q: string) => {
    setInput(q);
    setParsed(extractUsername(q, platform));
    runSearch(q);
  };

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "flex items-center gap-2",
          invalid && "animate-[shake_0.4s_ease-in-out]",
        )}
      >
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInvalid(false);
              setParsed(extractUsername(e.target.value, platform));
              if (showHistory) setOpen(true);
            }}
            onFocus={() => showHistory && setOpen(true)}
            onBlur={() => {
              blurTimer.current = window.setTimeout(() => setOpen(false), 150);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(input);
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder={placeholder}
            className={cn(
              "ps-10 h-11",
              invalid && "border-destructive ring-destructive",
            )}
          />

          {open && showHistory && (
            <div
              className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-popover text-popover-foreground shadow-lg overflow-hidden"
              onMouseDown={(e) => {
                // prevent input blur from closing before click registers
                if (blurTimer.current) {
                  window.clearTimeout(blurTimer.current);
                  blurTimer.current = null;
                }
                e.preventDefault();
              }}
            >
              <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5 border-b border-border/60">
                <Clock className="w-3 h-3" /> {t("search.recent", "Recent searches")}
              </div>
              <ul className="max-h-64 overflow-y-auto py-1">
                {history.items.map((row) => (
                  <li key={row.id} className="group flex items-center justify-between px-3 py-1.5 hover:bg-accent/60 cursor-pointer">
                    <button
                      type="button"
                      className="flex-1 text-start text-sm truncate"
                      onClick={() => handlePick(row.query)}
                    >
                      @{row.query}
                      {row.use_count > 1 && (
                        <span className="ms-2 text-[10px] text-muted-foreground">×{row.use_count}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={t("search.removeHistory", "Remove from history")}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        history.remove(row.id).catch(() => undefined);
                      }}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <Button
          onClick={() => runSearch(input)}
          disabled={isLoading || !input.trim()}
          className="h-11 px-6 bg-gradient-to-r from-violet-500 to-pink-500 hover:from-violet-600 hover:to-pink-600 text-white border-0"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin me-2" />
          ) : (
            <Search className="w-4 h-4 me-2" />
          )}
          {t("actions.analyze", "Analyze")}
        </Button>
      </div>
      {parsed && !isLoading && (
        <div className="flex items-center gap-1.5 text-sm text-emerald-500">
          <Check className="w-3.5 h-3.5" />
          <span>{t("search.searching", "Searching: @{{username}}", { username: parsed })}</span>
        </div>
      )}
    </div>
  );
}
