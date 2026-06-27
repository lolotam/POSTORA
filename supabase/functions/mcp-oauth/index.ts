// Postora MCP OAuth 2.1 Authorization Server + RFC 7591 Dynamic Client
// Registration shim. Lets MCP clients (Claude Desktop, ChatGPT, Antigravity,
// Claude Code, etc.) register themselves and obtain a Bearer token bound to a
// Postora user account.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
if (!SERVICE_ROLE) console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY is missing!");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Public hostnames. Allow env overrides so preview environments work too.
const APP_ORIGIN = Deno.env.get("PUBLIC_APP_ORIGIN") ?? "https://postora.cloud";
const API_ORIGIN = Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const ISSUER = APP_ORIGIN;
const MCP_RESOURCE = `${API_ORIGIN}/functions/v1/mcp`;

// INTENTIONALLY PERMISSIVE CORS: mcp-oauth is a standards-compliant MCP OAuth 2.0
// authorization server (RFC 8414/9700). Its clients (Claude Desktop, other MCP hosts)
// connect from arbitrary localhost origins (http://localhost:<random-port>) that cannot
// be allow-listed. Restricted CORS here would break MCP client discovery and token
// exchange. This endpoint issues no Access-Control-Allow-Credentials, so browsers will
// not attach cookies/auth to cross-origin reads; authentication is via signed PKCE
// authorization codes and client secrets, not ambient credentials.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });

const oauthError = (
  error: string,
  description?: string,
  status = 400,
) => json({ error, error_description: description }, status);

// ---------- crypto helpers ----------
function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function base64UrlEncode(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(buf);
}

// Service role client (bypasses RLS for OAuth bookkeeping)
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- discovery ----------
function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    resource_documentation: `${APP_ORIGIN}/docs/mcp-server`,
  };
}

function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${API_ORIGIN}/functions/v1/mcp-oauth/authorize`,
    token_endpoint: `${API_ORIGIN}/functions/v1/mcp-oauth/token`,
    registration_endpoint: `${API_ORIGIN}/functions/v1/mcp-oauth/register`,
    revocation_endpoint: `${API_ORIGIN}/functions/v1/mcp-oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: [
      "accounts:read",
      "posts:read",
      "posts:write",
      "media:write",
      "webhooks:manage",
    ],
    service_documentation: `${APP_ORIGIN}/docs/mcp-server`,
  };
}

// ---------- handlers ----------

// POST /register  (RFC 7591 Dynamic Client Registration)
async function handleRegister(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }

  const redirect_uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirect_uris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required");
  }
  for (const uri of redirect_uris) {
    if (typeof uri !== "string") {
      return oauthError("invalid_redirect_uri", "redirect_uris must be strings");
    }
    // Allow http(s), custom schemes (claude://, cursor://, etc.) and loopback.
    if (!/^([a-z][a-z0-9+.-]*):\/\//i.test(uri)) {
      return oauthError("invalid_redirect_uri", `Invalid redirect_uri: ${uri}`);
    }
  }

  const auth_method = body.token_endpoint_auth_method === "client_secret_basic" ||
      body.token_endpoint_auth_method === "client_secret_post"
    ? body.token_endpoint_auth_method
    : "none";

  const client_id = `mcp_${randomToken(16)}`;
  let client_secret: string | undefined;
  let client_secret_hash: string | null = null;
  if (auth_method !== "none") {
    client_secret = randomToken(32);
    client_secret_hash = await sha256(client_secret);
  }

  const { error } = await admin.from("mcp_oauth_clients").insert({
    client_id,
    client_secret_hash,
    client_name: String(body.client_name ?? "Unnamed MCP Client").slice(0, 200),
    client_uri: body.client_uri ?? null,
    logo_uri: body.logo_uri ?? null,
    software_id: body.software_id ?? null,
    software_version: body.software_version ?? null,
    redirect_uris,
    grant_types: Array.isArray(body.grant_types) && body.grant_types.length
      ? body.grant_types
      : ["authorization_code", "refresh_token"],
    response_types: Array.isArray(body.response_types) && body.response_types.length
      ? body.response_types
      : ["code"],
    token_endpoint_auth_method: auth_method,
    scope: body.scope ?? null,
  }).select("client_id").single();

  if (error) return oauthError("server_error", error.message, 500);

  return json({
    client_id,
    ...(client_secret ? { client_secret } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name ?? "Unnamed MCP Client",
    redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: auth_method,
    scope: body.scope ?? "accounts:read posts:read posts:write media:write webhooks:manage",
  }, 201);
}

