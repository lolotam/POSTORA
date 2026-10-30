/**
 * The message an edge function gave for a failed call.
 *
 * supabase-js throws `FunctionsHttpError` for any non-2xx reply and reduces its message to
 * "Edge Function returned a non-2xx status code"; the function's own explanation is only in the
 * body of `error.context`, which is the `Response`.
 */
const GENERIC_HTTP_ERROR = /non-2xx status code/i;

export async function invokeErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const payload = await context.clone().json().catch(() => null) as { error?: unknown } | null;
    if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  }
  if (error instanceof Error && error.message && !GENERIC_HTTP_ERROR.test(error.message)) return error.message;
  return fallback;
}
