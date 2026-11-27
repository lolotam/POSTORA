import { useCallback, useEffect, useRef, useState } from "react";
import { SupabaseYouTubeResourcesGateway } from "@/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway";
import type {
  YouTubeAccountCapabilities,
  YouTubePlaylistListItem,
} from "@/features/youtube-management/domain/types";

export interface YouTubePlaylistsState {
  playlists: YouTubePlaylistListItem[];
  capabilities: YouTubeAccountCapabilities["capabilities"] | null;
  loading: boolean;
  loadingMore: boolean;
  /** The list could not be read; the creator can retry without losing the choice. */
  unavailable: boolean;
  /** Another page of playlists exists behind a cursor. */
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
}

const gateway = new SupabaseYouTubeResourcesGateway();

/**
 * The playlists of the one channel a post may target.
 *
 * A playlist belongs to exactly one channel, so the list is read for the
 * selected account alone and the items of a previous account are dropped
 * before a new read. A failed page never empties an already loaded list: the
 * creator keeps the playlist they chose and only the next page is retried.
 */
export function useYouTubePlaylists(accountId?: string | null): YouTubePlaylistsState {
  const [playlists, setPlaylists] = useState<YouTubePlaylistListItem[]>([]);
  const [capabilities, setCapabilities] = useState<YouTubeAccountCapabilities["capabilities"] | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The cursor and the in-flight guard live in refs: `loadMore` is called from
  // a click handler that must see the cursor of the last finished read, not
  // the one captured when the callback was created.
  const cursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Every read belongs to a generation. A page that arrives after the account
  // changed belongs to an older generation and may not write into the list
  // the newer generation owns.
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (!accountId) {
      setPlaylists([]);
      setCapabilities(null);
      cursorRef.current = null;
      setNextPageToken(null);
      setLoading(false);
      setLoadingMore(false);
      loadingMoreRef.current = false;
      setUnavailable(false);
      return;
    }

    // The playlists of one channel are never the playlists of another, so the
    // previous account's list is dropped before the new read.
    setPlaylists([]);
    setCapabilities(null);
    cursorRef.current = null;
    setNextPageToken(null);
    setLoading(true);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setUnavailable(false);

    if (typeof gateway.getCapabilities === "function") {
      gateway.getCapabilities(accountId)
        .then((result) => {
          if (generationRef.current !== generation) return;
          setCapabilities(result?.data?.capabilities ?? null);
        })
        .catch(() => {
          if (generationRef.current !== generation) return;
          setCapabilities(null);
        });
    }

    gateway.listPlaylists({ accountId })
      .then((result) => {
        if (generationRef.current !== generation) return;
        setPlaylists(result.data.items);
        cursorRef.current = result.data.next_page_token;
        setNextPageToken(result.data.next_page_token);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setUnavailable(true);
      })
      .finally(() => {
        if (generationRef.current !== generation) return;
        setLoading(false);
      });
  }, [accountId, attempt]);

  const loadMore = useCallback(() => {
    const pageToken = cursorRef.current;
    const generation = generationRef.current;
    if (!accountId || !pageToken || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    gateway.listPlaylists({ accountId, pageToken })
      .then((result) => {
        if (generationRef.current !== generation) return;
        setPlaylists((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...result.data.items.filter((item) => !known.has(item.id))];
        });
        cursorRef.current = result.data.next_page_token;
        setNextPageToken(result.data.next_page_token);
        setUnavailable(false);
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        // The playlists already loaded stay: a failed page must not empty the
        // selector or lose the choice the creator made.
        setUnavailable(true);
      })
      .finally(() => {
        if (generationRef.current !== generation) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [accountId]);

  const retry = useCallback(() => {
    // A failed page is retried where it failed; a list that never arrived is
    // read again from the first page.
    if (playlists.length > 0 && cursorRef.current !== null) {
      loadMore();
      return;
    }
    setAttempt((value) => value + 1);
  }, [loadMore, playlists.length]);

  return {
    playlists,
    capabilities,
    loading,
    loadingMore,
    unavailable,
    hasMore: nextPageToken !== null,
    loadMore,
    retry,
  };
}
