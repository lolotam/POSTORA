import { useCallback, useEffect, useRef, useState } from "react";
import { SupabaseYouTubeResourcesGateway } from "@/features/youtube-management/infrastructure/supabaseYouTubeResourcesGateway";
import type {
  YouTubeAccountCapabilities,
  YouTubePlaylistListItem,
} from "@/features/youtube-management/domain/types";

export interface YouTubePlaylistsState {
  playlists: YouTubePlaylistListItem[];
  capabilities: YouTubeAccountCapabilities["capabilities"] | null;
  capabilitiesLoading: boolean;
  capabilitiesUnavailable: boolean;
  loading: boolean;
  loadingMore: boolean;
  /** The list could not be read; the creator can retry without losing the choice. */
  unavailable: boolean;
  /** Another page of playlists exists behind a cursor. */
  hasMore: boolean;
  loadMore: () => void;
  retry: () => void;
  retryCapabilities?: () => void;
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
  const [capabilitiesState, setCapabilitiesState] = useState<{
    accountId: string | null;
    capabilities: YouTubeAccountCapabilities["capabilities"] | null;
    loading: boolean;
    unavailable: boolean;
  }>({
    accountId: null,
    capabilities: null,
    loading: false,
    unavailable: false,
  });
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = useState(0);

  // The cursor and the in-flight guard live in refs: `loadMore` is called from
  // a click handler that must see the cursor of the last finished read, not
  // the one captured when the callback was created.
  const cursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  // Every read belongs to a generation. A page that arrives after the account
  // changed belongs to an older generation and may not write into the list
  // the newer generation owns.
  const generationRef = useRef(0);

  const capabilitiesGenerationRef = useRef(0);
  useEffect(() => {
    const capGeneration = capabilitiesGenerationRef.current + 1;
    capabilitiesGenerationRef.current = capGeneration;

    if (!accountId) {
      setCapabilitiesState({
        accountId: null,
        capabilities: null,
        loading: false,
        unavailable: false,
      });
      return;
    }

    if (typeof gateway.getCapabilities === "function") {
      setCapabilitiesState({
        accountId,
        capabilities: null,
        loading: true,
        unavailable: false,
      });
      gateway.getCapabilities(accountId)
        .then((result) => {
          if (capabilitiesGenerationRef.current !== capGeneration) return;
          const nextCaps = result?.data?.capabilities ?? null;
          setCapabilitiesState({
            accountId,
            capabilities: nextCaps,
            loading: false,
            unavailable: nextCaps === null,
          });
        })
        .catch(() => {
          if (capabilitiesGenerationRef.current !== capGeneration) return;
          setCapabilitiesState({
            accountId,
            capabilities: null,
            loading: false,
            unavailable: true,
          });
        });
    } else {
      setCapabilitiesState({
        accountId,
        capabilities: null,
        loading: false,
        unavailable: false,
      });
    }
  }, [accountId, attempt, capabilitiesAttempt]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    if (!accountId) {
      setPlaylists([]);
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
    cursorRef.current = null;
    setNextPageToken(null);
    setLoading(true);
    setLoadingMore(false);
    loadingMoreRef.current = false;
    setUnavailable(false);

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
    if (unavailable && playlists.length > 0 && cursorRef.current !== null) {
      loadMore();
      return;
    }
    setAttempt((value) => value + 1);
  }, [loadMore, playlists.length, unavailable]);

  const retryCapabilities = useCallback(() => {
    setCapabilitiesAttempt((value) => value + 1);
  }, []);

  const activeAccountMatch = Boolean(accountId) && capabilitiesState.accountId === accountId;
  const capabilities = activeAccountMatch ? capabilitiesState.capabilities : null;
  const capabilitiesLoading = Boolean(accountId) && (!activeAccountMatch || capabilitiesState.loading);
  const capabilitiesUnavailable = activeAccountMatch ? capabilitiesState.unavailable : false;

  return {
    playlists,
    capabilities,
    capabilitiesLoading,
    capabilitiesUnavailable,
    loading,
    loadingMore,
    unavailable,
    hasMore: nextPageToken !== null,
    loadMore,
    retry,
    retryCapabilities,
  };
}
