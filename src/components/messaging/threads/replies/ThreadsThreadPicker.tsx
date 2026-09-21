import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, ExternalLink, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useUserThreadsInfinite, type ThreadSummary } from "@/hooks/useThreadsReplies";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface Props {
  accountId: string | null;
  value: ThreadSummary | null;
  onChange: (thread: ThreadSummary | null) => void;
}

export function ThreadsThreadPicker({ accountId, value, onChange }: Props) {
  const { t } = useTranslation("threads");
  const [open, setOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useUserThreadsInfinite(accountId);

  const threads: ThreadSummary[] =
    data?.pages.flatMap((p) => p.data || []) || [];

  // Infinite scroll sentinel
  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          hasNextPage &&
          !isFetchingNextPage &&
          !isLoading
        ) {
          fetchNextPage();
        }
      },
      { rootMargin: "120px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [open, hasNextPage, isFetchingNextPage, isLoading, fetchNextPage]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="w-full sm:w-[360px] justify-between"
          disabled={!accountId}
        >
          <span className="truncate text-start">
            {value
              ? value.text?.slice(0, 60) || t("picker.threadFallback", "Thread {{id}}…", { id: value.id.slice(0, 8) })
              : t("picker.selectThread", "Select a thread to manage replies")}
          </span>
          <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        <ScrollArea className="h-[360px]">
          <div className="p-1 pe-2">
            {isLoading && (
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 me-2 animate-spin" /> {t("picker.loading", "Loading threads…")}
              </div>
            )}

            {error && (
              <div className="p-3 text-sm text-destructive">
                {(error as Error).message || t("errors.failedLoadThreads", "Failed to load threads.")}
              </div>
            )}

            {!isLoading && !error && threads.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {t("empty.noThreads", "No threads found for this account.")}
              </div>
            )}

            {threads.map((thread, idx) => {
              const selected = value?.id === thread.id;
              return (
                <div
                  key={thread.id}
                  className={cn(
                    "w-full px-3 py-2 rounded-sm hover:bg-accent flex items-start gap-2",
                    selected && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onChange(thread);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 flex items-start gap-2 text-start"
                  >
                    <span className="text-xs tabular-nums text-muted-foreground w-6 shrink-0 text-end pt-0.5">
                      {idx + 1}.
                    </span>
                    <Check
                      className={cn(
                        "h-4 w-4 mt-0.5 shrink-0",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm line-clamp-2">
                        {thread.text || <span className="italic text-muted-foreground">{t("picker.mediaPost", "Media post")}</span>}
                      </p>
                      {thread.timestamp && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDistanceToNow(new Date(thread.timestamp), { addSuffix: true })}
                        </p>
                      )}
                    </div>
                  </button>
                  {thread.permalink && (
                    <a
                      href={thread.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="ms-1 inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0 pt-0.5"
                      aria-label={t("actions.viewThreadAria", "View thread on Threads")}
                      title={t("actions.openOnThreads", "Open on Threads")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t("common:view", "View")}
                    </a>
                  )}
                </div>
              );
            })}

            <div ref={sentinelRef} className="h-2" />

            {isFetchingNextPage && (
              <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 me-2 animate-spin" /> {t("picker.loadingMore", "Loading more…")}
              </div>
            )}
          </div>
          <ScrollBar orientation="vertical" className="w-3" />
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
