import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { isSettledBenchmarkChannel, normalizeBenchmarkChannelInput } from "../domain/benchmark";
import { toYouTubeBenchmarkError, YouTubeBenchmarkError } from "../domain/errors";
import type { YouTubeBenchmarkChannel, YouTubeBenchmarkSuccess } from "../domain/types";
import type { YouTubeBenchmarkGateway } from "./ports";

/**
 * How long a settled answer stays fresh.
 *
 * Thirty minutes is well inside YouTube API Services' guidance on refreshing
 * displayed statistics, and short enough that a creator comparing channels
 * twice in a session still sees a current number.
 */
export const BENCHMARK_SETTLED_STALE_TIME_MS = 30 * 60 * 1000;

/** One cached channel answer: the channel itself and when it was read. */
export interface YouTubeBenchmarkChannelResult {
  channel: YouTubeBenchmarkChannel;
  fetchedAt: string;
  requestId: string;
}

/**
 * The cache entry of one channel.
 *
 * The key names the user, the connection that supplied the credential and the
 * NORMALISED input, so the same channel typed two ways is one entry — and an
 * entry can never be read by another user or under another connection.
 */
export function youtubeBenchmarkChannelKey(
  userId: string,
  accountId: string,
  input: string,
): QueryKey {
  return ["youtube-benchmark", "channel", userId, accountId, normalizeBenchmarkChannelInput(input)];
}

/**
 * Only a settled answer may be reused.
 *
 * A settled answer is one the provider actually gave: a channel that was read
 * (`found` without an error) or a channel it positively does not have
 * (`not_found`). A degraded or failed answer is never reused — the next
 * Compare has to try again instead of showing a quota notice for half an hour.
 */
export function isFreshSettledBenchmarkResult(
  queryClient: QueryClient,
  key: QueryKey,
  now: number = Date.now(),
): boolean {
  const state = queryClient.getQueryState(key);
  if (!state || state.data === undefined) return false;
  const result = state.data as YouTubeBenchmarkChannelResult | undefined;
  if (!result || typeof result !== "object") return false;
  if (!isSettledBenchmarkChannel(result.channel)) return false;
  return now - state.dataUpdatedAt < BENCHMARK_SETTLED_STALE_TIME_MS;
}

/**
 * The stale time of one cache entry.
 *
 * A settled answer is fresh for half an hour; anything else — an
 * `unavailable` channel, a `found` channel whose uploads lookup failed, or a
 * request that failed outright — is stale the moment it lands, so the next
 * Compare retries it.
 */
export function benchmarkStaleTime(query: Query<YouTubeBenchmarkChannelResult, Error>): number {
  const data = query.state.data;
  return data && isSettledBenchmarkChannel(data.channel) ? BENCHMARK_SETTLED_STALE_TIME_MS : 0;
}

export type YouTubeBenchmarkColumnState = "loading" | "ready" | "failed";

export interface YouTubeBenchmarkColumn {
  /** The normalised handle or channel id this column shows. */
  input: string;
  state: YouTubeBenchmarkColumnState;
  channel: YouTubeBenchmarkChannel | null;
  /** The failure of the request itself, when the whole lookup failed. */
  error: YouTubeBenchmarkError | null;
  fetchedAt: string | null;
}

export interface UseYouTubeChannelBenchmarkOptions {
  gateway: YouTubeBenchmarkGateway;
  userId: string | null;
  accountId: string | null;
}

export interface UseYouTubeChannelBenchmarkResult {
  columns: YouTubeBenchmarkColumn[];
  isComparing: boolean;
  /** Runs a comparison of already validated, normalised inputs. */
  compare: (inputs: readonly string[]) => void;
  /** Re-reads ONE channel. The other columns keep the answers they have. */
  retry: (input: string) => void;
}

function toBenchmarkFailure(error: unknown): YouTubeBenchmarkError {
  return error instanceof YouTubeBenchmarkError ? error : toYouTubeBenchmarkError(error);
}

