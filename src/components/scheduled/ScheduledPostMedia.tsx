import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Image as ImageIcon, Maximize2, Play, Video as VideoIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export interface ScheduledMediaItem {
  id: string;
  url: string;
  kind: "image" | "video";
}

interface ScheduledPostMediaProps {
  mediaFileIds: string[];
  onOpen: (items: ScheduledMediaItem[], index: number) => void;
}

// Module-level cache to avoid re-signing on re-renders / card revisits.
const urlCache = new Map<string, ScheduledMediaItem>();

export function ScheduledPostMedia({ mediaFileIds, onOpen }: ScheduledPostMediaProps) {
  const [items, setItems] = useState<ScheduledMediaItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const ids = (mediaFileIds || []).filter((id) => typeof id === "string");
    if (ids.length === 0) {
      setItems([]);
      return;
    }

    // Serve from cache immediately when possible.
    const cached = ids.map((id) => urlCache.get(id)).filter(Boolean) as ScheduledMediaItem[];
    if (cached.length === ids.length) {
      setItems(cached);
      return;
    }

    (async () => {
      setLoading(true);
      const missing = ids.filter((id) => !urlCache.has(id));
      const { data: rows, error } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, storage_bucket")
        .in("id", missing);

      if (!error && rows) {
        for (const m of rows) {
          if (!m.file_path) continue;
          let url: string | null = null;
          if (m.storage_bucket === "cloudinary") {
            url = m.file_path;
          } else if (m.storage_bucket) {
            const { data: signed } = await supabase.storage
              .from(m.storage_bucket)
              .createSignedUrl(m.file_path, 3600);
            url = signed?.signedUrl ?? null;
          }
          if (url) {
            urlCache.set(m.id, {
              id: m.id,
              url,
              kind: m.file_type === "video" ? "video" : "image",
            });
          }
        }
      }

      if (cancelled) return;
      const resolved = ids.map((id) => urlCache.get(id)).filter(Boolean) as ScheduledMediaItem[];
      setItems(resolved);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaFileIds.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = items.length || mediaFileIds?.length || 0;
  if (count === 0) return null;

  const single = count === 1;
  const visible = items.slice(0, 4);
  const overflow = items.length - visible.length;

  const tileBase =
    "group/tile relative shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted/40";
  const tileSize = single ? "w-28 h-28" : "w-20 h-20";

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground inline-flex items-center gap-1">
            <ImageIcon className="w-3 h-3" />
            {count} {count === 1 ? "media" : "media"}
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {loading && items.length === 0 &&
            Array.from({ length: Math.min(mediaFileIds.length, 4) }).map((_, i) => (
              <div
                key={`sk-${i}`}
                className={cn(tileBase, tileSize, "animate-pulse")}
              />
            ))}

          {visible.map((m, i) => (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(items, i);
                  }}
                  className={cn(
                    tileBase,
                    tileSize,
                    "cursor-zoom-in transition-transform hover:scale-[1.03] hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  )}
                  aria-label={m.kind === "video" ? "Play video" : "View image"}
                >
                  {m.kind === "video" ? (
                    <>
                      <video
                        src={m.url}
                        className="w-full h-full object-cover"
                        preload="metadata"
                        muted
                        playsInline
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-background/20">
                        <span className="rounded-full bg-background/70 p-1.5 backdrop-blur-sm">
                          <Play className="w-4 h-4 fill-foreground text-foreground" />
                        </span>
                      </div>
                    </>
                  ) : (
                    <img
                      src={m.url}
                      alt="Post media"
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-background/0 opacity-0 transition-all group-hover/tile:bg-background/40 group-hover/tile:opacity-100">
                    <Maximize2 className="w-4 h-4 text-foreground" />
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {m.kind === "video" ? "Play video" : "View larger"}
              </TooltipContent>
            </Tooltip>
          ))}

          {overflow > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen(items, visible.length);
              }}
              className={cn(
                tileBase,
                tileSize,
                "flex items-center justify-center text-sm font-medium text-muted-foreground hover:text-foreground hover:border-primary/50"
              )}
              aria-label={`View ${overflow} more`}
            >
              +{overflow}
            </button>
          )}

          {!loading && items.length === 0 && (
            <div className={cn(tileBase, tileSize, "flex items-center justify-center")}>
              <VideoIcon className="w-5 h-5 text-muted-foreground/60" />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
