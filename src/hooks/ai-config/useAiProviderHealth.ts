import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchProviderHealth,
  runProviderHealthChunk,
  type ProviderHealthRow,
} from "@/features/ai-providers/infrastructure/aiProviderHealthGateway";

export type { ProviderHealthChunk, ProviderHealthRow, ProviderHealthStatus } from "@/features/ai-providers/infrastructure/aiProviderHealthGateway";

/** One cache identity for every provider health read. */
export const AI_PROVIDER_HEALTH_QUERY_KEY = ["ai-provider-health"] as const;

/** The stored results of the last run. It never runs anything by itself. */
export function useProviderHealthStatus(): { data: ProviderHealthRow[] | undefined; isLoading: boolean } {
  const query = useQuery({
    queryKey: AI_PROVIDER_HEALTH_QUERY_KEY,
    queryFn: () => fetchProviderHealth(),
    retry: false,
  });
  return { data: query.data, isLoading: query.isLoading };
}

/**
 * Runs the check. The button calls `run()`; the hook walks the chunks until the
 * server says it is done.
 *
 * The run token is generated once per run, so the server derives one run id (and one
 * lease holder) for the whole click and two clicks never share one.
 */
export function useRunProviderHealth(): {
  run: () => Promise<ProviderHealthRow[]>;
  isRunning: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<ProviderHealthRow[]> => {
    setError(null);
    setIsRunning(true);
    try {
      const runToken = crypto.randomUUID();
      const rows: ProviderHealthRow[] = [];
      let chunk = 1;
      for (;;) {
        const result = await runProviderHealthChunk(chunk, runToken);
        rows.push(...result.results);
        if (result.done) break;
        chunk = result.next_chunk ?? chunk + 1;
      }
      await queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY });
      return rows;
    } catch (cause) {
      // A busy server is an answer, not a crash: the button shows the message.
      setError(cause instanceof Error ? cause.message : "unknown");
      return [];
    } finally {
      setIsRunning(false);
    }
  }, [queryClient]);

  return { run, isRunning, error };
}