function toChannelResult(
  response: YouTubeBenchmarkSuccess,
  channel: YouTubeBenchmarkChannel,
): YouTubeBenchmarkChannelResult {
  return { channel, fetchedAt: response.freshness.fetched_at, requestId: response.request_id };
}

/**
 * Reads the named channels in one request and hands back one result per input.
 *
 * The provider echoes the normalised input it was given, and both sides
 * normalise with the same rule, so the answers are matched by that input.
 */
async function lookupChannelResults(
  gateway: YouTubeBenchmarkGateway,
  accountId: string,
  inputs: readonly string[],
): Promise<Map<string, YouTubeBenchmarkChannelResult>> {
  const response = await gateway.lookupChannels({ accountId, channels: [...inputs] });
  const results = new Map<string, YouTubeBenchmarkChannelResult>();
  for (const input of inputs) {
    const wanted = normalizeBenchmarkChannelInput(input);
    const channel = response.data.channels.find(
      (candidate) => normalizeBenchmarkChannelInput(candidate.input) === wanted,
    );
    if (channel) results.set(input, toChannelResult(response, channel));
  }
  return results;
}

/**
 * The comparison's cache and its one-column-per-channel state.
 *
 * The cache is in memory only (the app configures no query persistence) and
 * is cleared with the rest of the React Query cache when the identity changes
 * (`useAuthQueryCacheSync`). Nothing read here is written to a database, a
 * storage bucket or browser storage.
 */
const EMPTY_INPUTS: readonly string[] = [];
const EMPTY_FAILURES: Record<string, YouTubeBenchmarkError> = {};

