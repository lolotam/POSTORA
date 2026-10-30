/**
 * The read hooks of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The React Query bindings of the feature's reads: the tracked list,
 *   one entry's detail and the owner's quota, plus the local "is this
 *   handle already tracked" lookup.
 *
 * WHY THE HOOKS LIVE UNDER THE UI
 *
 *   React Query is a UI concern. The application layer of this feature
 *   is framework independent and holds no React (spec §8, ARCHITECTURE
 *   §4). The sibling `instagram-insights` feature keeps its hooks under
 *   `application/`; that is the local pattern, and the parent plan
 *   explicitly overrides it for this feature.
 *
 * WHY EVERY QUERY KEY CARRIES THE USER ID
 *
 *   A cached page belongs to ONE owner. Without the user id in the key,
 *   a signed-out owner could read the previous owner's competitors out
 *   of the cache. The key is the isolation boundary, and it is also
 *   what turns an owner switch into a cache miss instead of a flash of
 *   somebody else's data.
 *
 * WHY THERE IS NO `keepPreviousData`
 *
 *   Keeping the previous page while the next one loads is exactly the
 *   flash the spec forbids across an owner switch (spec §8). The list
 *   shows a skeleton instead.
 *
 * WHY THE CURSOR IS IN THE KEY TOO
 *
 *   Each page is its own query. The cursor is the position the server
 *   gave us, so it belongs in the key: a page fetched for one cursor
 *   can never be served for another. It also means the "Load more"
 *   button can fail on its own without taking the loaded pages with it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { CompetitorTrackingGateway } from "../application/ports";
import type {
  CompetitorReportEntry,
  CompetitorReportList,
  CompetitorReportMedia,
  CompetitorReportQuota,
} from "../domain/contracts";
import { CompetitorTrackingError, isCompetitorTrackingError } from "../domain/errors";
import { normalizeInstagramHandle } from "../domain/handle";

/** The default page size of a tracked list read. */
export const COMPETITOR_TRACKING_PAGE_SIZE = 20;

/** The period a detail read covers. */
export type CompetitorPeriodDays = 7 | 30;

/** The list the owner is looking at. */
export type CompetitorListState = "active" | "removed";

/**
 * The query keys of this feature.
 *
 * `all(userId)` is the PREFIX of every other key, so one invalidation
 * of the owner's scope refreshes the list, the entries, the quota and
 * the tracked-identity state together.
 */
export const competitorTrackingKeys = {
  all: (userId: string) => ["competitor-tracking", userId] as const,
  listPrefix: (userId: string, state: CompetitorListState) =>
    ["competitor-tracking", userId, "list", state] as const,
  list: (userId: string, state: CompetitorListState, cursor: string) =>
    ["competitor-tracking", userId, "list", state, cursor] as const,
  detailPrefix: (userId: string, watchlistId: string) =>
    ["competitor-tracking", userId, "detail", watchlistId] as const,
  detail: (userId: string, watchlistId: string, periodDays: CompetitorPeriodDays, cursor: string) =>
    ["competitor-tracking", userId, "detail", watchlistId, periodDays, cursor] as const,
  quota: (userId: string) => ["competitor-tracking", userId, "quota"] as const,
  identity: (userId: string, handle: string) =>
    ["competitor-tracking", userId, "identity", handle] as const,
  status: (userId: string, watchlistId: string) =>
    ["competitor-tracking", userId, "status", watchlistId] as const,
};

/**
 * Narrows an unknown failure into this feature's typed vocabulary.
 *
 * An aborted read is NOT a failure: the caller moved on, and React
 * Query has already discarded it. Anything else that is not a typed
 * failure is an unavailable read - never an empty read.
 */
function toTrackingError(error: unknown): CompetitorTrackingError | null {
  if (error === null || error === undefined) return null;
  if (isCompetitorTrackingError(error)) return error;
  if (error instanceof Error && error.name === "AbortError") return null;
  return new CompetitorTrackingError(
    "REPORT_UNAVAILABLE",
    "the competitor data could not be read",
  );
}

/**
 * Drops the previous owner's cached data when the owner changes.
 *
 * The query key already isolates the data, but the OLD owner's pages
 * would otherwise stay in the cache until they expired - readable by
 * anything that knows the key. Removing them makes the switch
 * complete: no previous identity's data is retained at all.
 */
