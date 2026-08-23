/**
 * Higgsfield Hub OAuth 2.1 (PKCE + RFC 7591 dynamic client registration).
 *
 * Higgsfield issues no public client_id, so the app registers itself once per
 * redirect_uri and caches the credentials in `oauth_clients`. Endpoints are
 * discovered rather than hardcoded — they have already moved once.
 *
 * Access/refresh tokens live in `provider_api_keys` (deny-all under RLS,
 * service role only). They must never be returned to a client or logged.
 */

export const HIGGSFIELD_PROVIDER_CODE = "higgsfield";

/** The MCP resource these tokens are scoped to (RFC 8707). */
export const HIGGSFIELD_MCP_RESOURCE = "https://mcp.higgsfield.ai/mcp";

/** Where discovery starts. Everything else is read from the metadata. */
const HIGGSFIELD_ISSUER = "https://mcp.higgsfield.ai";

/**
 * Hosts we will accept as an authorization server.
 *
 * The protected-resource document advertises its issuers, but honouring an
 * arbitrary one would let a compromised or spoofed document redirect our client
 * secret and refresh tokens to a host of the attacker's choosing.
 */
const ALLOWED_ISSUER_HOSTS = new Set(["mcp.higgsfield.ai", "fnf-device-auth.higgsfield.ai"]);

const REQUIRED_SCOPE = "openid email offline_access";

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** Ceiling on any single outbound call to Higgsfield. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Re-discover periodically so a stale or degraded document cannot stick. */
const METADATA_TTL_MS = 10 * 60_000;

