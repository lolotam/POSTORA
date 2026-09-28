import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCdnConfig } from "@/hooks/useCdnConfig";
import { resolveMediaPublicUrl } from "@/lib/mediaUrl";
import {
  downloadNameFor,
  libraryFilePresentation,
  librarySearchText,
  matchesLibraryFilter,
  type LibraryFilter,
} from "@/lib/mediaTypes";
import { FileTypeTile } from "@/components/media/FileTypeTile";
import { cn } from "@/lib/utils";

/**
 * Every stored kind is listed here — unlike MediaLibraryPicker, which only
 * allows postable files. Queries with an explicit user_id filter so admins
 * see only their own files.
 */
export interface ScheduleLibraryFile {
  id: string;
  file_path: string;
  file_type: string;
  file_size: number | null;
  mime_type: string | null;
  metadata: { kind?: unknown; original_filename?: unknown } | null;
  storage_bucket: string | null;
  current_object_version: number | null;
  media_file_providers?: Array<{ provider: string; object_version: number; status: string; delivery_url?: string | null }>;
}

interface ScheduleLibraryPickerProps {
  active: boolean;
  selectedId: string | null;
  onPick: (file: ScheduleLibraryFile, url: string) => void;
}

const FILTERS: Array<{ value: LibraryFilter; key: string; fallback: string }> = [
  { value: "all", key: "libraryAll", fallback: "All" },
  { value: "image", key: "libraryImages", fallback: "Images" },
  { value: "video", key: "libraryVideos", fallback: "Videos" },
  { value: "audio", key: "libraryAudio", fallback: "Audio" },
  { value: "document", key: "libraryDocuments", fallback: "Documents" },
  { value: "archive", key: "libraryArchives", fallback: "Archives" },
];

export function ScheduleLibraryPicker({ active, selectedId, onPick }: ScheduleLibraryPickerProps) {
  const { t } = useTranslation("inbox");
  const { session } = useAuth();
  const userId = session?.user?.id;
  const { data: cdnConfig } = useCdnConfig();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");

  const query = useQuery({
    queryKey: ["whatsapp-schedule-library", userId],
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, file_size, mime_type, metadata, storage_bucket, current_object_version, media_file_providers(provider, object_version, status, delivery_url)")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as ScheduleLibraryFile[];
    },
    enabled: !!userId && active,
  });

  const files = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data ?? []).filter((file) =>
      matchesLibraryFilter(file, filter)
      && (!needle || librarySearchText(file).includes(needle)));
  }, [query.data, search, filter]);

  const resolveUrl = (file: ScheduleLibraryFile): string =>
    // The untransformed delivery URL — never a thumbnail rendition.
    resolveMediaPublicUrl(
      file,
      (bucket, path) => supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl,
      file.media_file_providers,
      cdnConfig,
    );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("scheduled.librarySearch", "Search files")}
            className="h-9 ps-8"
          />
        </div>
        <Select value={filter} onValueChange={(value) => setFilter(value as LibraryFilter)}>
          <SelectTrigger className="h-9 w-32" aria-label={t("scheduled.libraryFilter", "Kind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map(({ value, key, fallback }) => (
              <SelectItem key={value} value={value}>{t(`scheduled.${key}`, fallback)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {query.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {t("scheduled.libraryError", "Couldn't load your library.")}
        </p>
      ) : files.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          {t("scheduled.libraryEmpty", "No files match.")}
        </p>
      ) : (
        <ScrollArea className="h-56">
          <div className="space-y-1 pe-2">
            {files.map((file) => {
              const name = downloadNameFor(file);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onPick(file, resolveUrl(file))}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border p-2 text-start transition-colors",
                    selectedId === file.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                  )}
                >
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md">
                    <FileTypeTile {...libraryFilePresentation(file)} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