// GET /authorize?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256&scope=...
// Stores a pending authorization row and redirects the user-agent to the SPA
// consent page.
async function handleAuthorize(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;
  const client_id = p.get("client_id") ?? "";
  const redirect_uri = p.get("redirect_uri") ?? "";
  const response_type = p.get("response_type") ?? "";
  const code_challenge = p.get("code_challenge") ?? "";
  const code_challenge_method = (p.get("code_challenge_method") ?? "S256").toUpperCase();
  const state = p.get("state") ?? "";
  const scope = p.get("scope") ?? "accounts:read posts:read posts:write media:write webhooks:manage";

  if (response_type !== "code") {
    return oauthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (code_challenge_method !== "S256") {
    return oauthError("invalid_request", "code_challenge_method must be S256");
  }
  if (!code_challenge) return oauthError("invalid_request", "code_challenge is required (PKCE)");
  if (!client_id) return oauthError("invalid_request", "client_id is required");
  if (!redirect_uri) return oauthError("invalid_request", "redirect_uri is required");

  const { data: client, error: clientErr } = await admin
    .from("mcp_oauth_clients")
    .select("client_id, redirect_uris, client_name")
    .eq("client_id", client_id)
    .maybeSingle();

  if (clientErr || !client) return oauthError("invalid_client", "Unknown client_id");
  if (!(client.redirect_uris as string[]).includes(redirect_uri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client");
  }

  const { data: authz, error: insertErr } = await admin
    .from("mcp_oauth_authorizations")
    .insert({
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();

  if (insertErr || !authz) {
    return oauthError("server_error", insertErr?.message ?? "Failed to create authorization", 500);
  }

  const target = new URL(`${APP_ORIGIN}/mcp/authorize`);
  target.searchParams.set("authorization_id", authz.id);
  return Response.redirect(target.toString(), 302);
}

// GET /authorization/:id — fetch details for the consent screen.
// Requires a logged-in Postora user (we pass the auth JWT in the Authorization header).
async function handleAuthorizationDetails(id: string, req: Request): Promise<Response> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userRes } = await userClient.auth.getUser();
  if (!userRes?.user) return oauthError("unauthorized", "Sign in required", 401);

  const { data: authz, error } = await admin
    .from("mcp_oauth_authorizations")
    .select("id, client_id, redirect_uri, scope, state, expires_at, code, user_id")
    .eq("id", id)
    .maybeSingle();

  if (error || !authz) return oauthError("invalid_request", "Authorization not found", 404);
  if (new Date(authz.expires_at).getTime() < Date.now()) {
    return oauthError("expired", "Authorization request expired", 410);
  }

  const { data: client } = await admin
    .from("mcp_oauth_clients")
    .select("client_id, client_name, client_uri, logo_uri")
    .eq("client_id", authz.client_id)
    .maybeSingle();

  return json({
    authorization_id: authz.id,
    client,
    redirect_uri: authz.redirect_uri,
    scopes: (authz.scope ?? "").split(/\s+/).filter(Boolean),
    expires_at: authz.expires_at,
  });
}

// POST /consent { authorization_id, approve: boolean }
// Called by the SPA after the user clicks Approve/Deny.
async function handleConsent(req: Request): Promise<Response> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userRes } = await userClient.auth.getUser();
  if (!userRes?.user) return oauthError("unauthorized", "Sign in required", 401);

  let body: any;
  try { body = await req.json(); } catch { return oauthError("invalid_request", "Body must be JSON"); }

  const id = body.authorization_id;
  if (!id) return oauthError("invalid_request", "authorization_id is required");

  const { data: authz, error } = await admin
    .from("mcp_oauth_authorizations")
    .select("id, client_id, redirect_uri, scope, state, expires_at, code")
    .eq("id", id)
    .maybeSingle();

  if (error || !authz) return oauthError("invalid_request", "Authorization not found", 404);
  if (new Date(authz.expires_at).getTime() < Date.now()) {
    return oauthError("expired", "Authorization request expired", 410);
  }

  const redirect = new URL(authz.redirect_uri);

  if (!body.approve) {
    redirect.searchParams.set("error", "access_denied");
    if (authz.state) redirect.searchParams.set("state", authz.state);
    return json({ redirect_to: redirect.toString() });
  }

  const code = randomToken(32);
  const { error: updErr } = await admin
    .from("mcp_oauth_authorizations")
    .update({
      user_id: userRes.user.id,
      code,
      consented_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updErr) return oauthError("server_error", updErr.message, 500);

  redirect.searchParams.set("code", code);
  if (authz.state) redirect.searchParams.set("state", authz.state);
  return json({ redirect_to: redirect.toString() });
}

// POST /token  (form-urlencoded or JSON)
async function handleToken(req: Request): Promise<Response> {
  const form = await readFormOrJson(req);
  const grant_type = form.get("grant_type") ?? "";

  if (grant_type === "authorization_code") {
    return handleAuthCodeGrant(req, form);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshGrant(form);
  }
  return oauthError("unsupported_grant_type", `grant_type ${grant_type} not supported`);
}

async function handleAuthCodeGrant(req: Request, form: URLSearchParams): Promise<Response> {
  const code = form.get("code") ?? "";
  const code_verifier = form.get("code_verifier") ?? "";
  const redirect_uri = form.get("redirect_uri") ?? "";
  const client_id_form = form.get("client_id") ?? "";
  const client_secret_form = form.get("client_secret") ?? "";

  if (!code || !code_verifier || !redirect_uri) {
    return oauthError("invalid_request", "code, code_verifier and redirect_uri are required");
  }

  // HTTP Basic auth takes precedence
  let client_id = client_id_form;
  let client_secret = client_secret_form;
  const basic = req.headers.get("Authorization");
  if (basic?.toLowerCase().startsWith("basic ")) {
    try {
      const [u, p] = atob(basic.slice(6)).split(":");
      client_id = decodeURIComponent(u);
      client_secret = decodeURIComponent(p ?? "");
    } catch { /* ignore */ }
  }

  const { data: authz } = await admin
    .from("mcp_oauth_authorizations")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (!authz) return oauthError("invalid_grant", "Authorization code not found");
  if (authz.code_used_at) return oauthError("invalid_grant", "Authorization code already used");
  if (new Date(authz.expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "Authorization code expired");
  }
  if (authz.client_id !== client_id) {
    return oauthError("invalid_client", "client_id does not match the authorization");
  }
  if (authz.redirect_uri !== redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
  }

  // PKCE check
  const challenge = await sha256(code_verifier);
  if (challenge !== authz.code_challenge) {
    return oauthError("invalid_grant", "PKCE verification failed");
  }

  // Optional client secret check
  const { data: client } = await admin
    .from("mcp_oauth_clients")
    .select("client_id, client_secret_hash, token_endpoint_auth_method")
    .eq("client_id", client_id)
    .maybeSingle();
  if (!client) return oauthError("invalid_client", "Unknown client_id");
  if (client.token_endpoint_auth_method !== "none") {
    if (!client_secret) return oauthError("invalid_client", "client_secret required");
    const hash = await sha256(client_secret);
    if (hash !== client.client_secret_hash) return oauthError("invalid_client", "Bad client_secret");
  }

  // Mark code used (single-use)
  await admin.from("mcp_oauth_authorizations")
    .update({ code_used_at: new Date().toISOString() })
    .eq("id", authz.id);

  return issueTokens({
    user_id: authz.user_id,
    client_id,
    scopes: (authz.scope ?? "").split(/\s+/).filter(Boolean),
  });
}

async function handleRefreshGrant(form: URLSearchParams): Promise<Response> {
  const refresh_token = form.get("refresh_token") ?? "";
  const client_id = form.get("client_id") ?? "";
  if (!refresh_token) return oauthError("invalid_request", "refresh_token required");

  const refresh_hash = await sha256(refresh_token);
  const { data: existing } = await admin
    .from("mcp_oauth_tokens")
    .select("*")
    .eq("refresh_token_hash", refresh_hash)
    .maybeSingle();

  if (!existing) return oauthError("invalid_grant", "Refresh token not found");
  if (existing.revoked_at) return oauthError("invalid_grant", "Refresh token revoked");
  if (existing.refresh_expires_at && new Date(existing.refresh_expires_at).getTime() < Date.now()) {
    return oauthError("invalid_grant", "Refresh token expired");
  }
  if (client_id && existing.client_id !== client_id) {
    return oauthError("invalid_grant", "client_id mismatch");
  }

  // Rotate: revoke old, issue new
  await admin.from("mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", existing.id);

  return issueTokens({
    user_id: existing.user_id,
    client_id: existing.client_id,
    scopes: existing.scopes,
  });
}

async function issueTokens(opts: { user_id: string; client_id: string; scopes: string[] }) {
  const access_token = randomToken(32);
  const refresh_token = randomToken(32);
  const access_hash = await sha256(access_token);
  const refresh_hash = await sha256(refresh_token);
  const expiresInSec = 60 * 60; // 1h
  const refreshExpiresInSec = 60 * 60 * 24 * 60; // 60d

  const { error } = await admin.from("mcp_oauth_tokens").insert({
    token_hash: access_hash,
    refresh_token_hash: refresh_hash,
    client_id: opts.client_id,
    user_id: opts.user_id,
    scopes: opts.scopes,
    expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + refreshExpiresInSec * 1000).toISOString(),
  });
  if (error) return oauthError("server_error", error.message, 500);

  return json({
    access_token,
    token_type: "Bearer",
    expires_in: expiresInSec,
    refresh_token,
    scope: opts.scopes.join(" "),
  });
}