export function useYouTubeChannelBenchmark(
  options: UseYouTubeChannelBenchmarkOptions,
): UseYouTubeChannelBenchmarkResult {
  const { gateway, userId, accountId } = options;
  const queryClient = useQueryClient();
  const scope = `${userId ?? ""}:${accountId ?? ""}`;
  const activeScopeRef = useRef(scope);
  activeScopeRef.current = scope;
  const [submittedByScope, setSubmittedByScope] = useState<Record<string, readonly string[]>>({});
  const [pendingByScope, setPendingByScope] = useState<Record<string, readonly string[]>>({});
  const [failuresByScope, setFailuresByScope] = useState<
    Record<string, Record<string, YouTubeBenchmarkError>>
  >({});

  useEffect(() => {
    setSubmittedByScope({});
    setPendingByScope({});
    setFailuresByScope({});
  }, [scope]);

  const submitted = submittedByScope[scope] ?? EMPTY_INPUTS;
  const pendingInputs = pendingByScope[scope] ?? EMPTY_INPUTS;
  const failures = failuresByScope[scope] ?? EMPTY_FAILURES;

  // Without a signed-in user or a connection to borrow the credential from,
  // nothing may be read at all.
  const ready = Boolean(userId && accountId);

  const queries = useQueries({
    queries: submitted.map((input) => ({
      queryKey: youtubeBenchmarkChannelKey(userId as string, accountId as string, input),
      queryFn: async (): Promise<YouTubeBenchmarkChannelResult> => {
        const found = await lookupChannelResults(gateway, accountId as string, [input]);
        const result = found.get(input);
        if (!result) throw new YouTubeBenchmarkError("upstream_unavailable");
        return result;
      },
      // The hook drives every read itself: a query that React Query may fetch
      // on its own would spend provider units the creator did not ask for.
      enabled: false,
      staleTime: benchmarkStaleTime,
      retry: false,
    })),
  });

  const recordFailuresForScope = useCallback(
    (targetScope: string, inputs: readonly string[], failure: YouTubeBenchmarkError | null) => {
      setFailuresByScope((previous) => {
        const current = { ...(previous[targetScope] ?? {}) };
        for (const input of inputs) {
          if (failure) current[input] = failure;
          else delete current[input];
        }
        return { ...previous, [targetScope]: current };
      });
    },
    [],
  );

  const runLookup = useCallback(
    async (inputs: readonly string[]) => {
      if (!userId || !accountId || inputs.length === 0) return;
      const callScope = `${userId}:${accountId}`;
      setPendingByScope((previous) => {
        const current = previous[callScope] ?? [];
        const merged = [...current];
        for (const input of inputs) {
          if (!merged.includes(input)) merged.push(input);
        }
        return { ...previous, [callScope]: merged };
      });
      try {
        const results = await lookupChannelResults(gateway, accountId, inputs);
        if (activeScopeRef.current !== callScope) return;
        for (const input of inputs) {
          const result = results.get(input);
          if (result && activeScopeRef.current === callScope) {
            queryClient.setQueryData(
              youtubeBenchmarkChannelKey(userId, accountId, input),
              result,
            );
          }
        }
        recordFailuresForScope(callScope, inputs, null);
        // A channel the provider did not answer failed on its own; the other
        // channels keep the answers they have.
        const unanswered = inputs.filter((input) => !results.has(input));
        if (unanswered.length > 0) {
          recordFailuresForScope(
            callScope,
            unanswered,
            new YouTubeBenchmarkError("upstream_unavailable"),
          );
        }
      } catch (error) {
        if (activeScopeRef.current !== callScope) return;
        recordFailuresForScope(callScope, inputs, toBenchmarkFailure(error));
      } finally {
        setPendingByScope((previous) => {
          const current = previous[callScope] ?? [];
          return {
            ...previous,
            [callScope]: current.filter((item) => !inputs.includes(item)),
          };
        });
      }
    },
    [accountId, gateway, queryClient, recordFailuresForScope, userId],
  );

  const compare = useCallback(
    (inputs: readonly string[]) => {
      if (!ready || inputs.length === 0) return;
      const normalized = inputs.map((input) => normalizeBenchmarkChannelInput(input));
      setSubmittedByScope((previous) => ({ ...previous, [scope]: normalized }));
      // A channel whose cached answer is still fresh and settled is served
      // from the cache: no request, no provider units. Everything else — new,
      // degraded, failed or stale — is read again.
      const pending = normalized.filter(
        (input) =>
          !isFreshSettledBenchmarkResult(
            queryClient,
            youtubeBenchmarkChannelKey(userId as string, accountId as string, input),
          ),
      );
      const cachedInputs = normalized.filter((input) => !pending.includes(input));
      if (cachedInputs.length > 0) {
        recordFailuresForScope(scope, cachedInputs, null);
      }
      void runLookup(pending);
    },
    [accountId, queryClient, ready, recordFailuresForScope, runLookup, scope, userId],
  );

  const retry = useCallback(
    (input: string) => {
      // One channel, one request: the columns that already succeeded are not
      // read again and do not spend provider units again.
      void runLookup([normalizeBenchmarkChannelInput(input)]);
    },
    [runLookup],
  );

  const columns = useMemo<YouTubeBenchmarkColumn[]>(() => {
    const visible: YouTubeBenchmarkColumn[] = [];
    submitted.forEach((input, index) => {
      const cached = queries[index]?.data ?? null;
      const failure = failures[input] ?? null;
      if (pendingInputs.includes(input)) {
        visible.push({
          input,
          state: "loading",
          channel: cached?.channel ?? null,
          error: null,
          fetchedAt: cached?.fetchedAt ?? null,
        });
        return;
      }
      if (failure) {
        visible.push({
          input,
          state: "failed",
          channel: cached?.channel ?? null,
          error: failure,
          fetchedAt: cached?.fetchedAt ?? null,
        });
        return;
      }
      if (cached) {
        visible.push({
          input,
          state: "ready",
          channel: cached.channel,
          error: null,
          fetchedAt: cached.fetchedAt,
        });
      }
    });
    return visible;
  }, [failures, pendingInputs, queries, submitted]);

  return {
    columns,
    isComparing: pendingInputs.length > 0,
    compare,
    retry,
  };
}
