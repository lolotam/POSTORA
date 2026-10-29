/**
 * instagram-oauth
 * ---------------
 * Direct Instagram Business Login.
 *
 * Unified backend-callback lifecycle:
 *   - POST action="authorize" → returns provider authorization URL with signed state
 *   - GET  ?code&state         → provider callback; exchanges code, saves account, 302 → return_to
 *   - POST action="callback"   → TEMPORARY legacy shim for in-flight sessions
 *
 * Protected lifecycle:
 *   - POST action="authorize" captures the explicit intent with the accepted
 *     `begin_meta_oauth_attempt` BEFORE the authorization URL is returned, and
 *     mints a signed state that carries the attempt identity, the one-time
 *     nonce and the SQL flow.
 *   - GET ?code&state verifies the signed state, claims the exact attempt
 *     BEFORE the code exchange, requires BOTH verified Instagram identities
 *     from the same provider response, completes the attempt once and commits
 *     the single verified candidate.
 *   - The unsigned POST callback shim carries no signed attempt and stays
 *     refused in protected mode.
 *
 * IDENTITY
 *
 *   Instagram Login issues two ids for one account. `profile.id` is the
 *   app-scoped id that publishing and conversation endpoints address, and
 *   `profile.user_id` is the distinct Instagram-scoped id that the inbound
 *   messaging webhook and the self-comment check resolve. A protected direct
 *   connection needs both, from the same verified response, before the
 *   callback is completed.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { createOAuthState, verifyOAuthState } from "../_shared/oauthState.ts";
import {
  appSettingReadResult,
  configurationClientError,
  createAppSettingLookup,
  isLifecycleRefusal,
  loadFacebookCredentialSettings,
  type FacebookCredentialMode,
} from "../_shared/facebookCredentialMode.ts";
import {
  beginOAuthRequest,
  oauthTripwirePorts,
} from "../facebook-oauth/protectedPageConnect.ts";
import {
  createMetaOAuthAttemptStoreFromClient,
  type MetaOAuthCandidate,
  type MetaOAuthFlow,
} from "../_shared/metaOAuthAttemptStore.ts";
import {
  PROTECTED_ATTEMPT_STATE_KEY,
  assertDirectIdentityEvidence,
  assertWebhookSubscription,
  beginProtectedAttempt,
  completeProtectedCallback,
  createPendingLinkageReader,
  createProtectedAttemptReader,
  createProtectedReceiptReader,
  createProtectedStashReader,
  inspectDirectCandidateReadiness,
  protectedCommit,
  protectedOAuthClientError,
  readProtectedAttemptContext,
  resolveProtectedIntent,
  type ProtectedAttemptStateContext,
} from "../_shared/metaOAuthProtectedFlow.ts";

import {
  ProtectedProviderFailure,
  createOperationBudget,
  exchangeProtectedDirectLogin,
  logProtectedFailure,
  protectedProviderClientReason,
  protectedWebhookSubscribe,
  PROTECTED_HTTP_TIMEOUT_MS,
  PROTECTED_OPERATION_BUDGET_MS,
} from "../_shared/metaOAuthProtectedBoundary.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INSTAGRAM_APP_ID = Deno.env.get("INSTAGRAM_APP_ID")!;
const INSTAGRAM_APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET")!;
// Public origin used to derive the OAuth redirect URI registered with Instagram.
// On self-hosted Supabase, SUPABASE_URL points at the internal Kong gateway
// (http://kong:8000), which is unreachable from the provider — never derive
// the redirect_uri from it.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const INSTAGRAM_REDIRECT_URI =
  Deno.env.get("INSTAGRAM_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/instagram-oauth`;
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

/** The one SQL flow this route owns. */
const DIRECT_FLOW: MetaOAuthFlow = "instagram_direct";

const IG_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
].join(",");

// `comments` is what carries comment events; without it Meta delivers none, regardless of the
// app-level subscription. POST replaces the whole set, so both fields go on every call.
const IG_WEBHOOK_FIELDS = "messages,comments";