// POST /revoke
async function handleRevoke(req: Request): Promise<Response> {
  const form = await readFormOrJson(req);
  const token = form.get("token") ?? "";
  if (!token) return json({}, 200);
  const hash = await sha256(token);
  await admin.from("mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .or(`token_hash.eq.${hash},refresh_token_hash.eq.${hash}`);
  return json({}, 200);
}

// GET /sessions — list this user's connected MCP clients
async function handleListSessions(req: Request): Promise<Response> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userRes } = await userClient.auth.getUser();
  if (!userRes?.user) return oauthError("unauthorized", "Sign in required", 401);

  const { data: tokens, error } = await admin
    .from("mcp_oauth_tokens")
    .select("id, client_id, scopes, expires_at, refresh_expires_at, revoked_at, last_used_at, last_user_agent, created_at")
    .eq("user_id", userRes.user.id)
    .order("created_at", { ascending: false });
  if (error) return oauthError("server_error", error.message, 500);

  const clientIds = Array.from(new Set((tokens ?? []).map((t) => t.client_id)));
  const clientMap: Record<string, any> = {};
  if (clientIds.length) {
    const { data: clients } = await admin
      .from("mcp_oauth_clients")
      .select("client_id, client_name, client_uri, logo_uri")
      .in("client_id", clientIds);
    for (const c of clients ?? []) clientMap[c.client_id] = c;
  }

  return json({
    sessions: (tokens ?? []).map((t) => ({
      ...t,
      client: clientMap[t.client_id] ?? { client_id: t.client_id, client_name: "Unknown app" },
    })),
  });
}