export function useCompetitorOwnerIsolation(userId: string | null): void {
  const queryClient = useQueryClient();
  const previousUserIdRef = useRef<string | null>(userId);

  useEffect(() => {
    const previous = previousUserIdRef.current;
    if (previous !== null && previous !== userId) {
      queryClient.removeQueries({ queryKey: competitorTrackingKeys.all(previous) });
    }
    previousUserIdRef.current = userId;
  }, [userId, queryClient]);
}

/* -------------------------------------------------------------------------- */
/* The tracked list                                                            */
/* -------------------------------------------------------------------------- */

export type UseCompetitorListOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
  state: CompetitorListState;
  limit?: number;
  enabled?: boolean;
};

export type CompetitorListResult = {
  entries: CompetitorReportEntry[];
  isLoading: boolean;
  isFetching: boolean;
  error: CompetitorTrackingError | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: CompetitorTrackingError | null;
  loadMore: () => void;
  reload: () => void;
};

/**
 * The owner's tracked competitors, one query per page.
 *
 * The pages are separate queries so that the "Load more" failure is
 * INDEPENDENT: the pages that were already loaded stay on screen and
 * only the new page reports a failure.
 */
export function useCompetitorList({
  gateway,
  userId,
  state,
  limit = COMPETITOR_TRACKING_PAGE_SIZE,
  enabled = true,
}: UseCompetitorListOptions): CompetitorListResult {
  useCompetitorOwnerIsolation(userId);
  const queryClient = useQueryClient();

  // The empty string is the FIRST page: it is the page without a
  // cursor, and it is also the prefix every later page builds on.
  const [cursors, setCursors] = useState<string[]>([""]);

  // A different owner or a different list starts from the first page
  // again. The old cursors mean nothing in the new list.
  useEffect(() => {
    setCursors([""]);
  }, [userId, state]);

  const active = enabled && Boolean(userId);
  const ownerKey = userId ?? "anonymous";

  const results = useQueries({
    queries: cursors.map((cursor) => ({
      queryKey: competitorTrackingKeys.list(ownerKey, state, cursor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gateway.list(
          { state, limit, cursor: cursor === "" ? null : cursor },
          { signal },
        ),
      enabled: active,
      staleTime: 30_000,
      // A failed read is shown with a Retry action. Repeating it in the
      // background would hide the failure behind a spinner that never
      // resolves, and the spec asks for an inline error instead.
      retry: false,
    })),
  });

  const first = results[0];
  const last = results[results.length - 1];

  // `useQueries` returns a fresh array on every render, so there is
  // nothing to memoise here: the rows are simply collected.
  const entries: CompetitorReportEntry[] = [];
  for (const result of results) {
    if (result.data) entries.push(...result.data.entries);
  }

  const nextCursor = last?.data?.next_cursor ?? null;

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    setCursors((previous) =>
      previous[previous.length - 1] === nextCursor ? previous : [...previous, nextCursor],
    );
  }, [nextCursor]);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: competitorTrackingKeys.listPrefix(ownerKey, state),
    });
  }, [queryClient, ownerKey, state]);

  const isLoadingMore = results.slice(1).some((result) => result.isFetching);

  return {
    entries,
    isLoading: first?.isLoading ?? false,
    isFetching: first?.isFetching ?? false,
    error: toTrackingError(first?.error),
    hasMore: nextCursor !== null,
    isLoadingMore,
    loadMoreError: results.length > 1 ? toTrackingError(last?.error) : null,
    loadMore,
    reload,
  };
}

/* -------------------------------------------------------------------------- */
/* One entry's detail                                                          */
/* -------------------------------------------------------------------------- */

export type UseCompetitorDetailOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
  watchlistId: string | null;
  periodDays: CompetitorPeriodDays;
  limit?: number;
  enabled?: boolean;
};

export type CompetitorDetailResult = {
  entry: CompetitorReportEntry | null;
  media: CompetitorReportMedia[];
  isLoading: boolean;
  error: CompetitorTrackingError | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: CompetitorTrackingError | null;
  loadMore: () => void;
  reload: () => void;
};

/**
 * One tracked competitor over one period, with its media.
 *
 * The entry itself comes from the FIRST page. Later pages carry more
 * media and the same entry.
 */
