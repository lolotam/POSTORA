import { supabase } from "@/integrations/supabase/client";

/**
 * Shared caller for action-dispatching edge functions. Retries gateway errors
 * (502/503/504) because the self-hosted Kong gateway intermittently drops
 * requests under load.
 *
 * Note: several older components/hooks still carry local copies of this
 * helper (useMessaging, useWhatsAppCatalog, ConversationDetail,
 * WhatsAppCatalogContent, WhatsAppTemplatesContent). New code should import
 * from here; consolidating the old copies is tracked as a separate cleanup.
 */
export class EdgeApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "EdgeApiError";
    this.status = status;
  }
}

export interface CallEdgeApiOptions {
  /** Gateway retries stay on unless a caller opts out. Saved test runs pass false. */
  retry?: boolean;
  signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function callEdgeApi(
  functionName: string,
  action: string,
  body: Record<string, unknown>,
  options: CallEdgeApiOptions = {},
) {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const retry = options.retry !== false;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
    body: JSON.stringify({ action, ...body }),
    signal: options.signal,
  };
  let res: Response | null = null;
  let lastErr: unknown = null;
  const maxAttempts = retry ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      res = await fetch(url, init);
      if (!retry || (res.status !== 502 && res.status !== 503 && res.status !== 504)) break;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastErr = err;
      if (!retry) break;
    }
    if (retry) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res) {
    throw new EdgeApiError(lastErr instanceof Error ? lastErr.message : "Network error", null);
  }
  const payload = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) {
    const reported = payload && typeof payload === "object" && typeof payload.error === "string" && payload.error
      ? payload.error
      : `API error ${res.status}`;
    throw new EdgeApiError(reported, res.status);
  }
  return payload;
}

export function callMessagingApi(action: string, body: Record<string, unknown>) {
  return callEdgeApi("messaging-api", action, body);
}
