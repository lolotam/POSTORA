/**
 * Disconnect of a Facebook Page or Page-linked Instagram account.
 *
 * One Facebook user grant (facebook_user_credentials) backs every Postora
 * account connected through that login. De-authorizing the app invalidates
 * every user token of that grant, so it happens only when the removed
 * account is the grant's last member; a sibling keeps working and its own
 * reconnect shows the permission screen through auth_type=rerequest.
 *
 * The revoke carries the app access token. The stored user token is never
 * read here.
 */
export type DisconnectOutcome =
  | { revoked: false; reason: "no_binding" | "grant_shared" | "revoke_failed" | "credential_missing" }
  | { revoked: true; reason: null };

export interface DisconnectPorts {
  /** The binding of this account, or null. Scoped to the owner by the caller. */
  readBinding(accountId: string): Promise<{ credential_id: string } | null>;
  /** How many bindings share the credential. */
  countGrantMembers(credentialId: string): Promise<number>;
  /** The Facebook user id the credential was issued to, or null. */
  readProviderUserId(credentialId: string): Promise<string | null>;
  /** fetch, injected for tests. */
  fetch: typeof fetch;
}

const GRAPH_VERSION = "v22.0";

export async function revokeFacebookGrant(
  fetchImpl: typeof fetch,
  app: { appId: string; appSecret: string },
  providerUserId: string,
): Promise<boolean> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(providerUserId)}/permissions`);
  url.searchParams.set("access_token", `${app.appId}|${app.appSecret}`);
  try {
    const response = await fetchImpl(url, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body === true || (typeof body === "object" && body !== null && (body as { success?: unknown }).success === true);
  } catch {
    // Meta unreachable or a malformed reply: the account is still removed in Postora.
    return false;
  }
}

export async function decideDisconnect(
  ports: DisconnectPorts,
  app: { appId: string; appSecret: string },
  accountId: string,
): Promise<DisconnectOutcome> {
  const binding = await ports.readBinding(accountId);
  if (!binding) return { revoked: false, reason: "no_binding" };
  const members = await ports.countGrantMembers(binding.credential_id);
  // A count of zero means the binding is already gone: there is no grant left
  // to withdraw, so the removal stays a Postora-only operation.
  if (members < 1) return { revoked: false, reason: "no_binding" };
  if (members > 1) return { revoked: false, reason: "grant_shared" };
  const providerUserId = await ports.readProviderUserId(binding.credential_id);
  if (!providerUserId) return { revoked: false, reason: "credential_missing" };
  const revoked = await revokeFacebookGrant(ports.fetch, app, providerUserId);
  return revoked ? { revoked: true, reason: null } : { revoked: false, reason: "revoke_failed" };
}
