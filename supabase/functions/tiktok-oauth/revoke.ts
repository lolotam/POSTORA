const REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
// A stalled TikTok must not keep the account from being disconnected in Postora.
const REVOKE_TIMEOUT_MS = 5000;

/**
 * Withdraws the user's authorization of this app in TikTok, so the next connect shows TikTok's permission
 * screen again instead of approving silently. TikTok answers a successful revoke with an empty body.
 * Never throws: disconnecting in Postora must not depend on TikTok being reachable.
 */
export async function revokeTikTokAccess(
  fetcher: typeof fetch,
  clientKey: string,
  clientSecret: string,
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await fetcher(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: clientKey, client_secret: clientSecret, token: accessToken }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    if (text === "") return true;
    // Only the documented success shapes count: an empty body (above) or {"error":{"code":"ok"}}.
    // Anything else (a flat {"error":"invalid_client"}, {}, null, an unexpected object) is not a confirmed revoke.
    const payload: unknown = JSON.parse(text);
    const error = (payload as { error?: unknown } | null)?.error;
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ok";
  } catch {
    return false;
  }
}
