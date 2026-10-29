/**
 * instagram-business-oauth
 * ------------------------
 * Connect Instagram via Facebook Business / Pages.
 *
 * Lifecycle:
 *   - POST action="authorize"            → returns Meta authorization URL with signed state
 *   - GET  ?code&state                   → callback; exchanges code, lists IG candidates,
 *                                          stashes them, 302 → return_to with ?select=<id>
 *   - POST action="get_pending_selection" → load candidates for the picker UI
 *   - POST action="store_ig_account"      → persist one selected IG account
 *   - POST action="clear_pending_selection" → close the picker
 *
 * Protected lifecycle:
 *   - POST action="authorize" captures the explicit intent with the accepted
 *     `begin_meta_oauth_attempt` BEFORE the authorization URL is returned.
 *   - GET ?code&state claims the exact attempt BEFORE the code exchange,
 *     completes it once with the verified Page-linked candidates and stashes
 *     them in the existing Instagram stash.
 *   - The picker reads the safe, nonsecret projection and commits one
 *     selection through `commit_meta_oauth_selection`. The authority is the
 *     attempt id plus the opaque selection key.
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
  ProtectedOAuthError,
  assertWebhookSubscription,
  beginProtectedAttempt,
  classifyPendingReference,
  completeProtectedCallback,
  createPendingLinkageReader,
  createProtectedAttemptReader,
  createProtectedReceiptReader,
  protectedCloseOutcome,
  protectedCommit,
  protectedOAuthClientError,
  protectedPickerRead,
  protectedSelectionRefusal,
  pendingReferenceRefusal,
  readProtectedAttemptContext,
  resolveProtectedIntent,
  type PendingReferenceOutcome,
  type ProtectedAttemptStateContext,
} from "../_shared/metaOAuthProtectedFlow.ts";

import {
  ProtectedProviderFailure,
  createOperationBudget,
  exchangeProtectedFacebookCode,
  listProtectedManagedPages,
  logProtectedFailure,
  protectedProviderClientReason,
  PROTECTED_OPERATION_BUDGET_MS,
} from "../_shared/metaOAuthProtectedBoundary.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FACEBOOK_APP_ID = Deno.env.get("FACEBOOK_APP_ID")!;
const FACEBOOK_APP_SECRET = Deno.env.get("FACEBOOK_APP_SECRET")!;
// Public origin used to derive the OAuth redirect URI registered with Meta.
// On self-hosted Supabase, SUPABASE_URL points at the internal Kong gateway
// (http://kong:8000), which is unreachable from the provider — never derive
// the redirect_uri from it.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const INSTAGRAM_BUSINESS_REDIRECT_URI =
  Deno.env.get("INSTAGRAM_BUSINESS_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/instagram-business-oauth`;
const GRAPH_VERSION = Deno.env.get("FACEBOOK_GRAPH_API_VERSION") ?? "v22.0";
const RETURN_URL_DEFAULT = "https://postora.cloud/profiles";

/** The one SQL flow this route owns. */
const PAGE_LINKED_FLOW: MetaOAuthFlow = "instagram_page_linked";

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_messaging",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_insights",
  "instagram_manage_messages",
].join(",");

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
    !FACEBOOK_APP_ID ||
    !FACEBOOK_APP_SECRET ||
    !INSTAGRAM_BUSINESS_REDIRECT_URI
  );
}

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    username?: string;
    profile_picture_url?: string;
  };
}

interface IgCandidate {
  ig_user_id: string;
  ig_username: string;
  ig_profile_picture_url: string | null;
  facebook_page_id: string;
  facebook_page_name: string;
  page_access_token: string;
}

/**
 * The narrow writer seam.
 *
 * The edge function has no generated database types, so the Supabase client's
 * generic parameters cannot be expressed here. This seam states exactly which
 * call shape the legacy writer needs, and the call site performs the single
 * cast.
 */
