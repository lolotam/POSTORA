import { awaitWithAbort } from "../_shared/abort.ts";

export interface AccountLookupQuery {
  eq(column: string, value: unknown): AccountLookupQuery;
  abortSignal(signal: AbortSignal): AccountLookupQuery;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
}

export interface HistoryClient {
  from(table: string): { select(columns: string): AccountLookupQuery };
}

export class ReportHistoryUnavailableError extends Error {}

/** SDKs can reject a deadline or resolve it as an error; neither is an empty read. */
export async function readReportQuery<T>(query: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  try {
    signal.throwIfAborted();
    const queryResult = await awaitWithAbort(() => query, signal);
    signal.throwIfAborted();
    return queryResult;
  } catch (error) {
    if (signal.aborted || error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name)) {
      throw new ReportHistoryUnavailableError("Report storage exceeded its read deadline");
    }
    throw error;
  }
}
