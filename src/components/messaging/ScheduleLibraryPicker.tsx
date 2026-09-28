import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  MEDIA_TYPES,
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

const LIBRARY_COLUMNS = "id, file_path, file_type, file_size, mime_type, metadata, storage_bucket, current_object_version, media_file_providers(provider, object_version, status, delivery_url)";
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

// Archive rows are stored as file_type "document". metadata.kind is "archive"
// when the uploader recorded it; older rows omit kind, so a file_path ending
// in an archive extension counts too. Documents are the complement: kind is
// distinct from archive (null included) and the path has none of those extensions.
const ARCHIVE_EXTENSIONS = Object.entries(MEDIA_TYPES)
  .filter(([, entry]) => entry.kind === "archive")
  .map(([extension]) => extension);

/** Quote an ilike pattern so `%` `_` and PostgREST `.or()` separators stay literal. */
function escapeLibrarySearchTerm(term: string): string {
  const likeLiteral = term.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
  const quoted = likeLiteral.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"%${quoted}%"`;
}

function extensionClause(operator: "ilike" | "not.ilike"): string {
  return ARCHIVE_EXTENSIONS.map((extension) => `file_path.${operator}."%.${extension}"`).join(",");
}

function libraryOrFilter(filter: LibraryFilter, search: string): string | null {
  const parts: string[] = [];
  if (filter === "archive") {
    parts.push(`or(metadata->>kind.eq.archive,${extensionClause("ilike")})`);
  } else if (filter === "document") {
    parts.push(`and(or(metadata->>kind.is.null,metadata->>kind.neq.archive),${extensionClause("not.ilike")})`);
  }
  if (search) {
    const pattern = escapeLibrarySearchTerm(search);
    parts.push(`or(metadata->>original_filename.ilike.${pattern},file_path.ilike.${pattern})`);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) {
    const only = parts[0];
    if (only.startsWith("or(") && only.endsWith(")")) return only.slice(3, -1);
    return only;
  }
  return `and(${parts.join(",")})`;
}

export function ScheduleLibraryPicker({ active, selectedId, onPick }: ScheduleLibraryPickerProps) {
  const { t } = useTranslation("inbox");
  const { session } = useAuth();
  const userId = session?.user?.id;
  const { data: cdnConfig } = useCdnConfig();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const query = useInfiniteQuery({
    queryKey: ["whatsapp-schedule-library", userId, debouncedSearch, filter],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      if (!userId) return [];
      let request = supabase
        .from("media_files")
        .select(LIBRARY_COLUMNS)
        .eq("user_id", userId);
      if (filter === "image" || filter === "video" || filter === "audio") {
        request = request.eq("file_type", filter);
      } else if (filter === "document" || filter === "archive") {
        request = request.eq("file_type", "document");
      }
      const logic = libraryOrFilter(filter, debouncedSearch);
      if (logic) request = request.or(logic);
      const from = pageParam;
      const { data, error } = await request
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      return (data || []) as ScheduleLibraryFile[];
    },
    getNextPageParam: (lastPage, _pages, lastOffset) =>
      lastPage.length === PAGE_SIZE ? lastOffset + PAGE_SIZE : undefined,
    enabled: !!userId && active,
  });

  const files = query.data?.pages.flat() ?? [];

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
        <div className="space-y-2">
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
          {query.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("scheduled.libraryLoadMore", "Load more")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
