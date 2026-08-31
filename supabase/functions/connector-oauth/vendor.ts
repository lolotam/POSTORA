// Vendor-specific OAuth helpers for Salla, Zid, Shopify.
// No credentials are invented here: every method reads from the injected
// VendorCredentials or from Deno.env, and returns a typed "not configured"
// result when they are absent — §15 says real app registrations do not
// exist yet, and a silent no-op would hide that fact.
//
// Every outbound fetch in this module has an explicit timeout (§26) and
// passes assertPublicHttpsUrl on every redirect hop (imported from
// ai-agent-reply/tools.ts, not reimplemented).

import { assertPublicHttpsUrl } from "../ai-agent-reply/tools.ts";

export type OAuthConnectorType = "salla" | "zid" | "shopify";

export interface VendorCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface VendorTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  // vendor may return extra fields; we keep only what we store
  token_type?: string;
}

export interface VendorDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  assertPublicHttpsUrl: typeof assertPublicHttpsUrl;
  timeoutMs: number;
  maxRedirects: number;
  getCredentials(connectorType: OAuthConnectorType, shopDomain?: string): VendorCredentials | null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchWithTimeoutAndSsrfValidation(
  url: string,
  init: RequestInit,
  deps: VendorDependencies,
): Promise<Response> {
  let currentUrl = await deps.assertPublicHttpsUrl(url);
  const origin = currentUrl.origin;

  for (let hop = 0; hop <= deps.maxRedirects; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deps.timeoutMs);
    let response: Response;
    try {
      response = await deps.fetch(currentUrl.toString(), {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      throw e;
    }
    clearTimeout(timeout);

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("Location");
    if (!location) throw new Error("OAuth redirect omitted Location");
    if (hop === deps.maxRedirects) throw new Error("OAuth too many redirects");
    const next = new URL(location, currentUrl);
    currentUrl = await deps.assertPublicHttpsUrl(next.toString());
    if (currentUrl.origin !== origin) throw new Error("OAuth redirect changed origin");
  }
  throw new Error("OAuth too many redirects");
}

export function buildAuthorizationUrl(
  connectorType: OAuthConnectorType,
  state: string,
  deps: VendorDependencies,
  shopDomain?: string,
): string | null {
  const creds = deps.getCredentials(connectorType, shopDomain);
  if (!creds) return null;

  if (connectorType === "shopify") {
    if (!shopDomain) return null;
    // shopDomain already validated by caller as *.myshopify.com or custom; the
    // final URL is still passed through assertPublicHttpsUrl at fetch time,
    // but the auth URL itself is returned to the browser, so we validate shape here.
    const base = `https://${shopDomain}/admin/oauth/authorize`;
    const u = new URL(base);
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("scope", "read_products,read_orders,read_inventory");
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }
  if (connectorType === "salla") {
    const u = new URL("https://accounts.salla.sa/oauth2/auth");
    u.searchParams.set("client_id", creds.clientId);
    u.searchParams.set("redirect_uri", creds.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "offline_access");
    u.searchParams.set("state", state);
    return u.toString();
  }
  // zid
  const u = new URL("https://oauth.zid.sa/oauth/authorize");
  u.searchParams.set("client_id", creds.clientId);
  u.searchParams.set("redirect_uri", creds.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

function tokenEndpoint(connectorType: OAuthConnectorType, shopDomain?: string): string {
  if (connectorType === "shopify") return `https://${shopDomain}/admin/oauth/access_token`;
  if (connectorType === "salla") return "https://accounts.salla.sa/oauth2/token";
  return "https://oauth.zid.sa/oauth/token";
}

export async function exchangeCodeForTokens(
  connectorType: OAuthConnectorType,
  code: string,
  deps: VendorDependencies,
  shopDomain?: string,
): Promise<VendorTokenResponse> {
  const creds = deps.getCredentials(connectorType, shopDomain);
  if (!creds) throw new Error("OAuth credentials not configured");

  const endpoint = tokenEndpoint(connectorType, shopDomain);
  // Code, client_secret, etc. are intentionally NOT logged and NOT included
  // in any thrown message verbatim. A network error's message is wrapped
  // before propagation so a vendor echo cannot leak the code.
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", creds.redirectUri);
  body.set("client_id", creds.clientId);
  body.set("client_secret", creds.clientSecret);

  let response: Response;
  try {
    response = await fetchWithTimeoutAndSsrfValidation(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, deps);
  } catch {
    throw new Error("OAuth token exchange failed");
  }

  if (!response.ok) {
    throw new Error("OAuth token exchange failed");
  }
  const data = await response.json() as Record<string, unknown>;
  const access = typeof data.access_token === "string" ? data.access_token : null;
  if (!access) throw new Error("OAuth token exchange failed");
  return {
    access_token: access,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

export async function refreshVendorTokens(
  connectorType: OAuthConnectorType,
  refreshToken: string,
  deps: VendorDependencies,
  shopDomain?: string,
): Promise<VendorTokenResponse> {
  const creds = deps.getCredentials(connectorType, shopDomain);
  if (!creds) throw new Error("OAuth credentials not configured");

  const endpoint = tokenEndpoint(connectorType, shopDomain);
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", creds.clientId);
  body.set("client_secret", creds.clientSecret);

  let response: Response;
  try {
    response = await fetchWithTimeoutAndSsrfValidation(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, deps);
  } catch {
    throw new Error("OAuth refresh failed");
  }
  if (!response.ok) throw new Error("OAuth refresh failed");
  const data = await response.json() as Record<string, unknown>;
  const access = typeof data.access_token === "string" ? data.access_token : null;
  if (!access) throw new Error("OAuth refresh failed");
  return {
    access_token: access,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

export function defaultVendorDependencies(): VendorDependencies {
  return {
    fetch,
    assertPublicHttpsUrl,
    timeoutMs: 8_000,
    maxRedirects: 3,
    getCredentials(connectorType) {
      // Seam: real credentials live in vendor dashboards (§15) and are not
      // committed. They are supplied via env vars of the form SALLA_CLIENT_ID etc.
      // Returning null makes the seam explicit — the caller gets a 503 rather
      // than a silent no-op.
      const prefix = connectorType.toUpperCase();
      const clientId = Deno.env.get(`${prefix}_CLIENT_ID`) ?? "";
      const clientSecret = Deno.env.get(`${prefix}_CLIENT_SECRET`) ?? "";
      const redirectUri = Deno.env.get(`${prefix}_REDIRECT_URI`) ??
        Deno.env.get("CONNECTOR_OAUTH_REDIRECT_URI") ?? "";
      if (!clientId || !clientSecret || !redirectUri) return null;
      return { clientId, clientSecret, redirectUri };
    },
  };
}
