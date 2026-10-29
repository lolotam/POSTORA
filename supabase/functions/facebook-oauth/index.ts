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
  createFacebookRouteContext,
  facebookRouteFlow,
  oauthTripwirePorts,
  projectFacebookPicker,
  type FacebookProtectedRuntime,
} from "./protectedPageConnect.ts";
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
  pendingReferenceRefusal,
  protectedCommit,
  protectedOAuthClientError,
  protectedPickerRead,
  protectedSelectionRefusal,
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
  protectedWebhookSubscribe,
  PROTECTED_HTTP_TIMEOUT_MS,
  PROTECTED_OPERATION_BUDGET_MS,
} from "../_shared/metaOAuthProtectedBoundary.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Public origin used to derive the OAuth redirect URI registered with Meta.
// On self-hosted Supabase, SUPABASE_URL points at the internal Kong gateway
// (http://kong:8000), which is unreachable from the provider — never derive
// the redirect_uri from it.
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const FACEBOOK_REDIRECT_URI =
  Deno.env.get("FACEBOOK_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/facebook-oauth`;
const FB_DEFAULT_RETURN_TO = "https://postora.cloud/profiles";
const FB_OAUTH_SCOPES = [
  "email", "public_profile", "pages_show_list", "pages_read_engagement",
  "pages_manage_posts", "pages_manage_engagement", "pages_read_user_content", "business_management",
  "pages_manage_metadata", "pages_messaging", "read_insights",
  "instagram_basic", "instagram_content_publish", "instagram_manage_comments",
  "instagram_manage_messages",
  "whatsapp_business_messaging", "whatsapp_business_management",
  "ads_read", "ads_management",
  "leads_retrieval", "pages_manage_ads",
];


interface FacebookPage {
  id: string;
  name: string;
  access_token: string;
  category?: string;
  instagram_business_account?: { id: string; username?: string; profile_picture_url?: string };
  picture?: { data?: { url?: string } };
}

interface StandaloneInstagramAccount {
  id: string;
  username: string;
  profile_picture_url?: string;
}

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

function normalizeUsername(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.toLowerCase().replace(/^@/, "").trim();
}

// Helper to check if Instagram via Facebook is enabled
async function isInstagramViaFacebookEnabled(supabase: AnySupabase): Promise<boolean> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "feature_instagram_via_facebook")
      .single();
    if (!data) return true; // default enabled
    let val = data.value;
    if (typeof val === "string") {
      try { val = JSON.parse(val); } catch { /* keep */ }
    }
    return val === true || val === "true";
  } catch {
    return true; // default enabled
  }
}

// Helper to merge-upsert an Instagram account by normalized username
async function mergeUpsertInstagram(
  supabase: AnySupabase,
  user_id: string,
  igUserId: string,
  igUsername: string,
  accessToken: string,
  avatarUrl: string | null,
  socialProfileId: string | null,
  tokenExpiresAt: string | null,
  igAuthType: string,
  accountMetadata: Record<string, unknown>,
) {
  const normalizedIncoming = normalizeUsername(igUsername);

  // Search for existing Instagram account by normalized username
  const { data: existingAccounts } = await supabase
    .from("social_accounts")
    .select("id, platform_user_id, platform_username")
    .eq("user_id", user_id)
    .eq("platform", "instagram")
    .eq("is_active", true);

  let existingId: string | null = null;
  if (existingAccounts && existingAccounts.length > 0) {
    for (const acc of existingAccounts) {
      if (normalizeUsername(acc.platform_username) === normalizedIncoming) {
        existingId = acc.id;
        console.log(`Found existing Instagram account by username match: ${acc.platform_username} (id: ${acc.id})`);
        break;
      }
    }
  }

  const accountData = {
    user_id,
    platform: "instagram",
    platform_user_id: igUserId,
    platform_username: `@${normalizedIncoming}`,
    access_token: accessToken,
    avatar_url: avatarUrl,
    account_metadata: accountMetadata,
    ig_auth_type: igAuthType,
    is_active: true,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    social_profile_id: socialProfileId || null,
    token_expires_at: tokenExpiresAt,
    needs_reauth: false,
    failure_count: 0,
    last_refresh_error: null,
  };

  if (existingId) {
    const { error } = await supabase
      .from("social_accounts")
      .update(accountData)
      .eq("id", existingId);
    if (error) {
      console.error("Error updating existing Instagram account:", error);
    } else {
      console.log("Updated existing Instagram account (merge by username):", existingId);
    }
    return error;
  } else {
    const { error } = await supabase
      .from("social_accounts")
      .upsert(accountData, { onConflict: "user_id,platform,platform_user_id" });
    if (error) {
      console.error("Error upserting Instagram account:", error);
    } else {
      console.log("Upserted Instagram account:", igUsername);
    }
    return error;
  }
}