// Best-effort: subscribes a direct-login Instagram account (no linked Facebook Page) to
// messaging and comment webhooks via the Instagram Graph API's own subscribed_apps endpoint.
// Confirmed against live traffic on 2026-08-22 while backfilling existing accounts. A failure
// here doesn't block the connection.
async function subscribeDirectAccountToWebhooks(igUserId: string, accessToken: string): Promise<void> {
  try {
    const res = await fetch(
      `https://graph.instagram.com/v22.0/${igUserId}/subscribed_apps?subscribed_fields=${IG_WEBHOOK_FIELDS}&access_token=${accessToken}`,
      { method: "POST" },
    );
    if (!res.ok) {
      console.warn("Failed to subscribe direct Instagram account to webhooks:", igUserId);
      return;
    }
    console.log("Subscribed direct Instagram account to webhooks:", igUserId);
  } catch (e) {
    console.warn("Error subscribing direct Instagram account to webhooks:", igUserId);
  }
}

function normalizeUsername(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/^@/, "").trim();
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...restrictedCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function configMissing(): boolean {
  return (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !INSTAGRAM_APP_ID ||
    !INSTAGRAM_APP_SECRET ||
    !INSTAGRAM_REDIRECT_URI
  );
}

interface InstagramProfile {
  id: string;
  // Instagram Login returns two ids for the same account: `id` is app-scoped and
  // `user_id` is the Instagram-scoped id (IGID). Messaging webhooks address the
  // account by its IGID, so both have to be stored to route an inbound DM back.
  user_id?: string;
  username?: string;
  account_type?: string;
  profile_picture_url?: string;
}

/**
 * The verified provider identity for one direct Instagram login.
 *
 * `canonicalId` is the app-scoped id. `igid` is the messaging-scoped id.
 * Both come from the SAME verified profile response.
 */
interface DirectProviderIdentity {
  kind: "ok" | "personal" | "error";
  canonicalId: string | null;
  igid: string | null;
  username: string | null;
  profilePictureUrl: string | null;
  token: string | null;
  expiresIn: number | null;
  grantedScopes: string[];
  message: string | null;
}

async function exchangeDirectIdentity(code: string): Promise<DirectProviderIdentity> {
  // Step 1: short-lived token
  const tokenResp = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: INSTAGRAM_APP_ID,
      client_secret: INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: INSTAGRAM_REDIRECT_URI,
      code,
    }),
  });
  const tokenData = await tokenResp.json();
  if (tokenData.error_message || tokenData.error) {
    return {
      kind: "error",
      canonicalId: null,
      igid: null,
      username: null,
      profilePictureUrl: null,
      token: null,
      expiresIn: null,
      grantedScopes: [],
      message: "Instagram rejected the authorization code.",
    };
  }

  const shortLivedToken = tokenData.access_token as string;

  // Step 2: long-lived token
  const longLivedResp = await fetch(
    `https://graph.instagram.com/v22.0/access_token?grant_type=ig_exchange_token&client_secret=${INSTAGRAM_APP_SECRET}&access_token=${shortLivedToken}`,
  );
  const longLivedData = await longLivedResp.json();
  const finalAccessToken = (longLivedData.access_token as string) || shortLivedToken;
  const expiresIn = (longLivedData.expires_in as number) || 5184000;

  let grantedScopes: string[] = [];
  try {
    const permResp = await fetch(
      `https://graph.instagram.com/v22.0/me/permissions?access_token=${encodeURIComponent(finalAccessToken)}`,
    );
    const permData = await permResp.json();
    if (Array.isArray(permData?.data)) {
      grantedScopes = permData.data
        .filter((p: { status?: string }) => p?.status === "granted")
        .map((p: { permission: string }) => p.permission);
    }
  } catch (_err) {
    // best-effort; the account still saves even if Meta does not return permissions
  }

  // Step 3: profile. Both identities come from this one verified response.
  const profileResp = await fetch(
    `https://graph.instagram.com/v22.0/me?fields=id,user_id,username,account_type,profile_picture_url&access_token=${finalAccessToken}`,
  );
  const profileData = (await profileResp.json()) as InstagramProfile & { error?: unknown };

  if (profileData.account_type === "PERSONAL") {
    return {
      kind: "personal",
      canonicalId: null,
      igid: null,
      username: null,
      profilePictureUrl: null,
      token: finalAccessToken,
      expiresIn,
      grantedScopes,
      message: null,
    };
  }

  return {
    kind: "ok",
    canonicalId: profileData.id ? String(profileData.id) : null,
    igid: profileData.user_id ? String(profileData.user_id) : null,
    username: profileData.username ?? null,
    profilePictureUrl: profileData.profile_picture_url ?? null,
    token: finalAccessToken,
    expiresIn,
    grantedScopes,
    message: null,
  };
}

