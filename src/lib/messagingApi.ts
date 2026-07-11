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
export async function callEdgeApi(functionName: string, action: string, body: Record<string, unknown>) {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
    body: JSON.stringify({ action, ...body }),
  };
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, init);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res) throw (lastErr instanceof Error ? lastErr : new Error("Network error"));
  const data = await res.json().catch(() => ({ error: res!.statusText }));
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

export function callMessagingApi(action: string, body: Record<string, unknown>) {
  return callEdgeApi("messaging-api", action, body);
}
