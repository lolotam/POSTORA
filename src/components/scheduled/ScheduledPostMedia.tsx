import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { Image as ImageIcon, Maximize2, Play, Video as VideoIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getMediaFolderLabel, type MediaFolderOption } from "./scheduledMediaControls";

export interface ScheduledMediaItem {
  id: string;
  url: string;
  kind: "image" | "video";
  folderPath: string;
}

type CachedMediaUrl = Pick<ScheduledMediaItem, "url" | "kind">;

interface ScheduledPostMediaProps {
  mediaFileIds: string[];
  mediaFolders: MediaFolderOption[];
  userId: string;
  onOpen: (items: ScheduledMediaItem[], index: number) => void;
}

// Module-level cache to avoid re-signing on re-renders / card revisits.
const urlCache = new Map<string, CachedMediaUrl>();

async function loadOwnedMediaItems(mediaFileIds: string[], userId: string) {
  const uniqueIds = [...new Set(mediaFileIds)];
  const { data: rows, error } = await supabase
    .from("media_files")
    .select("id, file_path, file_type, storage_bucket, folder_path")
    .eq("user_id", userId)
    .in("id", uniqueIds);

  if (error || !rows) return { items: [], complete: false };

  const resolvedById = new Map<string, ScheduledMediaItem>();
  for (const mediaRow of rows) {
    if (!mediaRow.file_path) continue;
    const cacheKey = `${userId}:${mediaRow.id}`;
    let cached = urlCache.get(cacheKey);
    if (!cached) {
      let url: string | null = mediaRow.storage_bucket === "cloudinary" ? mediaRow.file_path : null;
      if (!url && mediaRow.storage_bucket) {
        const { data: signed } = await supabase.storage
          .from(mediaRow.storage_bucket)
          .createSignedUrl(mediaRow.file_path, 3600);
        url = signed?.signedUrl ?? null;
      }
      if (url) {
        cached = { url, kind: mediaRow.file_type === "video" ? "video" : "image" };
        urlCache.set(cacheKey, cached);
      }
    }
    if (cached) {
      resolvedById.set(mediaRow.id, {
        id: mediaRow.id,
        ...cached,
        folderPath: mediaRow.folder_path || "/",
      });
    }
  }

  const ownedIds = new Set(rows.map((row) => row.id));
  const complete = uniqueIds.every((id) => ownedIds.has(id) && resolvedById.has(id));
  const items = mediaFileIds.map((id) => resolvedById.get(id)).filter(Boolean) as ScheduledMediaItem[];
  return { items, complete };
}

export function ScheduledPostMedia({ mediaFileIds, mediaFolders, userId, onOpen }: ScheduledPostMediaProps) {
  const [items, setItems] = useState<ScheduledMediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingFolder, setSavingFolder] = useState(false);
  const [mediaSetComplete, setMediaSetComplete] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    const ids = (mediaFileIds || []).filter((id) => typeof id === "string");
    if (ids.length === 0) {
      setItems([]);
      return;
    }

    (async () => {
      setLoading(true);
      const loaded = await loadOwnedMediaItems(ids, userId);

      if (cancelled) return;
      setItems(loaded.items);
      setMediaSetComplete(loaded.complete);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [mediaFileIds.join("|"), userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = loading ? mediaFileIds.length : items.length;
  if (mediaFileIds.length === 0) return null;

  const single = count === 1;
  const folderLabel = getMediaFolderLabel(items.map((item) => item.folderPath), mediaFolders);
  const folderPaths = new Set(items.map((item) => item.folderPath));
  const folderValue = folderPaths.size === 1 ? [...folderPaths][0] : "__mixed__";

  const handleFolderChange = async (folderPath: string) => {
    if (!mediaSetComplete) return;
    setSavingFolder(true);
    const ids = mediaFileIds.filter((id) => typeof id === "string");
    const { data: updatedRows, error } = await supabase
      .from("media_files")
      .update({ folder_path: folderPath })
      .eq("user_id", userId)
      .in("id", ids)
      .select("id");

    const expectedIds = new Set(ids);
    const returnedIds = new Set((updatedRows ?? []).map((row) => row.id));
    const fullyUpdated = expectedIds.size === returnedIds.size
      && [...expectedIds].every((id) => returnedIds.has(id));

    if (error || !fullyUpdated) {
      const authoritative = await loadOwnedMediaItems(ids, userId);
      setItems(authoritative.items);
      setMediaSetComplete(authoritative.complete);
      toast({
        title: "Folder update failed",
        description: error?.message || "Not all media files could be moved.",
        variant: "destructive",
      });
    } else {
      const updated = items.map((item) => ({ ...item, folderPath }));
      setItems(updated);
      toast({ title: "Media moved", description: "All post media were moved successfully." });
    }
    setSavingFolder(false);
  };

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
          {!loading && mediaSetComplete && items.length > 0 && (
            <Select value={folderValue} onValueChange={handleFolderChange} disabled={savingFolder}>
              <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Media folder">
                <SelectValue placeholder={folderLabel} />
              </SelectTrigger>
              <SelectContent>
                {folderValue === "__mixed__" && (
                  <SelectItem value="__mixed__" disabled>Multiple folders</SelectItem>
                )}
                <SelectItem value="/">Media Library</SelectItem>
                {[...mediaFolders]
                  .sort((a, b) => a.full_path.localeCompare(b.full_path))
                  .map((folder) => (
                    <SelectItem key={folder.full_path} value={folder.full_path}>
                      {folder.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          {!loading && !mediaSetComplete && (
            <span className="text-xs text-muted-foreground">Some media unavailable</span>
          )}
        </div>

        <div className={cn("flex gap-2", !single && "overflow-x-auto snap-x snap-mandatory pb-1")}>
          {loading && items.length === 0 &&
            Array.from({ length: Math.min(mediaFileIds.length, 10) }).map((_, i) => (
              <div
                key={`sk-${i}`}
                className={cn(tileBase, tileSize, "animate-pulse")}
              />
            ))}

          {items.slice(0, 10).map((m, i) => (
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
                    "snap-start cursor-zoom-in transition-transform hover:scale-[1.03] hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