/**
 * The legacy writer. It keeps the existing behaviour of the direct Instagram
 * login: the app-scoped id stays the canonical `platform_user_id` and the
 * messaging-scoped id stays a nonsecret metadata alias.
 */
async function persistDirectAccount(
  user_id: string,
  social_profile_id: string | null,
  identity: DirectProviderIdentity,
): Promise<{ kind: "ok"; username: string } | { kind: "error"; message: string }> {
  const igUserId = identity.canonicalId ?? "";
  const username = identity.username || `ig_${igUserId}`;
  const normalized = normalizeUsername(username);
  const avatarUrl = await cacheAvatarToCdn(
    identity.profilePictureUrl ?? undefined,
    user_id,
    "instagram",
    igUserId,
  );

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: existing } = await supabase
    .from("social_accounts")
    .select("id, platform_username")
    .eq("user_id", user_id)
    .eq("platform", "instagram")
    .eq("is_active", true);

  let existingId: string | null = null;
  for (const acc of existing ?? []) {
    if (normalizeUsername(acc.platform_username) === normalized) {
      existingId = acc.id;
      break;
    }
  }

  const accountData = {
    user_id,
    platform: "instagram",
    platform_user_id: igUserId,
    platform_username: username,
    avatar_url: avatarUrl,
    access_token: identity.token,
    token_expires_at: new Date(Date.now() + (identity.expiresIn ?? 5184000) * 1000).toISOString(),
    is_active: true,
    social_profile_id,
    ig_auth_type: "business_login",
    account_metadata: {
      ig_user_id: igUserId,
      ig_igid: identity.igid,
      ig_username: username,
      account_type: "business_login",
      token_type: "long_lived",
      flow: "direct",
      source: "instagram_business_login",
      granted_scopes: identity.grantedScopes,
      scopes_checked_at: new Date().toISOString(),
    },
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  if (existingId) {
    const { error } = await supabase
      .from("social_accounts")
      .update(accountData)
      .eq("id", existingId);
    if (error) return { kind: "error", message: "Failed to save Instagram account" };
  } else {
    const { error } = await supabase
      .from("social_accounts")
      .upsert(accountData, { onConflict: "user_id,platform,platform_user_id" });
    if (error) return { kind: "error", message: "Failed to save Instagram account" };
  }

  await subscribeDirectAccountToWebhooks(igUserId, identity.token ?? "");

  return { kind: "ok", username };
}

/**
 * A protected direct callback that cannot be completed.
 *
 * The attempt has already been claimed at this point, so the user has to
 * start a new authorization. The reason is carried as a stable redirect
 * parameter, never as provider text.
 */
class ProtectedDirectRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ProtectedDirectRefusal";
    this.reason = reason;
  }
}