// DELETE /sessions/:id
async function handleRevokeSession(id: string, req: Request): Promise<Response> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userRes } = await userClient.auth.getUser();
  if (!userRes?.user) return oauthError("unauthorized", "Sign in required", 401);

  const { error } = await admin.from("mcp_oauth_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userRes.user.id);
  if (error) return oauthError("server_error", error.message, 500);
  return json({ revoked: true });
}

async function readFormOrJson(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const obj = await req.json();
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(obj ?? {})) {
        if (v != null) sp.set(k, String(v));
      }
      return sp;
    } catch { return new URLSearchParams(); }
  }
  const text = await req.text();
  return new URLSearchParams(text);
}

// ---------- router ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  // Strip whatever prefix the platform mounts us under (`/functions/v1/mcp-oauth`
  // when called directly, `/mcp-oauth` when routed by the gateway).
  const path = url.pathname
    .replace(/^\/functions\/v1\/mcp-oauth/, "")
    .replace(/^\/mcp-oauth/, "") || "/";

  try {
    if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
      return json(protectedResourceMetadata());
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json(authorizationServerMetadata());
    }
    if (req.method === "POST" && path === "/register") {
      return await handleRegister(req);
    }
    if (req.method === "GET" && path === "/authorize") {
      return await handleAuthorize(req);
    }
    if (req.method === "GET" && path.startsWith("/authorization/")) {
      const id = path.split("/")[2] ?? "";
      return await handleAuthorizationDetails(id, req);
    }
    if (req.method === "POST" && path === "/consent") {
      return await handleConsent(req);
    }
    if (req.method === "POST" && path === "/token") {
      return await handleToken(req);
    }
    if (req.method === "POST" && path === "/revoke") {
      return await handleRevoke(req);
    }
    if (req.method === "GET" && path === "/sessions") {
      return await handleListSessions(req);
    }
    if (req.method === "DELETE" && path.startsWith("/sessions/")) {
      const id = path.split("/")[2] ?? "";
      return await handleRevokeSession(id, req);
    }

    // Friendly index
    if (req.method === "GET" && path === "/") {
      return json({
        name: "Postora MCP OAuth",
        issuer: ISSUER,
        resource: MCP_RESOURCE,
        discovery: `${ISSUER}/.well-known/oauth-authorization-server`,
      });
    }

    return json({ error: "not_found", path }, 404);
  } catch (e) {
    console.error("mcp-oauth error", e);
    return json({ error: "server_error", message: (e as Error).message }, 500);
  }
});