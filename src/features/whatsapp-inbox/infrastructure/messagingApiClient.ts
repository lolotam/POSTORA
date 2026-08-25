import { supabase } from "@/integrations/supabase/client";

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * The single messaging-api caller for this feature.
 *
 * ConversationDetail carries a second, hand-rolled copy of this helper that silently lacks
 * the retry below, so a cold edge-function start surfaces to the user as a failed send.
 * The fork deliberately does not inherit that copy.
 */
export async function callMessagingApi<T = unknown>(
  action: string,
  body: Record<string, unknown>,
): Promise<T> {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  let lastError: Error = new Error(`${action} failed`);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${supabaseUrl}/functions/v1/messaging-api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: anonKey,
      },
      body: JSON.stringify({ action, ...body }),
    });

    const payload = await response.json().catch(() => ({ error: response.statusText }));

    // A typed application error is final -- retrying it just delays the message the user needs.
    if (payload?.error_type) throw new Error(payload.error);
    if (response.ok) return payload as T;

    lastError = new Error(payload?.error || `API error ${response.status}`);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
  }
  throw lastError;
}