async function handleProtectedDirectCallback(
  returnTo: string,
  userId: string,
  code: string,
  context: ProtectedAttemptStateContext,
): Promise<Response> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const store = createMetaOAuthAttemptStoreFromClient(supabase);

  try {
    const complete = await completeProtectedCallback(store, {
      userId,
      context,
      resolveCandidates: async () => {
        const login = await exchangeProtectedDirectLogin({
          appId: INSTAGRAM_APP_ID,
          appSecret: INSTAGRAM_APP_SECRET,
          redirectUri: INSTAGRAM_REDIRECT_URI,
          code,
          budget: createOperationBudget(PROTECTED_OPERATION_BUDGET_MS),
        });
        if (login.kind === "personal") {
          throw new ProtectedDirectRefusal("personal_account");
        }
        const evidence = assertDirectIdentityEvidence({
          ig_user_id: login.canonicalId,
          ig_igid: login.igid,
        });
        const avatarUrl = await cacheAvatarToCdn(
          login.profilePictureUrl ?? undefined,
          userId,
          "instagram",
          evidence.canonicalId,
        );
        const candidate: MetaOAuthCandidate = {
          ig_user_id: evidence.canonicalId,
          ig_igid: evidence.igid,
          ig_username: login.username ?? undefined,
          ig_profile_picture_url: avatarUrl,
        };
        return {
          candidates: [candidate],
          stash: {
            user_token: login.token,
            ...(login.expiresIn !== null ? { direct_token_expires_in: login.expiresIn } : {}),
          },
        };
      },
    });

    if (complete.candidates.length !== 1) {
      // A direct login yields exactly one account. More than one is a shape
      // this route does not know how to commit.
      throw new ProtectedDirectRefusal("connect_failed");
    }

    const selectionKey = complete.candidates[0].selectionKey;

    // An existing protected direct candidate that was stashed without the
    // messaging alias cannot be presented as a fully compatible connection.
    // The service-only readiness inspection refuses and asks for a restart.
    const readiness = await inspectDirectCandidateReadiness(
      createProtectedStashReader(supabase),
      {
        userId,
        pendingSelectionId: complete.pendingSelectionId,
        attemptId: context.attempt_id,
        selectionKey,
      },
    );
    if (readiness.state !== "verified") {
      throw new ProtectedDirectRefusal("direct_identity_unverified");
    }

    const { receipt } = await protectedCommit(
      {
        store,
        linkage: createPendingLinkageReader(supabase),
        attempts: createProtectedAttemptReader(supabase),
        receipts: createProtectedReceiptReader(supabase),
        userId,
        expectedFlows: [DIRECT_FLOW],
      },
      {
        selectionId: complete.pendingSelectionId,
        attemptId: context.attempt_id,
        selectionKey,
        providerTokenPresent: false,
      },
    );

    // Every valid receipt reasserts. The outcome is not an exactly-once claim.
    const subscription = await assertWebhookSubscription({
      receipt,
      userId,
      tokens: {
        async readOperationalToken(input) {
          const { data, error } = await supabase
            .from("social_accounts")
            .select("access_token")
            .eq("id", input.socialAccountId)
            .eq("user_id", input.userId)
            .eq("platform", input.platform)
            .eq("platform_user_id", input.platformUserId)
            .maybeSingle();
          if (error || !data) return null;
          return typeof data.access_token === "string" ? data.access_token : null;
        },
      },
      subscription: {
        async subscribe(input: { platform: "facebook" | "instagram"; providerId: string; token: string }) {
          const url = new URL(`https://graph.instagram.com/v22.0/${input.providerId}/subscribed_apps`);
          url.searchParams.set("subscribed_fields", IG_WEBHOOK_FIELDS);
          url.searchParams.set("access_token", input.token);
          await protectedWebhookSubscribe({
            url: url.toString(),
            budget: createOperationBudget(PROTECTED_HTTP_TIMEOUT_MS),
          });
        },
      },
    });

    const redirect: Record<string, string> = {
      connected: "instagram",
      username: receipt.username ?? "",
    };
    if (subscription.status === "failed") {
      redirect.warning = "subscription_unconfirmed";
    }
    return Response.redirect(appendQuery(returnTo, redirect), 302);
  } catch (error) {
    if (error instanceof ProtectedDirectRefusal) {
      return Response.redirect(appendQuery(returnTo, { error: error.reason }), 302);
    }
    if (error instanceof ProtectedProviderFailure) {
      logProtectedFailure("instagram-oauth", error);
      // A successful profile that lacks one of the two clean string ids keeps
      // the established identity refusal. Other provider failures stay categories.
      const reason = error.category === "provider_identity_unverified"
        ? "PROTECTED_OAUTH_IDENTITY_UNVERIFIED"
        : protectedProviderClientReason(error);
      return Response.redirect(appendQuery(returnTo, { error: reason }), 302);
    }
    const client = protectedOAuthClientError(error);
    if (client) {
      console.error("[instagram-oauth] protected callback refused", {
        event: client.error_code,
      });
      return Response.redirect(appendQuery(returnTo, { error: client.error_code }), 302);
    }
    logProtectedFailure("instagram-oauth", error);
    return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
  }
}