export class HiggsfieldAuthError extends Error {
  constructor(
    public readonly code: "HIGGSFIELD_NOT_CONNECTED" | "HIGGSFIELD_REAUTH_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "HiggsfieldAuthError";
  }
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string | null;
  revocation_endpoint?: string | null;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OAuthClient {
  client_id: string;
  client_secret: string | null;
  issuer: string;
  redirect_uri: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  account_id: string | null;
  account_email: string | null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

let metadataCache: { value: AuthServerMetadata; fetchedAt: number } | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`${url} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — surface the raw text in the error below.
  }
  if (!res.ok) {
    const detail = body?.error_description || body?.error || text.slice(0, 300);
    throw new Error(`${url} responded ${res.status}: ${detail}`);
  }
  return body;
}

/**
 * Resolve the authorization server metadata, preferring the authorization
 * server advertised by the protected resource document.
 */
export async function discoverMetadata(): Promise<AuthServerMetadata> {
  if (metadataCache && Date.now() - metadataCache.fetchedAt < METADATA_TTL_MS) {
    return metadataCache.value;
  }

  let issuer = HIGGSFIELD_ISSUER;
  try {
    const prm = await fetchJson(`${HIGGSFIELD_ISSUER}/.well-known/oauth-protected-resource`);
    const advertised = Array.isArray(prm?.authorization_servers)
      ? prm.authorization_servers[0]
      : null;
    if (typeof advertised === "string") {
      const url = new URL(advertised);
      if (url.protocol === "https:" && ALLOWED_ISSUER_HOSTS.has(url.hostname)) {
        issuer = advertised.replace(/\/$/, "");
      } else {
        console.warn(
          `[higgsfield-oauth] ignoring advertised issuer outside the allowlist: ${url.hostname}`,
        );
      }
    }
  } catch (err) {
    // The protected-resource document is optional; fall back to the known issuer.
    console.warn("[higgsfield-oauth] protected-resource discovery failed:", (err as Error).message);
  }

  const meta = (await fetchJson(
    `${issuer}/.well-known/oauth-authorization-server`,
  )) as AuthServerMetadata;
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error("Higgsfield authorization server metadata is missing required endpoints");
  }

  // Endpoints drive where the client secret and tokens are sent, so pin their
  // hosts too rather than trusting whatever the document returns.
  for (const [name, endpoint] of Object.entries({
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    registration_endpoint: meta.registration_endpoint,
  })) {
    if (!endpoint) continue;
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !ALLOWED_ISSUER_HOSTS.has(url.hostname)) {
      throw new Error(`Higgsfield ${name} points at an untrusted host: ${url.hostname}`);
    }
  }

  metadataCache = { value: meta, fetchedAt: Date.now() };
  return meta;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

/**
 * Return the cached OAuth client for this redirect_uri, registering one on
 * first use. Registration is per redirect_uri because that is what the
 * authorization server binds the client to.
 */
export async function getOrRegisterClient(
  supabase: { from: (t: string) => any },
  redirectUri: string,
): Promise<OAuthClient> {
  const { data: existing, error } = await supabase
    .from("oauth_clients")
    .select("client_id, client_secret, issuer, redirect_uri")
    .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
    .eq("redirect_uri", redirectUri)
    .maybeSingle();

  if (error) {
    console.error("[higgsfield-oauth] oauth_clients read failed:", error.message);
  }
  if (existing?.client_id) {
    return existing as OAuthClient;
  }

  const meta = await discoverMetadata();
  if (!meta.registration_endpoint) {
    throw new Error(
      "Higgsfield does not advertise a registration endpoint and no client is configured",
    );
  }

  const registration = await fetchJson(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Shown on Higgsfield's consent screen — this is what a user sees when
      // authorizing, so it must name this product, not the one this was ported from.
      client_name: "Postora",
      // Consent-screen branding. logo_uri must stay a live square asset: /logo.png
      // 404s and the og-image is 1536x1024 (wrong shape for a consent avatar), and a
      // dead image renders worse than the placeholder.
      client_uri: "https://postora.cloud",
      logo_uri: "https://openinary.walidmohamed.com/t/postora.cloud/logo2.png",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: REQUIRED_SCOPE,
    }),
  });

  if (!registration?.client_id) {
    throw new Error("Higgsfield dynamic client registration returned no client_id");
  }

  const client: OAuthClient = {
    client_id: registration.client_id,
    client_secret: registration.client_secret ?? null,
    issuer: meta.issuer || HIGGSFIELD_ISSUER,
    redirect_uri: redirectUri,
  };

  const { error: insertErr } = await supabase.from("oauth_clients").insert({
    provider_code: HIGGSFIELD_PROVIDER_CODE,
    issuer: client.issuer,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    client_secret: client.client_secret,
    registration_response: registration,
  });

  if (insertErr) {
    // A concurrent request may have registered first; prefer the stored row.
    console.warn("[higgsfield-oauth] oauth_clients insert failed:", insertErr.message);
    const { data: raced } = await supabase
      .from("oauth_clients")
      .select("client_id, client_secret, issuer, redirect_uri")
      .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
      .eq("redirect_uri", redirectUri)
      .maybeSingle();
    if (raced?.client_id) return raced as OAuthClient;
  }

  return client;
}

// ---------------------------------------------------------------------------
// Authorization + token exchange
// ---------------------------------------------------------------------------

export async function buildAuthorizeUrl(params: {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): Promise<string> {
  const meta = await discoverMetadata();
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.client.client_id);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", REQUIRED_SCOPE);
  url.searchParams.set("resource", HIGGSFIELD_MCP_RESOURCE);
  return url.toString();
}

/** Decode a JWT payload without verifying. Informational use only. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function toTokenSet(payload: any): TokenSet {
  if (!payload?.access_token) {
    throw new Error("Higgsfield token endpoint returned no access_token");
  }

  const expiresIn = Number(payload.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : null;

  let accountId: string | null = null;
  if (typeof payload.id_token === "string") {
    const claims = decodeJwtPayload(payload.id_token);
    if (typeof claims?.email === "string") accountId = claims.email;
  }

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? null,
    expires_at: expiresAt,
    scope: payload.scope ?? null,
    account_id: accountId,
    account_email: typeof payload.id_token === "string" ? (decodeJwtPayload(payload.id_token)?.email as string | undefined) ?? null : null,
  };
}

function tokenRequestBody(client: OAuthClient, extra: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams({
    client_id: client.client_id,
    resource: HIGGSFIELD_MCP_RESOURCE,
    ...extra,
  });
  if (client.client_secret) {
    body.set("client_secret", client.client_secret);
  }
  return body;
}

export async function exchangeCode(params: {
  client: OAuthClient;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const meta = await discoverMetadata();
  const payload = await fetchJson(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(params.client, {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  });
  return toTokenSet(payload);
}

export async function refreshTokens(params: {
  client: OAuthClient;
  refreshToken: string;
}): Promise<TokenSet> {
  const meta = await discoverMetadata();
  const payload = await fetchJson(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(params.client, {
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }).toString(),
  });
  return toTokenSet(payload);
}

// ---------------------------------------------------------------------------
// Stored connection
// ---------------------------------------------------------------------------

export interface StoredConnection {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  scope: string | null;
  account_id: string | null;
  meta: Record<string, unknown> | null;
}

export async function loadConnection(supabase: {
  from: (t: string) => any;
}): Promise<StoredConnection | null> {
  const { data, error } = await supabase
    .from("provider_api_keys")
    .select("access_token, refresh_token, expires_at, scope, account_id, meta")
    .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
    .maybeSingle();

  if (error) {
    console.error("[higgsfield-oauth] provider_api_keys read failed:", error.message);
    return null;
  }
  return (data as StoredConnection) ?? null;
}

export async function persistTokens(
  supabase: { from: (t: string) => any },
  tokens: TokenSet,
  opts: { redirectUri: string; createdBy?: string | null; previous?: StoredConnection | null },
): Promise<void> {
  const previousMeta = (opts.previous?.meta ?? {}) as Record<string, unknown>;

  const row: Record<string, unknown> = {
    provider_code: HIGGSFIELD_PROVIDER_CODE,
    auth_type: "oauth",
    access_token: tokens.access_token,
    // Higgsfield may rotate the refresh token; keep the previous one only when
    // the response omits a replacement.
    refresh_token: tokens.refresh_token ?? opts.previous?.refresh_token ?? null,
    expires_at: tokens.expires_at,
    scope: tokens.scope ?? opts.previous?.scope ?? null,
    account_id: tokens.account_id ?? opts.previous?.account_id ?? null,
    meta: { ...previousMeta, redirect_uri: opts.redirectUri },
    updated_at: new Date().toISOString(),
  };
  if (opts.createdBy) row.created_by = opts.createdBy;

  const { error } = await supabase
    .from("provider_api_keys")
    .upsert(row, { onConflict: "provider_code" });

  if (error) {
    throw new Error(`Failed to store Higgsfield tokens: ${error.message}`);
  }
}

/**
 * Return a usable access token, refreshing first when it is at or near expiry.
 *
 * Throws HiggsfieldAuthError so callers can map to an actionable message
 * instead of a generic 500.
 */
export async function getValidAccessToken(supabase: { from: (t: string) => any }): Promise<string> {
  const connection = await loadConnection(supabase);

  if (!connection?.access_token && !connection?.refresh_token) {
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_NOT_CONNECTED",
      "Higgsfield is not connected. Connect it in Admin → Settings → AI → Higgsfield.",
    );
  }

  const expiresAt = connection.expires_at ? Date.parse(connection.expires_at) : NaN;
  const expiringSoon = Number.isFinite(expiresAt) && expiresAt - Date.now() <= REFRESH_SKEW_MS;

  if (connection.access_token && !expiringSoon) {
    return connection.access_token;
  }

  if (!connection.refresh_token) {
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "The Higgsfield session expired and no refresh token is stored. Reconnect Higgsfield.",
    );
  }

  const redirectUri = (connection.meta?.redirect_uri as string | undefined) ?? "";
  if (!redirectUri) {
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "The stored Higgsfield connection is missing its redirect URI. Reconnect Higgsfield.",
    );
  }

  try {
    const client = await getOrRegisterClient(supabase, redirectUri);
    const tokens = await refreshTokens({ client, refreshToken: connection.refresh_token });
    await persistTokens(supabase, tokens, { redirectUri, previous: connection });
    return tokens.access_token;
  } catch (err) {
    console.error("[higgsfield-oauth] refresh failed:", (err as Error).message);
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "Could not refresh the Higgsfield session. Reconnect Higgsfield.",
    );
  }
}

export type HiggsfieldCredentialSource = "byo" | "platform";
export interface HiggsfieldCredential {
  accessToken: string;
  source: HiggsfieldCredentialSource;
  accountId: string | null;
  /**
   * Re-resolves THIS connection's token after a mid-session 401, returning the new
   * access token. Pass it to `HiggsfieldMcpClient.fromCredential` so a retry stays
   * on the same account: refreshing the platform token for a BYO caller would bill
   * the admin for that user's work and defeat "a BYO job never falls back to the
   * platform token". Throws `HiggsfieldAuthError` when re-auth is genuinely needed.
   */
  refresh: () => Promise<string>;
}

/** Force a BYO refresh, persist the rotated tokens, and return the new access token. */
async function refreshByoConnection(
  supabaseAdmin: { from: (table: string) => any },
  userId: string,
): Promise<string> {
  const { data: row } = await supabaseAdmin
    .from("higgsfield_connections")
    .select("refresh_token, scope, account_id, meta")
    .eq("user_id", userId)
    .maybeSingle();
  if (!row?.refresh_token) {
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "Reconnect your Higgsfield account.",
    );
  }
  const { data: client } = await supabaseAdmin
    .from("oauth_clients")
    .select("client_id, client_secret, issuer, redirect_uri")
    .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
    .eq("redirect_uri", row.meta?.redirect_uri ?? "")
    .maybeSingle();
  if (!client) {
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "Reconnect your Higgsfield account.",
    );
  }
  const tokens = await refreshTokens({
    client: client as OAuthClient,
    refreshToken: row.refresh_token,
  });
  const { error } = await supabaseAdmin
    .from("higgsfield_connections")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? row.refresh_token,
      expires_at: tokens.expires_at,
      scope: tokens.scope ?? row.scope,
      account_id: tokens.account_id ?? row.account_id,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to persist Higgsfield BYO refresh: ${error.message}`);
  return tokens.access_token;
}