export function useCompetitorDetail({
  gateway,
  userId,
  watchlistId,
  periodDays,
  limit = COMPETITOR_TRACKING_PAGE_SIZE,
  enabled = true,
}: UseCompetitorDetailOptions): CompetitorDetailResult {
  useCompetitorOwnerIsolation(userId);
  const queryClient = useQueryClient();

  const [cursors, setCursors] = useState<string[]>([""]);

  useEffect(() => {
    setCursors([""]);
  }, [userId, watchlistId, periodDays]);

  const active = enabled && Boolean(userId) && Boolean(watchlistId);
  const ownerKey = userId ?? "anonymous";
  const targetKey = watchlistId ?? "none";

  const results = useQueries({
    queries: cursors.map((cursor) => ({
      queryKey: competitorTrackingKeys.detail(ownerKey, targetKey, periodDays, cursor),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        gateway.detail(
          {
            watchlistId: targetKey,
            periodDays,
            limit,
            cursor: cursor === "" ? null : cursor,
          },
          { signal },
        ),
      enabled: active,
      staleTime: 30_000,
      retry: false,
    })),
  });

  const first = results[0];
  const last = results[results.length - 1];

  // `useQueries` returns a fresh array on every render, so there is
  // nothing to memoise here: the rows are simply collected.
  const media: CompetitorReportMedia[] = [];
  for (const result of results) {
    if (result.data) media.push(...result.data.media);
  }

  const nextCursor = last?.data?.next_cursor ?? null;

  const loadMore = useCallback(() => {
    if (!nextCursor) return;
    setCursors((previous) =>
      previous[previous.length - 1] === nextCursor ? previous : [...previous, nextCursor],
    );
  }, [nextCursor]);

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: competitorTrackingKeys.detailPrefix(ownerKey, targetKey),
    });
  }, [queryClient, ownerKey, targetKey]);

  return {
    entry: first?.data?.entry ?? null,
    media,
    isLoading: first?.isLoading ?? false,
    error: toTrackingError(first?.error),
    hasMore: nextCursor !== null,
    isLoadingMore: results.slice(1).some((result) => result.isFetching),
    loadMoreError: results.length > 1 ? toTrackingError(last?.error) : null,
    loadMore,
    reload,
  };
}

/* -------------------------------------------------------------------------- */
/* The quota                                                                   */
/* -------------------------------------------------------------------------- */

export type UseCompetitorQuotaOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
  enabled?: boolean;
};

export type CompetitorQuotaResult = {
  quota: CompetitorReportQuota | null;
  isLoading: boolean;
  error: CompetitorTrackingError | null;
  reload: () => void;
};

/**
 * The owner's own entitlement.
 *
 * A quota that could not be read is UNAVAILABLE, not unlimited and not
 * zero: the screen says "limit unavailable" and the server stays the
 * authority on the next mutation.
 */
export function useCompetitorQuota({
  gateway,
  userId,
  enabled = true,
}: UseCompetitorQuotaOptions): CompetitorQuotaResult {
  useCompetitorOwnerIsolation(userId);

  const ownerKey = userId ?? "anonymous";

  const query = useQuery({
    queryKey: competitorTrackingKeys.quota(ownerKey),
    queryFn: ({ signal }: { signal: AbortSignal }) => gateway.quota({ signal }),
    enabled: enabled && Boolean(userId),
    staleTime: 30_000,
    retry: false,
  });

  const reload = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    quota: query.data ?? null,
    isLoading: query.isLoading,
    error: toTrackingError(query.error),
    reload,
  };
}

/* -------------------------------------------------------------------------- */
/* The tracked identity of one handle                                          */
/* -------------------------------------------------------------------------- */

export type UseCompetitorIdentityOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
  username: string;
  enabled?: boolean;
};

/**
 * Whether a handle is already on the owner's ACTIVE list.
 *
 * The lookup is best effort by construction: the list is paged, so a
 * handle beyond the first page is not found. The result is therefore
 * only ever a definite "tracked" or an honest "unknown" - it never
 * claims that a handle is untracked. The server's own reply stays the
 * authority.
 */
export function useCompetitorIdentity({
  gateway,
  userId,
  username,
  enabled = true,
}: UseCompetitorIdentityOptions): { isTracked: boolean; isLoading: boolean } {
  useCompetitorOwnerIsolation(userId);

  const handle = normalizeInstagramHandle(username);
  const ownerKey = userId ?? "anonymous";

  const query = useQuery({
    queryKey: competitorTrackingKeys.identity(ownerKey, handle),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      gateway.list({ state: "active", limit: COMPETITOR_TRACKING_PAGE_SIZE }, { signal }),
    enabled: enabled && Boolean(userId) && handle !== "",
    staleTime: 30_000,
    retry: false,
  });

  const isTracked = useMemo(() => {
    if (!query.data) return false;
    return query.data.entries.some(
      (entry) => normalizeInstagramHandle(entry.username) === handle,
    );
  }, [query.data, handle]);

  return { isTracked, isLoading: query.isLoading };
}

