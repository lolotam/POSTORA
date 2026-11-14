import { CHAT_LIST_POLICY_QUERY_KEY } from '@/features/ai-providers/infrastructure/chatListGateway';
import { useCallback, useState } from "react";
import { AI_PROVIDER_AUTH_QUERY_KEY } from "./useAiProviderAuth";
import { AI_PROVIDER_HEALTH_QUERY_KEY } from "./queryKeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchProviderHealth,
  runProviderHealthChunk,
  type ProviderHealthRow,
  type ProviderHealthSkipped,
} from "@/features/ai-providers/infrastructure/aiProviderHealthGateway";

export type { ProviderHealthChunk, ProviderHealthRow, ProviderHealthSkipped, ProviderHealthStatus } from "@/features/ai-providers/infrastructure/aiProviderHealthGateway";

export { AI_PROVIDER_HEALTH_QUERY_KEY } from "./queryKeys";

/**
 * How many times the same chunk is asked for again when the server could not
 * finish it. The server re-plans on every call and puts the targets it has not
 * recorded yet first, so asking for the SAME chunk again picks up exactly the
 * targets that were skipped. A run that keeps skipping stops after this many
 * tries and is reported as incomplete.
 */
export const MAX_CHUNK_ATTEMPTS = 3;

/** What one run did. */
export interface ProviderHealthRunResult {
  /** The providers that were tested. */
  rows: ProviderHealthRow[];
  /** The providers that were NOT tested: the run ran out of time, or could not read them. */
  skipped: ProviderHealthSkipped[];
  /** false when the run did not cover every target. */
  complete: boolean;
}

/** The stored results of the last run. It never runs anything by itself. */
export function useProviderHealthStatus(): { data: ProviderHealthRow[] | undefined; isLoading: boolean; error: Error | null } {
  const query = useQuery({
    queryKey: AI_PROVIDER_HEALTH_QUERY_KEY,
    queryFn: () => fetchProviderHealth(),
    retry: false,
  });
  return { data: query.data, isLoading: query.isLoading, error: query.error };
}

/**
 * Runs the check. The button calls `run()`; the hook walks the chunks until the
 * server says it is done.
 *
 * The run token is generated once per click, so all chunks share one run id.
 * Lease ownership is separate: each HTTP request takes its own lease.
 */
export function useRunProviderHealth(): {
  run: () => Promise<ProviderHealthRunResult>;
  isRunning: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<ProviderHealthRunResult> => {
    setError(null);
    setIsRunning(true);
    const rows: ProviderHealthRow[] = [];
    const skipped = new Map<string, ProviderHealthSkipped>();
    try {
      const runToken = crypto.randomUUID();
      let chunk = 1;
      let attempts = 0;
      for (;;) {
        const result = await runProviderHealthChunk(chunk, runToken);
        rows.push(...result.results);
        for (const row of result.results) skipped.delete(`${row.provider_code}:${row.auth_method}`);
        for (const target of result.skipped) skipped.set(`${target.provider_code}:${target.auth_method}`, target);
        if (result.done) {
          // Membership can change between chunks. The server's completion covers
          // current targets, including the removal of a previously skipped target.
          skipped.clear();
          for (const target of result.skipped) skipped.set(`${target.provider_code}:${target.auth_method}`, target);
          break;
        }
        if (result.skipped.length > 0) {
          // The chunk could not cover everything it was asked to. The server
          // re-plans on every call and puts the targets it has not recorded yet
          // first, so the SAME chunk picks up the targets that were skipped.
          attempts += 1;
          if (attempts >= MAX_CHUNK_ATTEMPTS) break;
          continue;
        }
        attempts = 0;
        chunk = result.next_chunk ?? chunk + 1;
      }
      // A target that was skipped was not tested, so the run is not complete.
      return { rows, skipped: [...skipped.values()], complete: skipped.size === 0 };
    } catch (cause) {
      // A busy server is an answer, not a crash: the button shows the message.
      setError(cause instanceof Error ? cause.message : "unknown");
      return { rows, skipped: [...skipped.values()], complete: false };
    } finally {
      // A partial run can already have changed catalogues and health rows.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ['ai-config'] }),
        queryClient.invalidateQueries({ queryKey: AI_PROVIDER_AUTH_QUERY_KEY }),
      ]);
      setIsRunning(false);
    }
  }, [queryClient]);

  return { run, isRunning, error };
}