/** Resolve BYO first; a BYO connection is never silently replaced by platform credentials. */
export async function resolveHiggsfieldCredential(
  supabaseAdmin: { from: (table: string) => any },
  userId: string,
): Promise<HiggsfieldCredential> {
  const { data: byo, error: byoError } = await supabaseAdmin
    .from("higgsfield_connections")
        .select("access_token, refresh_token, expires_at, scope, account_id, account_email, meta")
    .eq("user_id", userId)
    .maybeSingle();
  if (byoError) throw new Error(`Higgsfield connection lookup failed: ${byoError.message}`);
  if (byo) {
    const expiresAt = byo.expires_at ? Date.parse(byo.expires_at) : NaN;
    if (
      byo.access_token &&
      (!Number.isFinite(expiresAt) || expiresAt - Date.now() > REFRESH_SKEW_MS)
    ) {
      return {
        accessToken: byo.access_token,
        source: "byo",
        accountId: byo.account_id ?? byo.account_email ?? null,
        refresh: () => refreshByoConnection(supabaseAdmin, userId),
      };
    }
    if (byo.refresh_token) {
      const { data: client } = await supabaseAdmin
        .from("oauth_clients")
        .select("client_id, client_secret, issuer, redirect_uri")
          .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
          .eq("redirect_uri", byo.meta?.redirect_uri ?? "")
        .maybeSingle();
      if (client) {
        const tokens = await refreshTokens({
          client: client as OAuthClient,
          refreshToken: byo.refresh_token,
        });
        const { error } = await supabaseAdmin
          .from("higgsfield_connections")
          .update({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token ?? byo.refresh_token,
            expires_at: tokens.expires_at,
            scope: tokens.scope ?? byo.scope,
            account_id: tokens.account_id ?? byo.account_id,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        if (error) throw new Error(`Failed to persist Higgsfield BYO refresh: ${error.message}`);
        return {
          accessToken: tokens.access_token,
          source: "byo",
          accountId: tokens.account_id ?? byo.account_id ?? byo.account_email ?? null,
          refresh: () => refreshByoConnection(supabaseAdmin, userId),
        };
      }
    }
    throw new HiggsfieldAuthError(
      "HIGGSFIELD_REAUTH_REQUIRED",
      "Reconnect your Higgsfield account.",
    );
  }
  const platform = await loadConnection(supabaseAdmin);
  if (platform?.access_token) {
    return {
      accessToken: await getValidAccessToken(supabaseAdmin),
      source: "platform",
      accountId: platform.account_id,
      refresh: () => getValidAccessToken(supabaseAdmin),
    };
  }
  throw new HiggsfieldAuthError("HIGGSFIELD_NOT_CONNECTED", "Higgsfield is not connected.");
}

export interface OAuthState {
  state: string;
  provider_code: string;
  code_verifier: string;
  redirect_uri: string;
  scope_kind: "platform" | "user";
  user_id: string | null;
  return_to: string | null;
  expires_at: string;
}

/** Atomically consume an unexpired state, then enforce the callback trust scope. */
export async function consumeOAuthState(
  supabaseAdmin: { from: (table: string) => any },
  state: string,
  _expectedScope: "platform" | "user" | undefined,
  sessionUserId: string | null,
  isAdmin: boolean,
): Promise<OAuthState | null> {
  const { data, error } = await supabaseAdmin
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();
  if (error || !data) return null;
  if (data.scope_kind === "platform" && !isAdmin)
    throw new Error("Authorization state requires admin access for a platform connection");
  if (data.scope_kind === "user" && (!sessionUserId || data.user_id !== sessionUserId))
    throw new Error("Authorization state belongs to a different user");
  return data as OAuthState;
}
