import { awaitWithAbort } from "../_shared/abort.ts";
export type HistoryReadResult = {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
  count: number | null;
};

export interface HistoryQuery extends PromiseLike<HistoryReadResult> {
  eq(column: string, value: unknown): HistoryQuery;
  gt(column: string, value: string): HistoryQuery;
  lte(column: string, value: string): HistoryQuery;
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): HistoryQuery;
  limit(count: number): HistoryQuery;
  abortSignal(signal: AbortSignal): HistoryQuery;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
}

export interface HistoryClient {
  from(table: string): { select(columns: string, options?: { count: "exact" }): HistoryQuery };
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

const PAGE_SIZE = 500;
const MAX_HISTORY_ROWS = 20_000;

// Traverse by immutable row identity, independently of display cursor and period.
// Exact counts detect server row caps; exhausting any bound refuses a partial read.
export async function readReportHistory(
  client: HistoryClient,
  scope: { userId: string; socialAccountId: string },
  source: { table: string; columns: string; timestamp: string; asOf: string },
  signal: AbortSignal,
): Promise<Record<string, unknown>[]> {
  const history: Record<string, unknown>[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < 40; page++) {
    let query = client.from(source.table).select(source.columns, { count: "exact" })
      .eq("user_id", scope.userId).eq("social_account_id", scope.socialAccountId)
      .lte(source.timestamp, source.asOf).order("id", { ascending: true })
      .limit(PAGE_SIZE).abortSignal(signal);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error, count } = await readReportQuery(query, signal);
    if (error) throw new ReportHistoryUnavailableError(`Failed to read report history: ${error.message}`);
    if (!data || count === null || !Number.isSafeInteger(count) || count < data.length || count > MAX_HISTORY_ROWS - history.length) {
      throw new ReportHistoryUnavailableError("Report history exceeds the bounded reader or lacks a verified count");
    }
    for (const row of data) {
      if (typeof row.id !== "string" || (afterId !== null && row.id <= afterId)) {
        throw new ReportHistoryUnavailableError("Report history did not advance consistently");
      }
      afterId = row.id;
      history.push(row);
    }
    if (count === data.length) return history;
    if (data.length === 0) break;
  }
  throw new ReportHistoryUnavailableError("Report history traversal exhausted its page budget");
}