interface SocialAccountWriter {
  from(table: string): {
    upsert(
      payload: Record<string, unknown>,
      options?: { onConflict?: string },
    ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  };
}

interface PageListResponse {
  data?: FbPage[];
  error?: { message?: string };
  paging?: { next?: string | null };
}

async function exchangeAndListIg(
  code: string,
): Promise<
  | { kind: "ok"; candidates: IgCandidate[]; long_lived_token: string; expires_in: number; granted_scopes: string[]; facebook_user_id: string }
  | { kind: "no_instagram"; granted_scopes: string[] }
  | { kind: "error"; message: string }
> {
  const tokenUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
  tokenUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
  tokenUrl.searchParams.set("redirect_uri", INSTAGRAM_BUSINESS_REDIRECT_URI);
  tokenUrl.searchParams.set("code", code);

  const tokenResp = await fetch(tokenUrl.toString());
  const tokenData = await tokenResp.json();
  if (tokenData.error) {
    return {
      kind: "error",
      message: `Facebook token exchange failed: ${tokenData.error.message ?? "unknown"}`,
    };
  }
  const userToken = tokenData.access_token as string;

  let longLivedToken = userToken;
  let expiresIn = 5184000;
  try {
    const llUrl = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`);
    llUrl.searchParams.set("grant_type", "fb_exchange_token");
    llUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
    llUrl.searchParams.set("client_secret", FACEBOOK_APP_SECRET);
    llUrl.searchParams.set("fb_exchange_token", userToken);
    const llResp = await fetch(llUrl.toString());
    const llData = await llResp.json();
    if (llData.access_token) {
      longLivedToken = llData.access_token;
      expiresIn = llData.expires_in || expiresIn;
    }
  } catch (_err) {
    // keep short-lived
  }

  // Fetch the user's granted permission set so each saved account records the
  // scopes the messaging UI uses to detect a declined permission.
  let grantedScopes: string[] = [];
  try {
    const permUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(longLivedToken)}`;
    const permResp = await fetch(permUrl);
    const permData = await permResp.json();
    if (Array.isArray(permData?.data)) {
      grantedScopes = permData.data
        .filter((p: { status?: string }) => p?.status === "granted")
        .map((p: { permission: string }) => p.permission);
    }
  } catch (_err) {
    // best-effort; leave empty so the UI does not invent a grant
  }

  // The Facebook User id is part of the accepted candidate contract. It is
  // read from the same verified grant.
  let facebookUserId = "";
  try {
    const meUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id&access_token=${encodeURIComponent(longLivedToken)}`;
    const meResp = await fetch(meUrl);
    const meData = await meResp.json();
    if (meData && typeof meData.id === "string") facebookUserId = meData.id;
  } catch (_err) {
    // handled below
  }

  const pages: FbPage[] = [];
  let nextUrl: string | null =
    `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts` +
    `?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}` +
    `&limit=100&access_token=${encodeURIComponent(longLivedToken)}`;

  while (nextUrl) {
    const pageResp: Response = await fetch(nextUrl);
    const pageData = (await pageResp.json()) as PageListResponse;
    if (pageData.error) {
      return {
        kind: "error",
        message: `Failed to list Pages: ${pageData.error.message ?? "unknown"}`,
      };
    }
    if (Array.isArray(pageData.data)) pages.push(...(pageData.data as FbPage[]));
    nextUrl = pageData.paging?.next ?? null;
  }

  const candidates: IgCandidate[] = pages
    .filter((p) => p.instagram_business_account?.id)
    .map((p) => {
      const ig = p.instagram_business_account!;
      return {
        ig_user_id: ig.id,
        ig_username: ig.username || `ig_${ig.id}`,
        ig_profile_picture_url: ig.profile_picture_url ?? null,
        facebook_page_id: p.id,
        facebook_page_name: p.name,
        page_access_token: p.access_token,
      };
    });

  if (candidates.length === 0) return { kind: "no_instagram", granted_scopes: grantedScopes };
  return {
    kind: "ok",
    candidates,
    long_lived_token: longLivedToken,
    expires_in: expiresIn,
    granted_scopes: grantedScopes,
    facebook_user_id: facebookUserId,
  };
}

async function persistOneIgAccount(
  supabase: SocialAccountWriter,
  user_id: string,
  social_profile_id: string | null,
  candidate: IgCandidate,
  expires_in: number,
  granted_scopes: string[] = [],
): Promise<{ success: boolean; error?: string }> {
  const avatarUrl = await cacheAvatarToCdn(
    candidate.ig_profile_picture_url ?? undefined,
    user_id,
    "instagram",
    candidate.ig_user_id,
  );

  const accountData = {
    user_id,
    platform: "instagram",
    platform_user_id: candidate.ig_user_id,
    platform_username: candidate.ig_username,
    avatar_url: avatarUrl,
    access_token: candidate.page_access_token,
    token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
    is_active: true,
    social_profile_id,
    ig_auth_type: "facebook_business",
    account_metadata: {
      ig_user_id: candidate.ig_user_id,
      ig_username: candidate.ig_username,
      flow: "facebook_business",
      source: "facebook_business",
      facebook_page_id: candidate.facebook_page_id,
      facebook_page_name: candidate.facebook_page_name,
      page_access_token: candidate.page_access_token,
      ig_business_account_id: candidate.ig_user_id,
      token_type: "page_token",
      granted_scopes,
      scopes_checked_at: new Date().toISOString(),
    },
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  const { error } = await supabase
    .from("social_accounts")
    .upsert(accountData, { onConflict: "user_id,platform,platform_user_id" });
  if (error) {
    console.error("instagram-business-oauth save error:", error.message);
    return { success: false, error: error.message };
  }
  return { success: true };
}

/**
 * A protected callback that cannot be completed. The attempt has already been
 * claimed, so the user has to start a new authorization.
 */
class ProtectedBusinessRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ProtectedBusinessRefusal";
    this.reason = reason;
  }
}

async function handleProtectedBusinessCallback(
  returnTo: string,
  code: string,
  userId: string,
  context: ProtectedAttemptStateContext,
): Promise<Response> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const store = createMetaOAuthAttemptStoreFromClient(supabase);

  try {
    const complete = await completeProtectedCallback(store, {
      userId,
      context,
      resolveCandidates: async () => {
        const budget = createOperationBudget(PROTECTED_OPERATION_BUDGET_MS);
        const grant = await exchangeProtectedFacebookCode({
          graphVersion: GRAPH_VERSION,
          appId: FACEBOOK_APP_ID,
          appSecret: FACEBOOK_APP_SECRET,
          redirectUri: INSTAGRAM_BUSINESS_REDIRECT_URI,
          code,
          budget,
        });
        const pages = await listProtectedManagedPages({
          graphVersion: GRAPH_VERSION,
          accessToken: grant.token,
          budget,
        });
        const candidates: MetaOAuthCandidate[] = [];
        for (const page of pages) {
          if (!page.instagram) continue;
          candidates.push({
            ig_user_id: page.instagram.id,
            ig_username: page.instagram.username ?? `ig_${page.instagram.id}`,
            ig_profile_picture_url: page.instagram.profilePictureUrl,
            facebook_page_id: page.id,
            facebook_page_name: page.name,
            page_access_token: page.accessToken,
            facebook_user_id: grant.facebookUserId,
            candidate_kind: "ig_only",
          });
        }
        if (candidates.length === 0) {
          throw new ProtectedBusinessRefusal("no_instagram_business");
        }
        return {
          candidates,
          stash: {
            user_token: grant.token,
            ...(grant.expiresIn !== null ? { user_token_expires_in: grant.expiresIn } : {}),
          },
        };
      },
    });

    return Response.redirect(
      appendQuery(returnTo, {
        connected: "instagram_business",
        select: complete.pendingSelectionId,
      }),
      302,
    );
  } catch (error) {
    if (error instanceof ProtectedBusinessRefusal) {
      return Response.redirect(appendQuery(returnTo, { error: error.reason }), 302);
    }
    if (error instanceof ProtectedProviderFailure) {
      logProtectedFailure("instagram-business-oauth", error);
      return Response.redirect(
        appendQuery(returnTo, { error: protectedProviderClientReason(error) }),
        302,
      );
    }
    const client = protectedOAuthClientError(error);
    if (client) {
      console.error("[instagram-business-oauth] protected callback refused", {
        event: client.error_code,
      });
      return Response.redirect(appendQuery(returnTo, { error: client.error_code }), 302);
    }
    logProtectedFailure("instagram-business-oauth", error);
    return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
  }
}

/**
 * The refusal a classification produces. A missing or failed read is never
 * permission to fall back to the legacy writer.
 */
function classificationRefusal(outcome: PendingReferenceOutcome): {
  status: number;
  error_code: string;
  error: string;
} | null {
  const refusal = pendingReferenceRefusal(outcome);
  if (!refusal) return null;
  return { status: refusal.status, error_code: refusal.code, error: refusal.message };
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
    console.error("instagram-business-oauth configuration is incomplete");
    return jsonResponse(req, { error: "Service configuration error" }, 500);
  }

  // -------------------- GET: provider callback (unified path) -------------------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const providerError = url.searchParams.get("error");

    if (!state) return jsonResponse(req, { error: "Missing state" }, 400);

    let payload;
    try {
      payload = await verifyOAuthState(state, { expectedPlatform: "instagram" });
    } catch (err) {
      console.warn(
        "instagram-business-oauth: invalid state",
        err instanceof Error ? err.message : "",
      );
      return jsonResponse(req, { error: "Invalid or expired state" }, 400);
    }
    if (payload.flow !== "facebook_business") {
      return jsonResponse(req, { error: "State flow mismatch" }, 400);
    }

    const returnTo =
      payload.return_to || `${RETURN_URL_DEFAULT}?connected=instagram_business`;

    if (providerError || !code) {
      return Response.redirect(
        appendQuery(returnTo, { error: providerError || "missing_code" }),
        302,
      );
    }

    // A signed, captured attempt continues the protected lifecycle even when
    // the server mode has been switched back to legacy.
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
      console.error("[instagram-business-oauth] credential configuration refused", {
        event: config?.error_code ?? "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
      });
      return Response.redirect(
        appendQuery(returnTo, { error: "credential_configuration_unavailable" }),
        302,
      );
    }

    if (attemptContext) {
      if (attemptContext.flow !== PAGE_LINKED_FLOW) {
        return Response.redirect(
          appendQuery(returnTo, { error: "protected_oauth_flow_mismatch" }),
          302,
        );
      }
      return await handleProtectedBusinessCallback(returnTo, code, payload.user_id, attemptContext);
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
      const result = await exchangeAndListIg(code);
      if (result.kind === "no_instagram") {
        return Response.redirect(
          appendQuery(returnTo, { error: "no_instagram_business" }),
          302,
        );
      }
      if (result.kind === "error") {
        console.error("instagram-business-oauth callback error:", result.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data: stashRow, error: stashError } = await supabase
        .from("oauth_pending_instagram_selections")
        .insert({
          user_id: payload.user_id,
          social_profile_id: (payload.profile_id as string | null) ?? null,
          ig_candidates_json: result.candidates,
          long_lived_token: result.long_lived_token,
          expires_in: result.expires_in,
        })
        .select("id")
        .single();

      if (stashError || !stashRow?.id) {
        console.error("instagram-business-oauth stash error:", stashError?.message);
        return Response.redirect(appendQuery(returnTo, { error: "connect_failed" }), 302);
      }

      return Response.redirect(
        appendQuery(returnTo, {
          connected: "instagram_business",
          select: stashRow.id,
        }),
        302,
      );
    } catch (err) {
      console.error("instagram-business-oauth GET callback failed:", err);
      return Response.redirect(appendQuery(returnTo, { error: "internal_error" }), 302);
    }
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed" }, 405);
  }

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body.action as string | undefined;

  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id as string | undefined);
    user_id = auth.userId;
  } catch {
    return jsonResponse(req, { error: "Unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const store = createMetaOAuthAttemptStoreFromClient(supabase);
  const route = {
    store,
    linkage: createPendingLinkageReader(supabase),
    attempts: createProtectedAttemptReader(supabase),
    receipts: createProtectedReceiptReader(supabase),
    userId: user_id,
    expectedFlows: [PAGE_LINKED_FLOW],
  };

  try {
    // Every supplied pending reference is classified in BOTH modes, before any
    // provider call, mutation, secret read or deletion.
    const selectionId = (body.selection_id as string | undefined) ?? null;
    const attemptId = (body.attempt_id as string | undefined) ?? null;
    const providerTokenPresent =
      typeof body.provider_token === "string" && body.provider_token.length > 0;
    const classification = await classifyPendingReference(route.linkage, {
      userId: user_id,
      selectionId,
      attemptId,
      providerTokenPresent,
    });
    const refusal = classificationRefusal(classification);
    if (refusal) {
      return jsonResponse(req, refusal, refusal.status);
    }

    const decision = await beginOAuthRequest({
      lookup: createAppSettingLookup(async (key) => {
        const { data, error } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
      flow: "instagram_business_oauth",
      action: action ?? "unknown",
      ports: oauthTripwirePorts(),
      legacy: async () => "legacy" as const,
      protected:
        action === "authorize"
          ? async () => "protected" as const
          : classification.kind === "protected"
          ? async () => "protected" as const
          : async () => {
            // A selection that no captured attempt owns cannot be committed
            // by the protected lifecycle. The user has to reconnect.
            const refusal = protectedSelectionRefusal(classification);
            throw refusal ?? new ProtectedOAuthError(
              "PROTECTED_OAUTH_REFUSED",
              "This selection cannot be completed. Please reconnect.",
              403,
            );
          },
      attemptOwned: classification.kind === "protected",
    });
    if (isLifecycleRefusal(decision)) {
      return jsonResponse(req, {
        error_code: decision.errorCode,
        error: decision.error,
      }, decision.status);
    }

    // ---------------- get_pending_selection: load candidates for picker ----------
    if (action === "get_pending_selection") {
      if (!selectionId) return jsonResponse(req, { error: "Missing selection_id" }, 400);

      if (decision === "protected") {
        const projection = await protectedPickerRead(route, {
          pendingSelectionId: selectionId,
        });
        return jsonResponse(req, {
          success: true,
          protected: true,
          attempt_id: projection.attempt_id,
          social_profile_id: projection.social_profile_id,
          expired: projection.expired,
          committed_selection_keys: projection.committed_selection_keys,
          ig_accounts: projection.candidates.map((candidate) => ({
            selection_key: candidate.selection_key,
            ig_user_id: candidate.ig_user_id,
            ig_username: candidate.ig_username,
            ig_profile_picture_url: candidate.ig_profile_picture_url,
            facebook_page_name: candidate.facebook_page_name,
          })),
        });
      }

      const { data: row, error } = await supabase
        .from("oauth_pending_instagram_selections")
        .select("id, user_id, social_profile_id, ig_candidates_json, expires_at")
        .eq("id", selectionId)
        .maybeSingle();

      if (error || !row) {
        return jsonResponse(req, { success: false, error: "Selection not found or expired" }, 404);
      }
      if (row.user_id !== user_id) {
        return jsonResponse(req, { success: false, error: "Forbidden" }, 403);
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return jsonResponse(req, { success: false, error: "Selection expired" }, 404);
      }

      const candidates = (row.ig_candidates_json as IgCandidate[] | null) ?? [];
      return jsonResponse(req, {
        success: true,
        social_profile_id: row.social_profile_id,
        ig_accounts: candidates.map((c) => ({
          ig_user_id: c.ig_user_id,
          ig_username: c.ig_username,
          ig_profile_picture_url: c.ig_profile_picture_url,
          facebook_page_name: c.facebook_page_name,
        })),
      });
    }

    // ---------------- store_ig_account: persist one selected IG account ----------
    if (action === "store_ig_account") {
      const ig_user_id = body.ig_user_id as string | undefined;
      const selection_key = body.selection_key as string | undefined;

      if (decision === "protected") {
        if (!attemptId || !selection_key) {
          return jsonResponse(req, { error: "Missing attempt_id or selection_key" }, 400);
        }
        const committed = await protectedCommit(route, {
          selectionId,
          attemptId,
          selectionKey: selection_key,
          providerTokenPresent,
        });
        const subscription = await assertWebhookSubscription({
          receipt: committed.receipt,
          userId: user_id,
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
            async subscribe() {
              // The Page-linked flow never subscribed in the legacy writer.
            },
          },
        });
        return jsonResponse(req, {
          success: true,
          protected: true,
          attempt_id: committed.receipt.attemptId,
          selection_key: committed.receipt.selectionKey,
          ig_username: committed.receipt.username,
          facebook_page_name: committed.receipt.facebookPageId,
          subscription,
        });
      }

      if (!selectionId || !ig_user_id) {
        return jsonResponse(req, { error: "Missing selection_id or ig_user_id" }, 400);
      }

      const override_profile_id =
        (body.social_profile_id as string | null | undefined) ?? null;
      const { data: row, error } = await supabase
        .from("oauth_pending_instagram_selections")
        .select("id, user_id, social_profile_id, ig_candidates_json, expires_in, expires_at, long_lived_token")
        .eq("id", selectionId)
        .maybeSingle();

      if (error || !row) {
        return jsonResponse(req, { success: false, error: "Selection not found or expired" }, 404);
      }
      if (row.user_id !== user_id) {
        return jsonResponse(req, { success: false, error: "Forbidden" }, 403);
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return jsonResponse(req, { success: false, error: "Selection expired" }, 404);
      }

      const candidates = (row.ig_candidates_json as IgCandidate[] | null) ?? [];
      const candidate = candidates.find((c) => c.ig_user_id === ig_user_id);
      if (!candidate) {
        return jsonResponse(req, { success: false, error: "Account not in selection" }, 404);
      }


      // Fetch the user's currently-granted scopes from Meta so we can persist the
      // actual permission set (used by messaging/comments UI to detect missing
      // scopes such as `instagram_manage_messages`).
      let grantedScopes: string[] = [];
      try {
        const llt = row.long_lived_token as string | undefined;
        if (llt) {
          const permUrl = `https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(llt)}`;
          const permResp = await fetch(permUrl);
          const permData = await permResp.json();
          if (Array.isArray(permData?.data)) {
            grantedScopes = permData.data
              .filter((p: { status?: string }) => p?.status === "granted")
              .map((p: { permission: string }) => p.permission);
          }
        }
      } catch (_err) { /* best-effort */ }

      const result = await persistOneIgAccount(
        supabase as unknown as SocialAccountWriter,
        user_id,
        override_profile_id ?? row.social_profile_id ?? null,
        candidate,
        row.expires_in ?? 5184000,
        grantedScopes,
      );
      if (!result.success) {
        return jsonResponse(req, { success: false, error: result.error ?? "Save failed" }, 200);
      }

      return jsonResponse(req, {
        success: true,
        ig_username: candidate.ig_username,
        facebook_page_name: candidate.facebook_page_name,
      });
    }

    // ---------------- clear_pending_selection: close the picker --------------
    if (action === "clear_pending_selection") {
      if (!selectionId) return jsonResponse(req, { error: "Missing selection_id" }, 400);

      if (decision === "protected") {
        // There is no cancellation RPC. Closing an unexpired protected picker
        // is a local closure and a truthful "retained until expiry".
        const closed = protectedCloseOutcome(classification);
        return jsonResponse(req, closed);
      }

      await supabase
        .from("oauth_pending_instagram_selections")
        .delete()
        .eq("id", selectionId)
        .eq("user_id", user_id);
      return jsonResponse(req, { success: true });
    }

    if (action !== "authorize") {
      return jsonResponse(req, { error: "Invalid request body" }, 400);
    }

    try {
      if (configMissing()) {
        console.error("Instagram Business OAuth not configured: missing FACEBOOK_APP_ID/SECRET or redirect URI");
        return jsonResponse(req, {
          error_code: "missing_config",
          error: "Instagram Business isn't set up correctly on the server yet. Please contact support.",
        }, 200);
      }

      const social_profile_id = (body.social_profile_id as string | null | undefined) ?? null;
      const return_to =
        (body.return_to as string | undefined) ??
        `${RETURN_URL_DEFAULT}?connected=instagram_business`;

      const authUrl = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
      authUrl.searchParams.set("client_id", FACEBOOK_APP_ID);
      authUrl.searchParams.set("redirect_uri", INSTAGRAM_BUSINESS_REDIRECT_URI);
      authUrl.searchParams.set("scope", META_SCOPES);
      authUrl.searchParams.set("response_type", "code");

      if (decision === "protected") {
        const intent = resolveProtectedIntent({
          intent: body.intent,
          targetSocialAccountId: body.target_social_account_id,
          sourceSocialAccountId: body.source_social_account_id,
          linkedTargetSocialAccountId: body.linked_target_social_account_id,
        });

        // The capture happens BEFORE the authorization URL is returned.
        const begun = await beginProtectedAttempt(store, {
          userId: user_id,
          flow: PAGE_LINKED_FLOW,
          intent: intent.intent,
          targetSocialAccountId: intent.targetSocialAccountId,
          sourceSocialAccountId: intent.sourceSocialAccountId,
          linkedTargetSocialAccountId: intent.linkedTargetSocialAccountId,
          intendedSocialProfileId: social_profile_id ?? undefined,
        });

        const state = await createOAuthState({
          platform: "instagram",
          flow: "facebook_business",
          user_id,
          profile_id: social_profile_id,
          return_to,
          extra: { [PROTECTED_ATTEMPT_STATE_KEY]: begun.stateContext },
        });
        authUrl.searchParams.set("state", state);

        return jsonResponse(req, {
          url: authUrl.toString(),
          flow: "facebook_business",
          requested_redirect_uri: body.redirect_uri ?? null,
          effective_redirect_uri: INSTAGRAM_BUSINESS_REDIRECT_URI,
        });
      }

      const state = await createOAuthState({
        platform: "instagram",
        flow: "facebook_business",
        user_id,
        profile_id: social_profile_id,
        return_to,
      });
      authUrl.searchParams.set("state", state);

      return jsonResponse(req, {
        url: authUrl.toString(),
        flow: "facebook_business",
        requested_redirect_uri: body.redirect_uri ?? null,
        effective_redirect_uri: INSTAGRAM_BUSINESS_REDIRECT_URI,
      });
    } catch (err) {
      const client = protectedOAuthClientError(err);
      if (client) {
        console.error("[instagram-business-oauth] protected request refused", {
          event: client.error_code,
        });
        return jsonResponse(req, { error_code: client.error_code, error: client.error }, client.status);
      }
      console.error("instagram-business-oauth POST failed:", err);
      return jsonResponse(req, { error: "Failed to start Instagram Business authorization" }, 500);
    }
  } catch (error) {
    const client = protectedOAuthClientError(error);
    if (client) {
      console.error("[instagram-business-oauth] protected request refused", {
        event: client.error_code,
      });
      return jsonResponse(req, { error_code: client.error_code, error: client.error }, client.status);
    }
    const config = configurationClientError(error);
    if (config) {
      console.error("[instagram-business-oauth] credential configuration refused", {
        event: config.error_code,
      });
      return jsonResponse(req, {
        error_code: config.error_code,
        error: config.error,
      }, config.status);
    }
    console.error("instagram-business-oauth POST failed:", error);
    return jsonResponse(req, { error: "Failed to start Instagram Business authorization" }, 500);
  }
});
