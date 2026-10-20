const REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";

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
    });
    if (!response.ok) return false;
    const text = (await response.text()).trim();
    if (text === "") return true;
    const payload: unknown = JSON.parse(text);
    const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
    return code === undefined || code === "ok";
  } catch {
    return false;
  }
}