// Helper to exchange a short-lived token for a long-lived one (60 days)
async function exchangeForLongLivedToken(shortLivedToken: string): Promise<{ token: string; expiresAt: string | null }> {
  const appId = Deno.env.get("FACEBOOK_APP_ID");
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");

  if (!appId || !appSecret) {
    console.warn("FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not configured - token will expire quickly!");
    const expiresDate = new Date();
    expiresDate.setHours(expiresDate.getHours() + 1);
    return { token: shortLivedToken, expiresAt: expiresDate.toISOString() };
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`,
    );
    const data = await response.json();

    if (data.access_token) {
      const expiresIn = data.expires_in || 5184000;
      const expiresDate = new Date();
      expiresDate.setSeconds(expiresDate.getSeconds() + expiresIn);
      console.log("Exchanged for long-lived token, expires:", expiresDate.toISOString());
      return { token: data.access_token, expiresAt: expiresDate.toISOString() };
    }
  } catch (e) {
    console.error("Error exchanging for long-lived token:", e);
  }

  const expiresDate = new Date();
  expiresDate.setHours(expiresDate.getHours() + 1);
  return { token: shortLivedToken, expiresAt: expiresDate.toISOString() };
}

// Meta gates delivery on the intersection of two subscriptions: the app-level fields in the
// App Dashboard, and the per-Page fields registered here. `feed` is what carries comment
// events, so omitting it meant the comment webhook path never received a single event no
// matter how the app was configured. POST replaces the whole set rather than adding to it,
// so every field the Page needs has to be listed on each call.
const PAGE_WEBHOOK_FIELDS = "messages,messaging_postbacks,feed";

// Best-effort: without this, the Page never sends any webhook events, but a failure here
// shouldn't block the page connection itself.
async function subscribePageToWebhooks(pageId: string, pageToken: string): Promise<void> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}/subscribed_apps?subscribed_fields=${PAGE_WEBHOOK_FIELDS}&access_token=${pageToken}`,
      { method: "POST" },
    );
    if (!res.ok) {
      console.warn("Failed to subscribe page to webhooks:", pageId, await res.text());
      return;
    }
    console.log("Subscribed page to webhooks:", pageId);
  } catch (e) {
    console.warn("Error subscribing page to webhooks:", pageId, e);
  }
}

/**
 * The protected Page subscription.
 *
 * It runs only after the account commit, it never receives a browser-supplied
 * token, and it reports the failure without copying provider text.
 */
async function subscribeProtectedPageToWebhooks(
  pageId: string,
  pageToken: string,
): Promise<void> {
  const url = new URL(`https://graph.facebook.com/v22.0/${pageId}/subscribed_apps`);
  url.searchParams.set("subscribed_fields", PAGE_WEBHOOK_FIELDS);
  url.searchParams.set("access_token", pageToken);
  await protectedWebhookSubscribe({
    url: url.toString(),
    budget: createOperationBudget(PROTECTED_HTTP_TIMEOUT_MS),
  });
}

const PAGE_FIELDS = "id,name,access_token,category,picture.type(large),instagram_business_account{id,username,profile_picture_url}";

async function fetchFacebookPages(
  providerToken: string,
  fbUserId?: string,
  options: { logRaw?: boolean } = {},
): Promise<FacebookPage[]> {
  const candidates: Array<{ label: string; url: string }> = [
    {
      label: "me/accounts",
      url: `https://graph.facebook.com/v18.0/me/accounts?fields=${PAGE_FIELDS}&access_token=${providerToken}`,
    },
    {
      label: "me/assigned_pages",
      url: `https://graph.facebook.com/v18.0/me/assigned_pages?fields=${PAGE_FIELDS}&access_token=${providerToken}`,
    },
  ];

  if (fbUserId) {
    candidates.push({
      label: "{user_id}/accounts",
      url: `https://graph.facebook.com/v18.0/${fbUserId}/accounts?fields=${PAGE_FIELDS}&access_token=${providerToken}`,
    });
  }

  for (const c of candidates) {
    try {
      console.log(`Fetching pages from (${c.label}):`, c.url.replace(providerToken, "[TOKEN]"));
      const res = await fetch(c.url);
      const json = await res.json();
      if (options.logRaw !== false) {
        console.log(`Pages API raw response (${c.label}):`, JSON.stringify(json));
      }

      if (json?.error) {
        console.error(`Pages API error (${c.label}):`, JSON.stringify(json.error));
        if (json.error.code === 190 || json.error.type === "OAuthException") {
          throw new Error("Facebook token expired or invalid. Please reconnect.");
        }
        throw new Error(json.error.message);
      }

      const pages: FacebookPage[] = json?.data || [];
      if (pages.length > 0) return pages;
    } catch (e) {
      if (options.logRaw === false) {
        console.warn(`Failed to fetch pages via ${c.label}`);
        continue;
      }
      console.warn(`Failed to fetch pages via ${c.label}:`, e);
    }
  }

  return [];
}

async function fetchStandaloneInstagramAccounts(
  providerToken: string,
  linkedIgIds: Set<string>,
): Promise<StandaloneInstagramAccount[]> {
  const standalone: StandaloneInstagramAccount[] = [];

  try {
    const bizRes = await fetch(
      `https://graph.facebook.com/v18.0/me/businesses?fields=id,name&access_token=${providerToken}`,
    );
    const bizJson = await bizRes.json();
    console.log("Businesses response:", JSON.stringify(bizJson));

    const businesses = bizJson?.data || [];
    if (businesses.length === 0) {
      console.log("No businesses found, skipping standalone IG fetch");
      return [];
    }

    for (const biz of businesses) {
      try {
        const igRes = await fetch(
          `https://graph.facebook.com/v18.0/${biz.id}/instagram_accounts?fields=id,username,profile_picture_url&access_token=${providerToken}`,
        );
        const igJson = await igRes.json();
        console.log(`IG accounts for business ${biz.name}:`, JSON.stringify(igJson));

        if (igJson?.error) {
          console.warn(`Error fetching IG for business ${biz.id}:`, igJson.error.message);
          continue;
        }

        const igAccounts = igJson?.data || [];
        for (const ig of igAccounts) {
          if (linkedIgIds.has(ig.id)) {
            console.log(`Skipping IG ${ig.username} (${ig.id}) - already linked to a Page`);
            continue;
          }
          standalone.push({
            id: ig.id,
            username: ig.username,
            profile_picture_url: ig.profile_picture_url,
          });
        }
      } catch (e) {
        console.warn(`Error fetching IG accounts for business ${biz.id}:`, e);
      }
    }
  } catch (e) {
    console.warn("Error fetching businesses for standalone IG:", e);
  }

  console.log("Standalone Instagram accounts found:", standalone.length);
  return standalone;
}

