// TikTok only accepts the redirect URI registered on the production app,
// https://postora.cloud/tiktok-callback, so its answer lands on this frontend
// page instead of on the tiktok-oauth edge function. A flow started by the edge
// function carries a signed `state`; that answer is handed to the edge
// function unchanged, which verifies the state, keeps reconnect mode and the
// return path, exchanges the code and redirects back. An answer without a
// state is left to the page's own legacy handling.
export function tiktokBackendCallbackUrl(
  search: URLSearchParams,
  supabaseUrl: string,
): string | null {
  if (!search.get("state")) return null;
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/functions/v1/tiktok-oauth?${search.toString()}`;
}