async function loadCredentialMode(): Promise<FacebookCredentialMode> {
  const settingsClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const lookup = createAppSettingLookup(async (key) => {
    const { data, error } = await settingsClient
      .from("app_settings")
      .select("value")
      .eq("key", key)
      .maybeSingle();
    return appSettingReadResult(data, error);
  });
  const { credentialMode } = await loadFacebookCredentialSettings(lookup);
  return credentialMode;
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (configMissing()) {
    console.error("instagram-oauth configuration is incomplete");
    return jsonResponse(req, { error: "Service configuration error" }, 500);
  }

  // -------------------- GET: provider callback (unified path) -------------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (!state) {
      return jsonResponse(req, { error: "Missing state" }, 400);
    }

    let payload;
    try {
      payload = await verifyOAuthState(state, { expectedPlatform: "instagram" });
    } catch (err) {
      console.warn("instagram-oauth: invalid state", err instanceof Error ? err.message : "");
      return jsonResponse(req, { error: "Invalid or expired state" }, 400);
    }

    const returnTo = payload.return_to || `${RETURN_URL_DEFAULT}?connected=instagram`;

    if (providerError || !code) {
      return Response.redirect(
        appendQuery(returnTo, { error: providerError || "missing_code" }),
        302,
      );
    }

    // The protected attempt context is server-authored and signed. A state
    // that carries one continues the protected lifecycle even when the
    // server mode has been switched back to legacy.
    let attemptContext: ProtectedAttemptStateContext | null = null;
    try {
      attemptContext = readProtectedAttemptContext(payload);
    } catch {
      return jsonResponse(req, { error: "Invalid or expired state" }, 400);
    }

    let credentialMode: FacebookCredentialMode;
    try {
      credentialMode = await loadCredentialMode();
    } catch (error) {
      const config = configurationClientError(error);
      console.error("[instagram-oauth] credential configuration refused", {
        event: config?.error_code ?? "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
      });
      return Response.redirect(
        appendQuery(returnTo, { error: "credential_configuration_unavailable" }),
        302,
      );
    }

    if (attemptContext) {
      if (attemptContext.flow !== DIRECT_FLOW) {
        return Response.redirect(
          appendQuery(returnTo, { error: "protected_oauth_flow_mismatch" }),
          302,
        );
      }
      return await handleProtectedDirectCallback(
        returnTo,
        payload.user_id,
        code,
        attemptContext,
      );
    }

    // A legacy callback. While protected mode is selected it refuses and asks
    // for a restart instead of writing a legacy account.
    if (credentialMode === "protected") {
      return Response.redirect(
        appendQuery(returnTo, { error: "protected_reauthorization_required" }),
        302,
      );
    }

    try {
      const identity = await exchangeDirectIdentity(code);
      if (identity.kind === "personal") {
        return Response.redirect(
          appendQuery(returnTo, { error: "personal_account" }),
          302,
        );
      }
      if (identity.kind === "error") {
        console.error("instagram-oauth callback error:", identity.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }
      const persisted = await persistDirectAccount(
        payload.user_id,
        (payload.profile_id as string | null) ?? null,
        identity,
      );
      if (persisted.kind === "error") {
        console.error("instagram-oauth callback error:", persisted.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }
      return Response.redirect(
        appendQuery(returnTo, { connected: "instagram", username: persisted.username }),
        302,
      );
    } catch (err) {
      console.error("instagram-oauth GET callback failed:", err);
      return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
    }
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string | undefined;

  if (!action || !["authorize", "callback"].includes(action)) {
    return jsonResponse(req, { error: "Invalid request body" }, 400);
  }

  // Both POST actions require an authenticated caller
  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id as string | undefined);
    user_id = auth.userId;
  } catch {
    return jsonResponse(req, { error: "Unauthorized" }, 401);
  }

  try {
    const decision = await beginOAuthRequest({
      lookup: createAppSettingLookup(async (key) => {
        const { data, error } = await createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
      flow: "instagram_oauth",
      action,
      ports: oauthTripwirePorts(),
      legacy: async () => "legacy" as const,
      protected:
        action === "authorize"
          ? async () => "protected" as const
          : // The unsigned POST callback shim carries no signed attempt. It
            // stays refused in protected mode.
            undefined,
      userId: user_id,
    });
    if (isLifecycleRefusal(decision)) {
      return jsonResponse(req, {
        error_code: decision.errorCode,
        error: decision.error,
      }, decision.status);
    }

    // -------------------- POST authorize -------------------------
    if (action === "authorize") {
      const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
      const return_to =
        (body.return_to as string | undefined) ?? `${RETURN_URL_DEFAULT}?connected=instagram`;

      const authUrl = new URL("https://www.instagram.com/oauth/authorize");
      authUrl.searchParams.set("client_id", INSTAGRAM_APP_ID);
      authUrl.searchParams.set("redirect_uri", INSTAGRAM_REDIRECT_URI);
      authUrl.searchParams.set("scope", IG_SCOPES);
      authUrl.searchParams.set("response_type", "code");

      if (decision === "protected") {
        const intent = resolveProtectedIntent({
          intent: body.intent,
          targetSocialAccountId: body.target_social_account_id,
          sourceSocialAccountId: body.source_social_account_id,
          linkedTargetSocialAccountId: body.linked_target_social_account_id,
        });

        // The capture happens BEFORE the authorization URL is returned.
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const store = createMetaOAuthAttemptStoreFromClient(supabase);
        const begun = await beginProtectedAttempt(store, {
          userId: user_id,
          flow: DIRECT_FLOW,
          intent: intent.intent,
          targetSocialAccountId: intent.targetSocialAccountId,
          sourceSocialAccountId: intent.sourceSocialAccountId,
          linkedTargetSocialAccountId: intent.linkedTargetSocialAccountId,
          intendedSocialProfileId: social_profile_id ?? undefined,
        });

        const state = await createOAuthState({
          platform: "instagram",
          flow: "direct",
          user_id,
          profile_id: social_profile_id,
          return_to,
          extra: { [PROTECTED_ATTEMPT_STATE_KEY]: begun.stateContext },
        });
        authUrl.searchParams.set("state", state);

        return jsonResponse(req, {
          url: authUrl.toString(),
          requested_redirect_uri: body.redirect_uri ?? null,
          effective_redirect_uri: INSTAGRAM_REDIRECT_URI,
        });
      }

      const state = await createOAuthState({
        platform: "instagram",
        flow: "direct",
        user_id,
        profile_id: social_profile_id,
        return_to,
      });
      authUrl.searchParams.set("state", state);

      return jsonResponse(req, {
        url: authUrl.toString(),
        requested_redirect_uri: body.redirect_uri ?? null,
        effective_redirect_uri: INSTAGRAM_REDIRECT_URI,
      });
    }

    // -------------------- POST callback (TEMP legacy shim) -------
    // TEMP: remove after 24-48h once the GET-302 path is verified in production.
    if (action === "callback") {
      const code = body.code as string | undefined;
      const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
      if (!code) return jsonResponse(req, { error: "Missing code" }, 400);

      const identity = await exchangeDirectIdentity(code);
      if (identity.kind === "personal") {
        return jsonResponse(req, {
          error: "personal_account",
          account_type: "PERSONAL",
          requires_facebook: true,
          message:
            "Your Instagram account is a Personal account. Personal accounts cannot connect directly — they must be linked through a Facebook Page.",
        });
      }
      if (identity.kind === "error") {
        return jsonResponse(req, { success: false, error: identity.message }, 200);
      }
      const persisted = await persistDirectAccount(user_id, social_profile_id, identity);
      if (persisted.kind === "error") {
        return jsonResponse(req, { success: false, error: persisted.message }, 200);
      }
      return jsonResponse(req, { success: true, username: persisted.username });
    }

    return jsonResponse(req, { error: "Invalid action" }, 400);
  } catch (err) {
    const client = protectedOAuthClientError(err);
    if (client) {
      console.error("[instagram-oauth] protected request refused", {
        event: client.error_code,
      });
      return jsonResponse(req, { error_code: client.error_code, error: client.error }, client.status);
    }
    const config = configurationClientError(err);
    if (config) {
      console.error("[instagram-oauth] credential configuration refused", {
        event: config.error_code,
      });
      return jsonResponse(req, {
        error_code: config.error_code,
        error: config.error,
      }, config.status);
    }
    console.error("instagram-oauth POST failed:", err instanceof Error ? err.name : "unknown");
    return jsonResponse(req, { error: "Authentication failed. Please try again." }, 500);
  }
});
