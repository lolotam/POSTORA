import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueries } from "@tanstack/react-query";
import {
  MEDIA_UNAVAILABLE,
  useWhatsAppInboxApi,
  type WhatsAppResolvedMedia,
  type WhatsAppAttachmentKind,
} from "./ports";

export const WA_MEDIA_STALE_TIME_MS = 50 * 60_000;
export const WA_MEDIA_BATCH_SIZE = 10;

export interface RequestMediaMeta {
  createdTime?: string | null;
  kind?: WhatsAppAttachmentKind;
}

export interface WhatsAppMediaState {
  requestMedia(rowId: string, meta?: RequestMediaMeta): void;
  mediaByRowId: Map<string, WhatsAppResolvedMedia>;
  requestedRowIds: ReadonlySet<string>;
  imageUrls: string[];
}

const WhatsAppMediaContext = createContext<WhatsAppMediaState | null>(null);

function chunkSorted(ids: string[], size: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    batches.push([...ids.slice(i, i + size)].sort());
  }
  return batches;
}

function useWhatsAppMediaCollector(socialAccountId: string | null): WhatsAppMediaState {
  const api = useWhatsAppInboxApi();
  const [batches, setBatches] = useState<string[][]>([]);
  const queuedRef = useRef<string[]>([]);
  const seenRef = useRef(new Set<string>());
  const scheduledRef = useRef(false);
  const requestedRef = useRef(new Set<string>());
  const metaRef = useRef(new Map<string, RequestMediaMeta>());
  const [, bumpRequested] = useState(0);

  const flush = useCallback(() => {
    scheduledRef.current = false;
    const queued = queuedRef.current;
    queuedRef.current = [];
    if (queued.length === 0) return;
    const videos = queued.filter((id) => metaRef.current.get(id)?.kind === "video");
    const others = queued.filter((id) => metaRef.current.get(id)?.kind !== "video");
    setBatches((prev) => [...prev, ...chunkSorted(others, WA_MEDIA_BATCH_SIZE), ...videos.map((id) => [id])]);
  }, []);

  const requestMedia = useCallback((rowId: string, meta?: RequestMediaMeta) => {
    if (!rowId || seenRef.current.has(rowId)) return;
    seenRef.current.add(rowId);
    requestedRef.current.add(rowId);
    if (meta) metaRef.current.set(rowId, meta);
    queuedRef.current.push(rowId);
    bumpRequested((n) => n + 1);
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    queueMicrotask(flush);
  }, [flush]);

  const queries = useQueries({
    queries: batches.map((ids) => ({
      queryKey: ["wa-media", socialAccountId, ids],
      queryFn: async () => {
        if (!socialAccountId) return { media: [] as WhatsAppResolvedMedia[] };
        let media: WhatsAppResolvedMedia[] = [];
        try {
          const result = await api.getMedia({
            social_account_id: socialAccountId,
            message_row_ids: ids,
          });
          media = result.media ?? [];
        } catch {
          // A cancelled worker has no per-row response. Settle every bubble so it
          // can display its failure state instead of retrying into another OOM.
          console.error("[whatsapp-media] batch resolution failed");
        }
        const byId = new Map(media.map((item) => [item.message_row_id, item]));
        return {
          media: ids.map((id) => byId.get(id) ?? {
            message_row_id: id,
            kind: metaRef.current.get(id)?.kind ?? "document",
            url: null,
            error: MEDIA_UNAVAILABLE,
          }),
        };
      },
      staleTime: WA_MEDIA_STALE_TIME_MS,
      retry: false,
      refetchInterval: WA_MEDIA_STALE_TIME_MS,
      enabled: Boolean(socialAccountId) && ids.length > 0,
    })),
  });

  const mediaByRowId = useMemo(() => {
    const map = new Map<string, WhatsAppResolvedMedia>();
    for (const query of queries) {
      for (const item of query.data?.media ?? []) {
        map.set(item.message_row_id, item);
      }
    }
    return map;
  }, [queries]);

  const imageUrls = useMemo(() => {
    return [...mediaByRowId.values()]
      .filter((item) => item.kind === "image" && item.url)
      .sort((a, b) => {
        const aTime = metaRef.current.get(a.message_row_id)?.createdTime ?? "";
        const bTime = metaRef.current.get(b.message_row_id)?.createdTime ?? "";
        if (aTime !== bTime) return aTime < bTime ? -1 : 1;
        return a.message_row_id < b.message_row_id ? -1 : 1;
      })
      .map((resolved) => resolved.url as string);
  }, [mediaByRowId]);

  return {
    requestMedia,
    mediaByRowId,
    requestedRowIds: requestedRef.current,
    imageUrls,
  };
}

interface WhatsAppMediaScopeProps {
  socialAccountId: string | null;
  children: ReactNode;
}

export function WhatsAppMediaScope({ socialAccountId, children }: WhatsAppMediaScopeProps): JSX.Element {
  const mediaState = useWhatsAppMediaCollector(socialAccountId);
  return <WhatsAppMediaContext.Provider value={mediaState}>{children}</WhatsAppMediaContext.Provider>;
}

// Collector state has to live in the same module as the hook that reads it.
// eslint-disable-next-line react-refresh/only-export-components
export function useWhatsAppMedia(): WhatsAppMediaState {
  const state = useContext(WhatsAppMediaContext);
  if (!state) {
    throw new Error("useWhatsAppMedia must be used within WhatsAppMediaScope");
  }
  return state;
}