/* -------------------------------------------------------------------------- */
/* The failure copy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The translated copy of every failure this feature can report.
 *
 * The copy lives in ONE place so that the same failure is described
 * the same way wherever it surfaces, and so that no raw provider or
 * SQL text can reach the owner (spec §8).
 */
export type CompetitorErrorCopy = {
  generic: string;
  invalidHandle: string;
  quotaExceeded: (limit: number | null) => string;
  notFound: string;
  reportUnavailable: string;
  collectionDisabled: string;
  throttled: (seconds: number | null) => string;
  rateLimited: string;
  provider: string;
  storage: string;
  credentialsChanged: string;
  apifyDisabled: string;
  settings: string;
  indeterminate: string;
};

/**
 * The copy hook.
 *
 * Every key is a LITERAL at its call site: the i18n coverage gate
 * reads the call sites to find the keys, so a computed key would be an
 * invisible translation.
 */
export function useCompetitorErrorCopy(): CompetitorErrorCopy {
  const { t } = useTranslation("analytics");

  return useMemo<CompetitorErrorCopy>(
    () => ({
      generic: t("competitors.error.generic", "Something went wrong."),
      invalidHandle: t(
        "competitors.error.invalidHandle",
        "That is not a valid Instagram handle.",
      ),
      quotaExceeded: (limit) =>
        t(
          "competitors.quotaExceeded",
          "Your limit is {{limit}} active competitors.",
          { limit: limit ?? "—" },
        ),
      notFound: t("competitors.notFound", "That competitor is no longer available."),
      reportUnavailable: t("competitors.loadFailed", "Could not load competitors."),
      collectionDisabled: t(
        "competitors.collectionDisabled",
        "Collection is not available right now. Your stored reports are still here.",
      ),
      throttled: (seconds) =>
        t("competitors.retryIn", "Retry in {{seconds}} seconds.", {
          seconds: seconds ?? 0,
        }),
      rateLimited: t(
        "competitors.error.rateLimited",
        "The collector is busy. Try again when it says it is due.",
      ),
      provider: t(
        "competitors.error.provider",
        "The collector could not reach the platform.",
      ),
      storage: t("competitors.error.storage", "The collected data could not be stored."),
      credentialsChanged: t(
        "competitors.error.credentialsChanged",
        "The connected credentials changed. Reconnect to collect again.",
      ),
      apifyDisabled: t(
        "competitors.error.apifyDisabled",
        "Official collection is unavailable and the scheduled third-party fallback is off.",
      ),
      settings: t("competitors.error.settings", "The collection settings are unavailable."),
      indeterminate: t(
        "competitors.outcomeUnknown",
        "Could not confirm the change. Reload to check.",
      ),
    }),
    [t],
  );
}

/**
 * The message of one typed failure.
 *
 * `limit` is the owner's resolved limit, used by the quota refusal.
 */
export function competitorErrorMessage(
  copy: CompetitorErrorCopy,
  error: CompetitorTrackingError,
  limit?: number | null,
): string {
  switch (error.code) {
    case "QUOTA_EXCEEDED":
      return copy.quotaExceeded(limit ?? null);
    case "INVALID_HANDLE":
      return copy.invalidHandle;
    case "NOT_FOUND":
      return copy.notFound;
    case "THROTTLED":
      return copy.throttled(error.retryAfterSeconds);
    case "COLLECTION_DISABLED":
    case "PROTECTED_CREDENTIALS_REQUIRED":
      return copy.collectionDisabled;
    case "SETTINGS_UNAVAILABLE":
      return copy.settings;
    case "REPORT_UNAVAILABLE":
      return copy.reportUnavailable;
    case "MUTATION_INDETERMINATE":
    case "ENQUEUE_INDETERMINATE":
      return copy.indeterminate;
    case "INVALID_REQUEST":
    case "LABEL_INVALID":
    case "MUTATION_UNAVAILABLE":
    case "REQUEST_UNAVAILABLE":
    case "STATUS_UNAVAILABLE":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
    default:
      return copy.generic;
  }
}
