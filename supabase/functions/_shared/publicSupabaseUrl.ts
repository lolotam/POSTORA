/**
 * The Supabase base URL a *browser* can reach.
 *
 * Inside the edge-functions container `SUPABASE_URL` is the in-cluster address
 * (`http://kong:8000`). That is the right value for server-to-server calls and
 * the wrong one for any URL handed back to a client: storage-js builds signed
 * URLs absolutely from the client's base, so a client constructed from
 * `SUPABASE_URL` mints links that resolve nowhere outside the cluster.
 *
 * `SUPABASE_PUBLIC_URL` and `API_EXTERNAL_URL` both carry the external origin
 * on this stack. The internal value remains the last resort so a local stack
 * with neither set still works.
 *
 * This rule was already inlined in `whatsappMediaResolver.ts`,
 * `generate-image/index.ts` and `whatsapp-evolution-bridge/index.ts` before it
 * had a home. New callers use this; those three keep their copies until they
 * are next touched, since changing them means redeploying three more functions.
 */
export function publicSupabaseUrl(): string {
  return (
    Deno.env.get("SUPABASE_PUBLIC_URL") ||
    Deno.env.get("API_EXTERNAL_URL") ||
    Deno.env.get("SUPABASE_URL") ||
    ""
  );
}