async function ensurePageAccessToken(page: FacebookPage, providerToken: string): Promise<string | null> {
  if (page.access_token) return page.access_token;

  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${page.id}?fields=access_token&access_token=${providerToken}`,
    );
    const json = await res.json();
    if (json?.access_token) return json.access_token;
    if (json?.error) {
      console.warn("Could not fetch page access_token:", JSON.stringify(json.error));
    }
  } catch (e) {
    console.warn("Error fetching page access_token:", e);
  }

  return null;
}


function safeReturnTo(candidate: unknown): string {
  if (typeof candidate === "string") {
    try {
      const u = new URL(candidate);
      if (u.protocol === "https:" && u.hostname.endsWith("postora.cloud")) {
        return candidate;
      }
    } catch { /* fall through */ }
  }
  return FB_DEFAULT_RETURN_TO;
}


function redirectResponse(req: Request, url: string): Response {
  return new Response(null, { status: 302, headers: { ...restrictedCorsHeaders(req), Location: url } });
}

async function loadPendingSelectionRow(
  supabase: AnySupabase,
  selectionId: string,
  userId: string,
): Promise<{
  provider_token: string;
  social_profile_id: string | null;
  target_platform: "facebook" | "instagram";
  pages_json: unknown;
  ig_standalone_json: unknown;
} | null> {
  // SECURITY: the `user_id = userId` equality below is the only guard that
  // stops one authenticated user from consuming another user's pending
  // selection row (and its long-lived FB user token). Do NOT relax it.
  const { data, error } = await supabase
    .from("oauth_pending_facebook_selections")
    .select("provider_token, social_profile_id, target_platform, pages_json, ig_standalone_json, expires_at, user_id")
    .eq("id", selectionId)
    .maybeSingle();
  if (error || !data || data.user_id !== userId) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data;
}

/**
 * A protected Facebook callback that cannot be completed. The attempt has
 * already been claimed, so the user has to start a new authorization.
 */
class ProtectedFacebookRefusal extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ProtectedFacebookRefusal";
    this.reason = reason;
  }
}

/**
 * The protected Facebook callback.
 *
 * The attempt is claimed BEFORE the code exchange. Only the claimed service
 * data builds the candidate set, the attempt is completed once, and the
 * picker receives nothing but the opaque pending selection id.
 */
async function handleProtectedFacebookCallback(
  req: Request,
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
        const appId = Deno.env.get("FACEBOOK_APP_ID");
        const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
        if (!appId || !appSecret) {
          throw new ProtectedFacebookRefusal("service_configuration");
        }

        const budget = createOperationBudget(PROTECTED_OPERATION_BUDGET_MS);
        const grant = await exchangeProtectedFacebookCode({
          graphVersion: "v22.0",
          appId,
          appSecret,
          redirectUri: FACEBOOK_REDIRECT_URI,
          code,
          budget,
        });
        const pages = await listProtectedManagedPages({
          graphVersion: "v22.0",
          accessToken: grant.token,
          budget,
        });
        if (pages.length === 0) {
          throw new ProtectedFacebookRefusal("no_pages");
        }

        const candidates: MetaOAuthCandidate[] = [];
        for (const page of pages) {
          const base: MetaOAuthCandidate = {
            facebook_page_id: page.id,
            facebook_page_name: page.name,
            page_access_token: page.accessToken,
            facebook_user_id: grant.facebookUserId,
          };
          if (context.flow === "facebook_page") {
            if (page.instagram) {
              candidates.push({
                ...base,
                candidate_kind: "page_plus_ig",
                ig_user_id: page.instagram.id,
                ig_username: page.instagram.username ?? `ig_${page.instagram.id}`,
                ig_profile_picture_url: page.instagram.profilePictureUrl,
              });
            } else {
              candidates.push({ ...base, candidate_kind: "page_only" });
            }
          } else if (page.instagram) {
            candidates.push({
              ...base,
              candidate_kind: "ig_only",
              ig_user_id: page.instagram.id,
              ig_username: page.instagram.username ?? `ig_${page.instagram.id}`,
              ig_profile_picture_url: page.instagram.profilePictureUrl,
            });
          }
        }

        if (candidates.length === 0) {
          throw new ProtectedFacebookRefusal("no_pages");
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

    const marker = complete.flow === "facebook_page" ? "facebook" : "instagram_business";
    const target = new URL(returnTo);
    target.searchParams.set("connected", marker);
    target.searchParams.set("select", complete.pendingSelectionId);
    return redirectResponse(req, target.toString());
  } catch (error) {
    if (error instanceof ProtectedFacebookRefusal) {
      const target = new URL(returnTo);
      target.searchParams.set("connected", "facebook");
      target.searchParams.set("error", error.reason);
      return redirectResponse(req, target.toString());
    }
    if (error instanceof ProtectedProviderFailure) {
      logProtectedFailure("facebook-oauth", error);
      const target = new URL(returnTo);
      target.searchParams.set("connected", "facebook");
      target.searchParams.set("error", protectedProviderClientReason(error));
      return redirectResponse(req, target.toString());
    }
    const client = protectedOAuthClientError(error);
    if (client) {
      console.error("[facebook-oauth] protected callback refused", {
        event: client.error_code,
      });
      const target = new URL(returnTo);
      target.searchParams.set("connected", "facebook");
      target.searchParams.set("error", client.error_code);
      return redirectResponse(req, target.toString());
    }
    logProtectedFailure("facebook-oauth", error);
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "internal_error");
    return redirectResponse(req, target.toString());
  }
}

async function handleFacebookGetCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const errorReason = url.searchParams.get("error_reason") ?? url.searchParams.get("error_description");

  let returnTo = FB_DEFAULT_RETURN_TO;

  if (oauthError) {
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", oauthError);
    if (errorReason) target.searchParams.set("error_description", errorReason);
    return redirectResponse(req, target.toString());
  }

  if (!code || !stateParam) {
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "missing_code_or_state");
    return redirectResponse(req, target.toString());
  }

  let state;
  try {
    state = await verifyOAuthState(stateParam, { expectedPlatform: "facebook" });
  } catch (e) {
    console.warn("Facebook callback state verification failed:", e);
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "invalid_state");
    return redirectResponse(req, target.toString());
  }

  returnTo = safeReturnTo(state.return_to);
  const targetPlatform = (state as { target_platform?: string }).target_platform === "instagram"
    ? "instagram"
    : "facebook";

  const appId = Deno.env.get("FACEBOOK_APP_ID");
  const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
  if (!appId || !appSecret || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Facebook OAuth configuration missing during GET callback");
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "service_configuration");
    return redirectResponse(req, target.toString());
  }

  // The mode is read before any claim or provider call. An unreadable
  // setting refuses. A readable legacy setting does not downgrade a signed
  // protected attempt.
  let attemptContext: ProtectedAttemptStateContext | null = null;
  try {
    attemptContext = readProtectedAttemptContext(state);
  } catch {
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "invalid_state");
    return redirectResponse(req, target.toString());
  }

  const settingsClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let credentialMode: FacebookCredentialMode;
  try {
    const loaded = await loadFacebookCredentialSettings(
      createAppSettingLookup(async (key) => {
        const { data, error } = await settingsClient
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
    );
    credentialMode = loaded.credentialMode;
  } catch (error) {
    const config = configurationClientError(error);
    console.error("[facebook-oauth] credential configuration refused", {
      event: config?.error_code ?? "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
    });
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "credential_configuration_unavailable");
    return redirectResponse(req, target.toString());
  }

  if (attemptContext) {
    const expectedFlow = facebookRouteFlow(targetPlatform);
    if (attemptContext.flow !== expectedFlow) {
      const target = new URL(returnTo);
      target.searchParams.set("connected", "facebook");
      target.searchParams.set("error", "protected_oauth_flow_mismatch");
      return redirectResponse(req, target.toString());
    }
    return await handleProtectedFacebookCallback(
      req,
      returnTo,
      code,
      state.user_id,
      attemptContext,
    );
  }

  // A legacy callback. While protected mode is selected it refuses and asks
  // for a restart instead of writing a legacy account.
  if (credentialMode === "protected") {
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "protected_reauthorization_required");
    return redirectResponse(req, target.toString());
  }

  // Exchange code → short-lived user token, then upgrade to long-lived.
  const tokenUrl =
    `https://graph.facebook.com/v22.0/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenRes = await fetch(tokenUrl);
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    console.error("Facebook code exchange failed:", tokenJson?.error?.message ?? "unknown");
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "code_exchange_failed");
    return redirectResponse(req, target.toString());
  }

  const { token: longLivedUserToken } = await exchangeForLongLivedToken(tokenJson.access_token);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const igViaFbEnabled = await isInstagramViaFacebookEnabled(supabase);

  // Reuse existing helpers to enumerate pages + standalone IG.
  const pages = await fetchFacebookPages(longLivedUserToken);
  const linkedIgIds = new Set<string>();
  for (const p of pages) {
    if (p.instagram_business_account?.id) linkedIgIds.add(p.instagram_business_account.id);
  }
  const standaloneIg = igViaFbEnabled
    ? await fetchStandaloneInstagramAccounts(longLivedUserToken, linkedIgIds)
    : [];

  const { data: inserted, error: insertError } = await supabase
    .from("oauth_pending_facebook_selections")
    .insert({
      user_id: state.user_id,
      social_profile_id: state.profile_id ?? null,
      target_platform: targetPlatform,
      provider_token: longLivedUserToken,
      pages_json: pages.map((p) => ({
        id: p.id,
        name: p.name,
        has_instagram: igViaFbEnabled ? !!p.instagram_business_account : false,
        picture_url: p.picture?.data?.url ?? null,
      })),
      ig_standalone_json: standaloneIg,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    console.error("Failed to stash pending Facebook selection:", insertError);
    const target = new URL(returnTo);
    target.searchParams.set("connected", "facebook");
    target.searchParams.set("error", "selection_stash_failed");
    return redirectResponse(req, target.toString());
  }

  const target = new URL(returnTo);
  target.searchParams.set("connected", "facebook");
  target.searchParams.set("select", inserted.id);
  return redirectResponse(req, target.toString());
}

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);


  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Backend OAuth callback (unified pattern). Provider redirects here with
  // ?code=...&state=...; we exchange the code server-side, stash pages in a
  // short-lived selection row, then 302 back to the frontend.
  if (req.method === "GET") {
    return await handleFacebookGetCallback(req);
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }


  const body = await req.json().catch(() => ({}));
  const authHeader = req.headers.get("Authorization");

  if (!authHeader || !/^Bearer \S+$/.test(authHeader)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !Deno.env.get("FACEBOOK_APP_ID")) {
    console.error("Facebook OAuth configuration is incomplete");
    return new Response(JSON.stringify({ error: "Service configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let user_id: string;
  try {
    const auth = await authenticateCaller(req, body.user_id);
    user_id = auth.userId;
  } catch {
    console.warn("Facebook OAuth authentication failed");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!body.action) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const validActions = [
    "list_pages", "store_page", "store_account", "store_instagram",
    "authorize", "get_pending_selection",
  ];
  // Legacy actions that require the FB JS SDK provider_token. New backend
  // callback path uses `selection_id` instead, so providing either satisfies
  // store_page / store_instagram. The protected path uses the attempt id plus
  // the opaque selection key instead of a page id.
  const legacyTokenActions = ["list_pages", "store_account"];
  const selectionOrTokenActions = ["store_page", "store_instagram"];
  const missingActionField =
    (legacyTokenActions.includes(body.action) && !body.provider_token) ||
    (selectionOrTokenActions.includes(body.action) &&
      !body.provider_token &&
      !body.selection_id &&
      !body.selection_key) ||
    (body.action === "store_page" && !body.page_id && !body.selection_key) ||
    (body.action === "store_instagram" && !body.instagram_account_id) ||
    (body.action === "get_pending_selection" && !body.selection_id);

  if (!validActions.includes(body.action) || missingActionField) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { action, social_profile_id, page_id } = body;
    let { provider_token } = body as { provider_token?: string };
    const platform = body.platform;

    console.log("Facebook OAuth action:", action);


    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const store = createMetaOAuthAttemptStoreFromClient(supabase);
    const runtime: FacebookProtectedRuntime = {
      store,
      linkage: createPendingLinkageReader(supabase),
      attempts: createProtectedAttemptReader(supabase),
      receipts: createProtectedReceiptReader(supabase),
    };

    // Every supplied pending reference is classified in BOTH modes, before any
    // provider call, mutation, secret read or deletion.
    const selectionId = (body.selection_id as string | undefined) ?? null;
    const attemptId = (body.attempt_id as string | undefined) ?? null;
    const selectionKey = (body.selection_key as string | undefined) ?? null;
    const providerTokenPresent =
      typeof provider_token === "string" && provider_token.length > 0;
    const classification = await classifyPendingReference(runtime.linkage, {
      userId: user_id,
      selectionId,
      attemptId,
      providerTokenPresent,
    });
    const classificationError = pendingReferenceRefusal(classification);
    if (classificationError) {
      return new Response(JSON.stringify({
        error_code: classificationError.code,
        error: classificationError.message,
      }), {
        status: classificationError.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Protected mode dispatches the supported captured lifecycle and refuses
    // every unsupported action before provider exchange, token stash and
    // account writes. Legacy mode continues below and does not touch the
    // protected credential schema.
    const decision = await beginOAuthRequest({
      lookup: createAppSettingLookup(async (key) => {
        const { data, error } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", key)
          .maybeSingle();
        return appSettingReadResult(data, error);
      }),
      flow: "facebook_oauth",
      action: String(action),
      ports: oauthTripwirePorts(),
      legacy: async () => "continue" as const,
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
      userId: user_id,
    });
    if (isLifecycleRefusal(decision)) {
      return new Response(JSON.stringify({
        error_code: decision.errorCode,
        error: decision.error,
      }), {
        status: decision.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if Instagram via Facebook is enabled (used in multiple actions)
    const igViaFbEnabled = await isInstagramViaFacebookEnabled(supabase);
    console.log("Instagram via Facebook enabled:", igViaFbEnabled);

    // Action: Build the Meta authorization URL (new unified backend-callback path).
    if (action === "authorize") {
      const targetPlatform = body.target_platform === "instagram" ? "instagram" : "facebook";
      const returnTo = safeReturnTo(body.return_to);
      const flow: MetaOAuthFlow = facebookRouteFlow(targetPlatform);
      const appId = Deno.env.get("FACEBOOK_APP_ID")!;

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
          flow,
          intent: intent.intent,
          targetSocialAccountId: intent.targetSocialAccountId,
          sourceSocialAccountId: intent.sourceSocialAccountId,
          linkedTargetSocialAccountId: intent.linkedTargetSocialAccountId,
          intendedSocialProfileId: (social_profile_id as string | null | undefined) ?? undefined,
        });

        const state = await createOAuthState({
          platform: "facebook",
          flow: "pages",
          user_id,
          profile_id: social_profile_id ?? null,
          return_to: returnTo,
          extra: {
            target_platform: targetPlatform,
            [PROTECTED_ATTEMPT_STATE_KEY]: begun.stateContext,
          },
        });
        const authorizeUrl =
          `https://www.facebook.com/v22.0/dialog/oauth` +
          `?client_id=${encodeURIComponent(appId)}` +
          `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
          `&state=${encodeURIComponent(state)}` +
          `&response_type=code` +
          `&scope=${encodeURIComponent(FB_OAUTH_SCOPES.join(","))}`;
        return new Response(JSON.stringify({ success: true, url: authorizeUrl }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const state = await createOAuthState({
        platform: "facebook",
        flow: "pages",
        user_id,
        profile_id: social_profile_id ?? null,
        return_to: returnTo,
        extra: { target_platform: targetPlatform },
      });
      const authorizeUrl =
        `https://www.facebook.com/v22.0/dialog/oauth` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&redirect_uri=${encodeURIComponent(FACEBOOK_REDIRECT_URI)}` +
        `&state=${encodeURIComponent(state)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(FB_OAUTH_SCOPES.join(","))}`;
      return new Response(JSON.stringify({ success: true, url: authorizeUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: Look up a pending selection row created by the GET callback.
    // Returns pages + standalone IG but NEVER the provider token.
    if (action === "get_pending_selection") {
      if (decision === "protected") {
        const projection = await protectedPickerRead(
          createFacebookRouteContext(runtime, user_id, [
            "facebook_page",
            "instagram_page_linked",
          ]),
          { pendingSelectionId: selectionId as string },
        );
        const projected = projectFacebookPicker(projection);
        return new Response(JSON.stringify({
          success: true,
          protected: true,
          attempt_id: projected.attempt_id,
          social_profile_id: projected.social_profile_id,
          expired: projected.expired,
          committed_selection_keys: projected.committed_selection_keys,
          pages: projected.pages,
          standalone_instagram: projected.standalone_instagram,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const row = await loadPendingSelectionRow(supabase, body.selection_id, user_id);
      if (!row) {
        return new Response(JSON.stringify({ error: "Selection not found or expired" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        success: true,
        pages: row.pages_json ?? [],
        standalone_instagram: row.ig_standalone_json ?? [],
        social_profile_id: row.social_profile_id,
        target_platform: row.target_platform,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // For store_page / store_instagram, allow the caller to reference a
    // pending selection row created by the GET callback instead of sending
    // the FB SDK provider_token directly. The server reads the long-lived
    // token from that row and deletes it after a successful store.
    //
    // A protected row never reaches this read: the classification above
    // routed it to the protected adapter, and a protected row's secret
    // projection is never read by the legacy path.
    let pendingSelectionId: string | null = null;
    if (
      decision !== "protected" &&
      (action === "store_page" || action === "store_instagram") &&
      body.selection_id &&
      !provider_token
    ) {
      const row = await loadPendingSelectionRow(supabase, body.selection_id, user_id);
      if (!row) {
        return new Response(JSON.stringify({ error: "Selection not found or expired" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      provider_token = row.provider_token;
      pendingSelectionId = body.selection_id;
    }

    // Action: Get list of Facebook Pages the user manages (for selection UI)
    if (action === "list_pages") {

      if (!provider_token) {
        throw new Error("Missing provider_token");
      }

      console.log("Fetching Facebook Pages...");

      const pagesResponse = await fetch(
        `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,category,instagram_business_account&access_token=${provider_token}`
      );
      const pagesData = await pagesResponse.json();

      if (pagesData.error) {
        throw new Error(pagesData.error.message);
      }

      const pages: FacebookPage[] = pagesData.data || [];
      console.log("Found pages:", pages.length);

      const pagesWithInstagram = await Promise.all(
        pages.map(async (page) => {
          let instagram = null;
          // Only fetch Instagram info if feature flag is enabled
          if (igViaFbEnabled && page.instagram_business_account?.id) {
            try {
              const igResponse = await fetch(
                `https://graph.facebook.com/v18.0/${page.instagram_business_account.id}?fields=id,username,profile_picture_url&access_token=${provider_token}`
              );
              const igData = await igResponse.json();
              if (!igData.error) {
                instagram = {
                  id: igData.id,
                  username: igData.username,
                  profile_picture_url: igData.profile_picture_url,
                };
              }
            } catch (e) {
              console.error("Error fetching Instagram for page:", page.id, e);
            }
          }
          return {
            id: page.id,
            name: page.name,
            category: page.category,
            instagram,
          };
        })
      );

      return new Response(JSON.stringify({ success: true, pages: pagesWithInstagram }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: Store a specific Facebook Page (after user selection)
    if (action === "store_page") {
      if (decision === "protected") {
        // The protected path commits the verified candidate through the
        // accepted atomic selection transaction. The authority is the attempt
        // id plus the opaque selection key, never a browser-supplied page
        // name or username.
        const committed = await protectedCommit(
          createFacebookRouteContext(runtime, user_id, ["facebook_page"]),
          {
            selectionId,
            attemptId,
            selectionKey,
            providerTokenPresent,
          },
        );

        // Bounded, best effort, and only after the commit.
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
            async subscribe(input: { platform: "facebook" | "instagram"; providerId: string; token: string }) {
              await subscribeProtectedPageToWebhooks(input.providerId, input.token);
            },
          },
        });

        return new Response(JSON.stringify({
          success: true,
          protected: true,
          attempt_id: committed.receipt.attemptId,
          selection_key: committed.receipt.selectionKey,
          page_name: committed.receipt.username,
          has_instagram: committed.receipt.companionSocialAccountId !== null,
          subscription,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!user_id || !provider_token || !page_id) {
        throw new Error("Missing user_id, provider_token, or page_id");
      }

      console.log("Storing Facebook Page:", page_id);

      const pagesResponse = await fetch(
        `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,access_token,picture,instagram_business_account&access_token=${provider_token}`
      );
      const pagesData = await pagesResponse.json();

      if (pagesData.error) {
        throw new Error(pagesData.error.message);
      }

      const selectedPage = (pagesData.data as FacebookPage[])?.find((p) => p.id === page_id);
      if (!selectedPage) {
        throw new Error("Page not found or you don't have access to it");
      }

      const pictureResponse = await fetch(
        `https://graph.facebook.com/v18.0/${page_id}/picture?redirect=false&type=large&access_token=${selectedPage.access_token}`
      );
      const pictureData = await pictureResponse.json();
      const rawAvatarUrl = pictureData.data?.url || null;
      const avatarUrl = await cacheAvatarToCdn(rawAvatarUrl, user_id, "facebook", selectedPage.id);

      const { token: longLivedPageToken, expiresAt: tokenExpiresAt } = await exchangeForLongLivedToken(selectedPage.access_token);
      // Also exchange user token for long-lived version (for ad account access)
      const { token: longLivedUserToken } = await exchangeForLongLivedToken(provider_token);

      const { error: fbError } = await supabase
        .from("social_accounts")
        .upsert({
          user_id,
          platform: "facebook",
          platform_user_id: selectedPage.id,
          platform_username: selectedPage.name,
          access_token: longLivedPageToken,
          avatar_url: avatarUrl,
          is_active: true,
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          social_profile_id: social_profile_id || null,
          token_expires_at: tokenExpiresAt,
          // A completed reconnect must clear the health flags, or the account keeps
          // showing the red "Action Required: Reconnect" button with a valid token.
          needs_reauth: false,
          failure_count: 0,
          last_refresh_error: null,
          account_metadata: {
            type: "page",
            user_token: longLivedUserToken,
          },
        }, {
          onConflict: "user_id,platform,platform_user_id",
        });

      if (fbError) {
        console.error("Error storing Facebook Page:", fbError);
        throw fbError;
      }

      await subscribePageToWebhooks(selectedPage.id, longLivedPageToken);

      console.log("Facebook Page stored successfully:", selectedPage.name);

      // Only store Instagram if feature flag is enabled
      let hasInstagram = false;
      if (igViaFbEnabled && selectedPage.instagram_business_account?.id) {
        console.log("Found linked Instagram business account, storing...");

        const igId = selectedPage.instagram_business_account.id;
        const igResponse = await fetch(
          `https://graph.facebook.com/v18.0/${igId}?fields=id,username,profile_picture_url&access_token=${selectedPage.access_token}`
        );
        const igUser = await igResponse.json();

        if (!igUser.error) {
          const cachedIgAvatar = await cacheAvatarToCdn(
            igUser.profile_picture_url,
            user_id,
            "instagram",
            igUser.id
          );

          await mergeUpsertInstagram(
            supabase,
            user_id,
            igUser.id,
            igUser.username,
            longLivedPageToken,
            cachedIgAvatar,
            social_profile_id,
            tokenExpiresAt,
            "facebook_page",
            {
              facebook_page_id: selectedPage.id,
              type: "business",
            },
          );
          hasInstagram = true;
        }
      } else if (!igViaFbEnabled && selectedPage.instagram_business_account?.id) {
        console.log("Instagram via Facebook disabled - skipping Instagram auto-import");
      }

      if (pendingSelectionId) {
        await supabase.from("oauth_pending_facebook_selections").delete().eq("id", pendingSelectionId);
      }

      return new Response(JSON.stringify({
        success: true,
        page_name: selectedPage.name,
        has_instagram: hasInstagram,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // Legacy action: store_account (backward compatibility)
    if (action === "store_account") {
      if (!user_id || !provider_token) {
        throw new Error("Missing user_id or provider_token");
      }

      console.log("store_account - fetching user info and pages");

      const fbUserResponse = await fetch(
        `https://graph.facebook.com/v18.0/me?fields=id,name,picture.type(large)&access_token=${provider_token}`
      );
      const fbUser = await fbUserResponse.json();

      if (fbUser.error) {
        console.error("Facebook user fetch error:", JSON.stringify(fbUser.error));
        throw new Error(fbUser.error.message);
      }

      console.log("Facebook user:", fbUser.name, "ID:", fbUser.id);

      const permissionsResponse = await fetch(
        `https://graph.facebook.com/v18.0/me/permissions?access_token=${provider_token}`
      );
      const permissionsData = await permissionsResponse.json();
      const grantedPerms = permissionsData.data || [];
      console.log("Granted permissions:", JSON.stringify(grantedPerms));

      const hasPageShowList = grantedPerms.some(
        (p: { permission: string; status: string }) =>
          p.permission === "pages_show_list" && p.status === "granted"
      );
      const hasPageManagePosts = grantedPerms.some(
        (p: { permission: string; status: string }) =>
          p.permission === "pages_manage_posts" && p.status === "granted"
      );

      console.log("Permission check - pages_show_list:", hasPageShowList, "pages_manage_posts:", hasPageManagePosts);

      const pages = await fetchFacebookPages(provider_token, fbUser.id);
      console.log("Number of pages found via fetchFacebookPages:", pages.length);

      if (pages.length > 0) {
        console.log("Pages found:", pages.map(p => ({ id: p.id, name: p.name })));
      }

      if (pages.length === 0) {
        let warningMessage: string;
        let detailedHelp: string;

        if (!hasPageShowList || !hasPageManagePosts) {
          const missingPerms = [];
          if (!hasPageShowList) missingPerms.push("pages_show_list");
          if (!hasPageManagePosts) missingPerms.push("pages_manage_posts");

          warningMessage = `Required permissions not granted: ${missingPerms.join(", ")}. Please reconnect and accept all permissions.`;
          detailedHelp = "When connecting Facebook, make sure to click 'Yes' on ALL permission requests. If you previously denied permissions, go to Facebook Settings > Apps and Websites > remove Postora, then try connecting again.";
        } else {
          warningMessage = "You don't manage any Facebook Pages. Create a Page first, then reconnect.";
          detailedHelp = "To post via Facebook, you need a Facebook Page (not a personal profile). Go to Meta Business Suite > Settings > Accounts > Pages and make sure you have 'Full control' access to at least one Page. If you just created a Page, wait a few minutes and try again.";
        }

        console.log("No pages found - Warning:", warningMessage);
        console.log("Help:", detailedHelp);
        console.log("Target platform:", platform, "- NOT storing personal profile account");

        // If the intent was Instagram via Facebook, return an error — no account should be created
        if (platform === "instagram") {
          return new Response(JSON.stringify({
            success: false,
            error: "No Facebook Pages found. To connect Instagram via Facebook, you need a Facebook Page with a linked Instagram Business/Creator account. Please create a Facebook Page, link your Instagram account to it, then try again.",
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // For Facebook platform: return the warning but do NOT store a personal profile account
        // Personal profiles cannot post via the API, so storing them creates misleading entries
        return new Response(JSON.stringify({
          success: true,
          needs_page_selection: false,
          warning: warningMessage,
          help: detailedHelp,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // If user has exactly 1 page, auto-select it
      if (pages.length === 1) {
        const page = pages[0];
        console.log("Auto-selecting single page:", page.name);

        const pictureResponse = await fetch(
          `https://graph.facebook.com/v18.0/${page.id}/picture?redirect=false&type=large&access_token=${page.access_token}`
        );
        const pictureData = await pictureResponse.json();
        const avatarUrl = pictureData.data?.url || null;

        const { token: longLivedToken, expiresAt } = await exchangeForLongLivedToken(page.access_token);
        // Also exchange user token for long-lived version (for ad account access)
        const { token: longLivedUserToken } = await exchangeForLongLivedToken(provider_token);

        const { error: fbError } = await supabase
          .from("social_accounts")
          .upsert({
            user_id,
            platform: "facebook",
            platform_user_id: page.id,
            platform_username: page.name,
            access_token: longLivedToken,
            avatar_url: avatarUrl,
            is_active: true,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            social_profile_id: social_profile_id || null,
            token_expires_at: expiresAt,
            // A completed reconnect must clear the health flags, or the account keeps
            // showing the red "Action Required: Reconnect" button with a valid token.
            needs_reauth: false,
            failure_count: 0,
            last_refresh_error: null,
          account_metadata: {
            type: "page",
            user_token: longLivedUserToken,
          },
        }, {
          onConflict: "user_id,platform,platform_user_id",
        });

        if (fbError) throw fbError;

        await subscribePageToWebhooks(page.id, longLivedToken);

        // Only store Instagram if feature flag is enabled
        let hasInstagram = false;
        if (igViaFbEnabled && page.instagram_business_account?.id) {
          const igId = page.instagram_business_account.id;
          const igResponse = await fetch(
            `https://graph.facebook.com/v18.0/${igId}?fields=id,username,profile_picture_url&access_token=${longLivedToken}`
          );
          const igUser = await igResponse.json();

          if (!igUser.error) {
            await mergeUpsertInstagram(
              supabase,
              user_id,
              igUser.id,
              igUser.username,
              longLivedToken,
              igUser.profile_picture_url,
              social_profile_id,
              expiresAt,
              "facebook_page",
              {
                facebook_page_id: page.id,
                type: "business",
              },
            );
            hasInstagram = true;
          }
        } else if (!igViaFbEnabled && page.instagram_business_account?.id) {
          console.log("Instagram via Facebook disabled - skipping Instagram auto-import");
        }

        return new Response(JSON.stringify({
          success: true,
          page_name: page.name,
          has_instagram: hasInstagram,
          needs_page_selection: false,
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Multiple pages - tell frontend to show selection UI
      console.log("Multiple pages found, needs selection:", pages.length);

      const linkedIgIds = new Set<string>();
      for (const p of pages) {
        if (p.instagram_business_account?.id) {
          linkedIgIds.add(p.instagram_business_account.id);
        }
      }

      // Only fetch standalone Instagram if flag is enabled
      const standaloneIg = igViaFbEnabled
        ? await fetchStandaloneInstagramAccounts(provider_token, linkedIgIds)
        : [];

      return new Response(JSON.stringify({
        success: true,
        needs_page_selection: true,
        pages: pages.map(p => ({
          id: p.id,
          name: p.name,
          has_instagram: igViaFbEnabled ? !!p.instagram_business_account : false,
        })),
        standalone_instagram: standaloneIg,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Action: Store a standalone Instagram account (not linked to a Page)
    if (action === "store_instagram") {
      if (!igViaFbEnabled) {
        throw new Error("Instagram via Facebook is disabled. Use Instagram Business Login instead.");
      }
      if (!user_id || !provider_token) {
        throw new Error("Missing user_id or provider_token");
      }
      const { instagram_account_id, instagram_username, instagram_profile_picture } = body;
      if (!instagram_account_id) {
        throw new Error("Missing instagram_account_id");
      }

      console.log("Storing standalone Instagram account:", instagram_username);

      const { token: longLivedToken, expiresAt } = await exchangeForLongLivedToken(provider_token);

      const avatarUrl = await cacheAvatarToCdn(
        instagram_profile_picture || null,
        user_id,
        "instagram",
        instagram_account_id,
      );

      const igError = await mergeUpsertInstagram(
        supabase,
        user_id,
        instagram_account_id,
        instagram_username,
        longLivedToken,
        avatarUrl,
        social_profile_id,
        expiresAt,
        "facebook_page",
        {
          type: "standalone_business",
        },
      );

      if (igError) {
        throw igError;
      }

      console.log("Standalone Instagram account stored:", instagram_username);

      if (pendingSelectionId) {
        await supabase.from("oauth_pending_facebook_selections").delete().eq("id", pendingSelectionId);
      }

      return new Response(JSON.stringify({
        success: true,
        instagram_username,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    return new Response(JSON.stringify({ error: "Invalid action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const protectedError = protectedOAuthClientError(error);
    if (protectedError) {
      console.error("[facebook-oauth] protected request refused", {
        event: protectedError.error_code,
      });
      return new Response(JSON.stringify({
        error_code: protectedError.error_code,
        error: protectedError.error,
      }), {
        status: protectedError.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const config = configurationClientError(error);
    if (config) {
      console.error("[facebook-oauth] credential configuration refused", {
        event: config.error_code,
      });
      return new Response(JSON.stringify({
        error_code: config.error_code,
        error: config.error,
      }), {
        status: config.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("Facebook OAuth request failed:", error instanceof Error ? error.name : "unknown");
    return new Response(JSON.stringify({ error: "Authentication failed. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
