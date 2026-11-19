export type GoogleRevokeResult =
  | { ok: true; alreadyInvalid: boolean }
  | { ok: false; status: number; reason: string };

const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GOOGLE_REVOKE_TIMEOUT_MS = 10_000;
const ALREADY_INVALID_ERRORS = new Set(["invalid_token", "invalid_grant"]);

/**
 * Revokes a Google OAuth grant via the RFC 7009 revocation endpoint.
 *
 * The token is sent strictly in the POST form body (never in the URL) so it
 * cannot appear in proxy or access logs. A 400 with `invalid_token` or
 * `invalid_grant` means Google already considers the grant invalid and is
 * treated as already revoked; every other non-2xx or transport failure fails
 * closed so the caller does not clear local credentials on an unconfirmed revoke.
 */
export async function revokeGoogleToken(
  fetchImpl: typeof fetch,
  token: string,
): Promise<GoogleRevokeResult> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(GOOGLE_REVOKE_TIMEOUT_MS),
    });

    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: true, alreadyInvalid: false };
    }

    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      const errorCode = body && typeof body === "object"
        ? (body as { error?: unknown }).error
        : undefined;
      if (typeof errorCode === "string" && ALREADY_INVALID_ERRORS.has(errorCode)) {
        return { ok: true, alreadyInvalid: true };
      }
      return { ok: false, status: 400, reason: "google_revoke_rejected" };
    }

    await response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, reason: "google_revoke_failed" };
  } catch {
    return { ok: false, status: 502, reason: "google_revoke_failed" };
  }
}
