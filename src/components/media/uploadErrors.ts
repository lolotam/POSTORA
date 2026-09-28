export async function readUploadRefusal(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown }).context;
  const nested = (context as { response?: unknown } | undefined)?.response;
  const response = context instanceof Response ? context : nested instanceof Response ? nested : undefined;
  if (!response) return error instanceof Error ? error.message : null;
  const payload = await response.clone().json().catch(() => null) as { error?: unknown } | null;
  if (typeof payload?.error === "string") return payload.error;
  return error instanceof Error ? error.message : null;
}
