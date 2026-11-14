import { analyticsSyncReceipt } from "../_shared/analyticsSyncResult.ts";
import { awaitWithAbort } from "../_shared/abort.ts";
// Service-role proxy routes behind the MCP tools list_comments, list_messages,
// get_post_analytics, generate_caption, generate_hashtags and generate_image.
// The target functions accept a user JWT or a service-role call carrying
// user_id (_shared/auth-helper.ts serviceRoleCallerUserId). n8n-api has already
// resolved userId from the API key; this module checks that the account
// belongs to that user and only then calls the function with the service role
// and that user_id. The functions apply their own plan checks and AI rate
// limits to the user_id they receive. Every dependency is injected so the tests
// run against fakes.

import { accountAnalyticsSchema, analyticsSyncSchema, listCompetitorsSchema, trackCompetitorSchema,
  untrackCompetitorSchema, competitorReportSchema, analyzeBrandSchema, normalizeTrackedHandle } from "../_shared/analyticsToolSchemas.ts";
import { CompetitorReportStore } from "../competitor-tracking-report/reportStore.ts";
import { assembleCompetitorReport } from "../competitor-tracking-report/assemble.ts";
import { COMPETITOR_REPORT_BASELINE_POLICY } from "../competitor-tracking-report/growth.ts";
import { filterBrandPosts, filterAccountMedia, normalizeBrandHandle } from "./analyticsFilters.ts";
import { isValidUuid } from "./requestGuards.ts";
import { containsSensitiveInfo } from "../_shared/errorSanitizer.ts";
import { MEDIA_QUOTA_CODE, isMediaQuotaMessage, mediaQuotaBody } from "../_shared/mediaQuotaError.ts";

export interface ProxyAccount {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string | null;
  is_active: boolean;
}

export interface InvokeResult {
  status: number;
  data: unknown;
}

export interface StoredImage {
  id: string;
  file_path?: string | null;
}

export interface ServiceProxyDeps {
  /** `failed` is true when the lookup itself errored, so a failed read never looks like a missing account. */
  loadAccount(accountId: string, signal?: AbortSignal): Promise<{ account: ProxyAccount | null; failed: boolean }>;
  invoke(functionName: string, body: Record<string, unknown>, timeoutMs: number): Promise<InvokeResult>;
  /** Service-only explicit-owner RPCs; PostgreSQL applies ownership and the shared UI rules. */
  rpc?(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  storeImage(userId: string, dataUrl: string): Promise<StoredImage>;
  /** Non-null when the user's daily media uploads are used up; checked before a billed image generation. */
  mediaQuotaBlocked(userId: string): Promise<{ limit: number } | null>;
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

const READ_TIMEOUT_MS = 45_000;
const AI_TEXT_TIMEOUT_MS = 60_000;
// Image models routinely take a minute; 90 s leaves room for the upload inside the 150 s edge request limit. No retry anywhere here, because every
// AI call is billed and a comment/message read is cheap to repeat by the client.
const AI_IMAGE_TIMEOUT_MS = 90_000;
const MAX_COMMENT_POSTS = 50;
const DEFAULT_COMMENT_POSTS = 25;
type AnalyticsPeriod = number | "all";
const THREADS_PERIODS: readonly AnalyticsPeriod[] = [7, 14, 30, 90];
/**
 * The Instagram owner report also serves one closed day, a year and all
 * time. Every other platform keeps the Threads periods.
 */
const INSTAGRAM_PERIODS: readonly AnalyticsPeriod[] = [1, 7, 14, 30, 90, 365, "all"];

// Meta conversation ids are short opaque tokens (t_123..., aWdfZG...); anything
// with a slash, query or fragment character never reaches the Graph URL path.
const CONVERSATION_ID_RE = /^[A-Za-z0-9_.:=-]{1,200}$/;

// Same envelope as apiError() in index.ts.
function proxyError(status: number, code: string, message: string): ProxyResult {
  return { status, body: { success: false, error: { code, message } } };
}

export function toProxyResponse(result: ProxyResult, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Owned = { account: ProxyAccount } | { error: ProxyResult };

async function loadOwnedAccount(deps: ServiceProxyDeps, userId: string, rawAccountId: unknown, options: { savedHistory?: boolean } = {}): Promise<Owned> {
  const accountId = typeof rawAccountId === "string" ? rawAccountId.trim() : "";
  if (!accountId) return { error: proxyError(400, "INVALID_ACCOUNT_ID", "social_account_id is required") };
  if (!isValidUuid(accountId)) {
    return { error: proxyError(400, "INVALID_ACCOUNT_ID", "social_account_id must be a Postora account UUID (from GET /api/v1/accounts)") };
  }
  const { account, failed } = await deps.loadAccount(accountId);
  if (failed) return { error: proxyError(500, "INTERNAL_ERROR", "Failed to fetch social account") };
  // One answer for "no such account" and "someone else's account", so a caller
  // cannot probe which account ids exist.
  if (!account || account.user_id !== userId) {
    console.warn(`[n8n-api] service proxy: account ${accountId} not found for caller ${userId}`);
    return { error: proxyError(404, "ACCOUNT_NOT_FOUND", "Social account not found or not owned by the authenticated user.") };
  }
  // Only saved Facebook/Threads reports can read disconnected accounts. Legacy
  // readers must not fall back to a different account.
  const savedHistory = options.savedHistory && (account.platform === "facebook" || account.platform === "threads");
  if (account.is_active === false && !savedHistory) {
    return { error: proxyError(409, "ACCOUNT_INACTIVE", "This social account is disconnected. Reconnect it in Postora first.") };
  }
  return { account };
}

// A function's own 4xx (plan required, AI rate limit, bad input) is the
// caller's to act on and passes through. A 5xx or an unreachable function
// becomes a generic 502/504, so internal error text never reaches the client.
function fromUpstream(functionName: string, result: InvokeResult): ProxyResult {
  if (result.status === 504) {
    return proxyError(504, "UPSTREAM_TIMEOUT", "The request took too long. Please retry shortly.");
  }
  if (result.status >= 500 || result.status < 200) {
    console.error(`[n8n-api] service proxy: ${functionName} answered ${result.status}`);
    return proxyError(502, "UPSTREAM_ERROR", "The Postora service behind this endpoint failed. Please retry shortly.");
  }
  return { status: result.status, body: redactErrorText(stripCredentialUrls(result.data)) };
}

// AI generations are billed per call and have no idempotency key, so a timeout
// is indeterminate: the provider may already have charged for it. Unlike a
// read, the caller is told not to retry straight away.
function fromAiUpstream(functionName: string, result: InvokeResult): ProxyResult {
  if (result.status === 504) {
    return proxyError(
      504,
      "GENERATION_TIMEOUT",
      "The AI generation did not finish in time and may already have counted against your AI usage. Wait a few minutes before trying again.",
    );
  }
  return fromUpstream(functionName, result);
}

// Several functions report platform failures as a 200 body with `error` /
// `message` text. Pass those through unless the text looks like it carries
// internals (SQL, stack traces, keys).
function redactErrorText(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = { ...(data as Record<string, unknown>) };
  for (const key of ["error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && containsSensitiveInfo(value)) record[key] = "the platform rejected the request";
  }
  return record;
}

// Graph pagination URLs (paging.next / paging.previous) embed the connected
// account's access_token, so they never leave the proxy; the opaque cursors
// stay. Any other string that still carries an access_token is dropped too.
export function stripCredentialUrls(value: unknown): unknown {
  if (typeof value === "string") return /(?:access_token|refresh_token|api_key|service_role_key|cron_secret)=/i.test(value) ? null : value;
  if (Array.isArray(value)) return value.map(stripCredentialUrls);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(access_?token|refresh_?token|permission_?token|service_?role_?key|cron_?secret|api_?key|authorization|app_?secret|token|secret|service_?key)$/i.test(key)) continue;
    if (key === "paging" && child && typeof child === "object" && !Array.isArray(child)) {
      const { next: _next, previous: _previous, ...rest } = child as Record<string, unknown>;
      out[key] = stripCredentialUrls(rest);
    } else {
      out[key] = stripCredentialUrls(child);
    }
  }
  return out;
}

function unsupported(feature: string, platform: string, supported: string): ProxyResult {
  return proxyError(400, "UNSUPPORTED_PLATFORM", `${feature} is not supported yet for ${platform} accounts. Supported: ${supported}.`);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Returns the parsed limit, or null when it is present but not a whole number from 1 to MAX_COMMENT_POSTS. */
function parseCommentLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_COMMENT_POSTS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_COMMENT_POSTS ? value : null;
}

function commentRequestFor(account: ProxyAccount): Record<string, unknown> | null {
  if (account.platform === "facebook") return { action: "get_page_comments", page_id: account.platform_user_id };
  if (account.platform === "instagram") return { action: "get_ig_comments", ig_user_id: account.platform_user_id };
  if (account.platform === "youtube") return { action: "get_youtube_comments" };
  return null;
}

// comment-manager returns Meta listings as { data: [posts] } and YouTube as
// { videos: [...] }. post_id and limit have no upstream equivalent, so they are
// applied here to whichever list the payload carries; an error payload (a 200
// with error / error_type) carries neither list and passes through untouched.
function trimCommentListing(body: unknown, postId: string, limit: number): unknown {
  const record = asRecord(body);
  for (const key of ["data", "videos"]) {
    const list = record[key];
    if (Array.isArray(list)) {
      const matching = postId ? list.filter((item) => asRecord(item).id === postId) : list;
      return { ...record, [key]: matching.slice(0, limit) };
    }
  }
  return body;
}

export async function handleListComments(deps: ServiceProxyDeps, userId: string, params: URLSearchParams): Promise<ProxyResult> {
  const owned = await loadOwnedAccount(deps, userId, params.get("social_account_id"));
  if ("error" in owned) return owned.error;
  const { account } = owned;
  const limit = parseCommentLimit(params.get("limit"));
  if (limit === null) return proxyError(400, "INVALID_LIMIT", `limit must be a whole number from 1 to ${MAX_COMMENT_POSTS}`);
  const request = commentRequestFor(account);
  if (!request) return unsupported("Listing comments", account.platform, "facebook, instagram, youtube");
  if (account.platform !== "youtube" && !account.platform_user_id) {
    return proxyError(409, "ACCOUNT_INCOMPLETE", "This account has no platform id. Reconnect it in Postora.");
  }
  const upstream = await deps.invoke("comment-manager", { ...request, user_id: userId, social_account_id: account.id }, READ_TIMEOUT_MS);
  const result = fromUpstream("comment-manager", upstream);
  if (result.status !== 200) return result;
  return { status: 200, body: trimCommentListing(result.body, textField(params.get("post_id")), limit) };
}

export async function handleListMessages(deps: ServiceProxyDeps, userId: string, params: URLSearchParams): Promise<ProxyResult> {
  const owned = await loadOwnedAccount(deps, userId, params.get("social_account_id"));
  if ("error" in owned) return owned.error;
  const { account } = owned;
  if (account.platform !== "facebook" && account.platform !== "instagram") {
    return unsupported("Listing messages", account.platform, "facebook, instagram");
  }
  const conversationId = textField(params.get("conversation_id"));
  if (conversationId && !CONVERSATION_ID_RE.test(conversationId)) {
    return proxyError(400, "INVALID_CONVERSATION_ID", "conversation_id must be a conversation id from a previous list_messages call");
  }
  const body: Record<string, unknown> = conversationId
    ? { action: "get_messages", conversation_id: conversationId }
    : { action: "list_conversations" };
  const upstream = await deps.invoke("messaging-api", { ...body, user_id: userId, social_account_id: account.id }, READ_TIMEOUT_MS);
  return fromUpstream("messaging-api", upstream);
}

export async function handleGetPostAnalytics(deps: ServiceProxyDeps, userId: string, params: URLSearchParams): Promise<ProxyResult> {
  const version = params.get("analyticsContractVersion");
  if (version !== null && version !== "1") {
    return proxyError(400, "UNSUPPORTED_CONTRACT_VERSION", "Unsupported analytics contract version.");
  }
  const cursor = params.get("cursor");
  if (cursor !== null && (version === null || !cursor || cursor.length > 16384)) {
    return proxyError(400, "INVALID_CURSOR", "A bounded continuation requires analyticsContractVersion: 1.");
  }
  const owned = await loadOwnedAccount(deps, userId, params.get("social_account_id"), { savedHistory: version === "1" });
  if ("error" in owned) return owned.error;
  const { account } = owned;
  if (version !== null && !["threads", "facebook", "instagram"].includes(account.platform)) {
    return proxyError(400, "UNSUPPORTED_CONTRACT_VERSION", "This platform does not yet support analyticsContractVersion: 1.");
  }
  const rawPeriod = textField(params.get("period_days"));
  const periodDays: AnalyticsPeriod = rawPeriod === "all" ? "all" : rawPeriod ? Number(rawPeriod) : 7;
  const allowedPeriods = account.platform === "instagram" ? INSTAGRAM_PERIODS : THREADS_PERIODS;
  if (!allowedPeriods.includes(periodDays)) {
    return proxyError(400, "INVALID_PERIOD", `period_days must be one of ${allowedPeriods.join(", ")}`);
  }
  if ((account.platform === "facebook" || account.platform === "threads") && version !== null) {
    const upstream = await deps.invoke("meta-owned-analytics-report", { user_id: userId, platform: account.platform, accountId: account.id, periodDays,
      analyticsContractVersion: 1, ...(cursor !== null ? { cursor } : {}) }, READ_TIMEOUT_MS);
    return fromUpstream("meta-owned-analytics-report", upstream);
  }
  if (account.platform === "threads") {
    const upstream = await deps.invoke("threads-insights", { user_id: userId, accountId: account.id, periodDays }, READ_TIMEOUT_MS);
    return fromUpstream("threads-insights", upstream);
  }
  if (account.platform === "tiktok") {
    // tiktok-analytics returns the account's recent videos and has no period.
    const upstream = await deps.invoke("tiktok-analytics", { user_id: userId, social_account_id: account.id }, READ_TIMEOUT_MS);
    return fromUpstream("tiktok-analytics", upstream);
  }
  if (account.platform === "instagram") {
    const upstream = await deps.invoke("instagram-insights-report", { user_id: userId, social_account_id: account.id, period_days: periodDays,
      ...(version !== null ? { analyticsContractVersion: 1 } : {}), ...(cursor !== null ? { cursor } : {}) }, READ_TIMEOUT_MS);
    return fromUpstream("instagram-insights-report", upstream);
  }
  return unsupported("Post analytics", account.platform, "threads, tiktok, instagram");
}

function requireText(input: Record<string, unknown>, field: string, maxLength: number): string | ProxyResult {
  const value = textField(input[field]);
  if (!value) return proxyError(400, "INVALID_REQUEST", `${field} is required`);
  if (value.length > maxLength) return proxyError(400, "INVALID_REQUEST", `${field} must be at most ${maxLength} characters`);
  return value;
}

function optionalText(input: Record<string, unknown>, field: string, maxLength: number): string | undefined | ProxyResult {
  const value = textField(input[field]);
  if (!value) return undefined;
  if (value.length > maxLength) return proxyError(400, "INVALID_REQUEST", `${field} must be at most ${maxLength} characters`);
  return value;
}

function isResult(value: unknown): value is ProxyResult {
  return typeof value === "object" && value !== null && "status" in value && "body" in value;
}

export async function handleGenerateCaption(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const input = asRecord(rawBody);
  const context = requireText(input, "context", 10000);
  if (isResult(context)) return context;
  const platform = requireText(input, "platform", 50);
  if (isResult(platform)) return platform;
  const tone = optionalText(input, "tone", 50);
  if (isResult(tone)) return tone;
  const language = optionalText(input, "language", 20);
  if (isResult(language)) return language;
  const upstream = await deps.invoke("generate-caption", {
    user_id: userId,
    context,
    platform,
    ...(tone ? { tone } : {}),
    ...(language ? { language } : {}),
  }, AI_TEXT_TIMEOUT_MS);
  return fromAiUpstream("generate-caption", upstream);
}

export async function handleGenerateHashtags(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const input = asRecord(rawBody);
  const caption = requireText(input, "caption", 5000);
  if (isResult(caption)) return caption;
  const platform = requireText(input, "platform", 50);
  if (isResult(platform)) return platform;
  const upstream = await deps.invoke("generate-hashtags", { user_id: userId, caption, platform }, AI_TEXT_TIMEOUT_MS);
  return fromAiUpstream("generate-hashtags", upstream);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

// An inline image (a data: URL) must not reach an MCP client, so it is saved
// to the user's media library and only the media_file_id comes back. A daily
// media-quota refusal is not a retryable outage: every retry would pay for
// another generation.
async function storeGeneratedImage(
  deps: ServiceProxyDeps,
  userId: string,
  dataUrl: string,
  description: string | null,
): Promise<ProxyResult> {
  let stored: StoredImage;
  try {
    stored = await deps.storeImage(userId, dataUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    console.error("[n8n-api] service proxy: generated image could not be stored:", detail);
    if (isMediaQuotaMessage(detail)) {
      return proxyError(429, MEDIA_QUOTA_CODE, `The image was generated but your media library is full for today: ${detail}`);
    }
    const safe = detail && !containsSensitiveInfo(detail) ? `: ${detail}` : "";
    return proxyError(502, "IMAGE_STORE_FAILED", `The image was generated but could not be saved to your media library${safe}`);
  }
  const url = typeof stored.file_path === "string" && isHttpUrl(stored.file_path) ? stored.file_path : null;
  return { status: 201, body: { success: true, media_file_id: stored.id, url, description } };
}

// generate-image answers with { imageUrl, description }. Most providers return
// the image inline as a data: URL of several megabytes, which must never reach
// an MCP client, so it is saved to the user's media library and only the
// media_file_id (usable in create_post) goes back. A provider that already
// hosts the image returns an http(s) URL, which is passed on as is.
export async function handleGenerateImage(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const input = asRecord(rawBody);
  const prompt = requireText(input, "prompt", 5000);
  if (isResult(prompt)) return prompt;
  const aspectRatio = optionalText(input, "aspect_ratio", 20);
  if (isResult(aspectRatio)) return aspectRatio;
  const quality = optionalText(input, "quality", 20);
  if (isResult(quality)) return quality;
  // Checked before the billed generation: an image that cannot be stored is
  // paid for and then thrown away.
  const blocked = await deps.mediaQuotaBlocked(userId);
  if (blocked) return proxyError(429, MEDIA_QUOTA_CODE, mediaQuotaBody(blocked.limit).error);
  const upstream = await deps.invoke("generate-image", {
    user_id: userId,
    prompt,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(quality ? { quality } : {}),
  }, AI_IMAGE_TIMEOUT_MS);
  const result = fromAiUpstream("generate-image", upstream);
  if (result.status !== 200) return result;
  const body = asRecord(result.body);
  // generate-image reports its own failures as a 200 with success: false.
  if (body.success === false) {
    const message = textField(body.message) || "Image generation failed";
    return proxyError(422, "IMAGE_GENERATION_FAILED", containsSensitiveInfo(message) ? "Image generation failed" : message);
  }
  const imageUrl = textField(body.imageUrl);
  const description = textField(body.description) || null;
  if (isHttpUrl(imageUrl)) return { status: 200, body: { success: true, image_url: imageUrl, description } };
  if (!imageUrl.startsWith("data:")) {
    return proxyError(502, "UPSTREAM_ERROR", "Image generation returned no image. Please retry shortly.");
  }
  return await storeGeneratedImage(deps, userId, imageUrl, description);
}

/** Production `invoke`: POSTs to /functions/v1/<name> with the service role and an explicit timeout. */
export function createFunctionInvoker(
  functionsBaseUrl: string,
  serviceRoleKey: string,
  fetchFn: typeof fetch = fetch,
): ServiceProxyDeps["invoke"] {
  return async (functionName, body, timeoutMs) => {
    try {
      const res = await fetchFn(`${functionsBaseUrl}/${functionName}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Reading the body is inside the same try, so a body that times out
      // becomes 504 and one that is not JSON becomes 502, never a 200 with null.
      return { status: res.status, data: await res.json() };
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      console.error(`[n8n-api] service proxy: ${functionName} ${timedOut ? "timed out" : "unreachable"}`);
      return { status: timedOut ? 504 : 502, data: null };
    }
  };
}

export interface AccountQueryClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        abortSignal(signal: AbortSignal): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
      };
    };
  };
}

/** Production `loadAccount` over the service-role client. */
export function supabaseAccountLoader(supabase: AccountQueryClient): ServiceProxyDeps["loadAccount"] {
  return async (accountId, signal = AbortSignal.timeout(READ_TIMEOUT_MS)) => {
    const { data, error } = await awaitWithAbort(() => supabase
      .from("social_accounts")
      .select("id, user_id, platform, platform_user_id, is_active")
      .eq("id", accountId)
      .abortSignal(signal)
      .maybeSingle(), signal);
    if (error) {
      console.error("[n8n-api] service proxy: social account lookup failed");
      return { account: null, failed: true };
    }
    return { account: (data as ProxyAccount | null) ?? null, failed: false };
  };
}


function invalidAnalyticsInput(message: string): ProxyResult {
  console.warn("[n8n-api] analytics request refused: invalid_request");
  return proxyError(400, "INVALID_REQUEST", message);
}

/** Bound all analytics dependencies under one request deadline, including clients that ignore abort. */
function analyticsDeadlineDeps(deps: ServiceProxyDeps): ServiceProxyDeps {
  const deadline = Date.now() + READ_TIMEOUT_MS;
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  return { ...deps,
    loadAccount: (id) => awaitWithAbort(() => deps.loadAccount(id, signal), signal),
    invoke: (name, body, timeout) => awaitWithAbort(() => deps.invoke(name, body, Math.max(1, Math.min(timeout, deadline - Date.now()))), signal),
  };
}

/** Both analytics routes use one timeout projection, including aborted DB reads. */
async function analyticsResult(work: () => Promise<ProxyResult>): Promise<ProxyResult> {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof Error) || !["AbortError", "TimeoutError"].includes(error.name)) throw error;
    console.warn("[n8n-api] analytics request deadline expired");
    return fromUpstream("analytics", { status: 504, data: null });
  }
}
export function handleGetAccountAnalytics(deps: ServiceProxyDeps, userId: string, params: URLSearchParams): Promise<ProxyResult> {
  return analyticsResult(() => getAccountAnalytics(deps, userId, params));
}
export function handleTriggerAnalyticsSync(deps: ServiceProxyDeps, userId: string, body: unknown): Promise<ProxyResult> {
  return analyticsResult(() => triggerAnalyticsSync(deps, userId, body));
}

/** Dedicated report route selects each platform's supported contract without changing legacy analytics. */
async function getAccountAnalytics(deps: ServiceProxyDeps, userId: string, params: URLSearchParams): Promise<ProxyResult> {
  deps = analyticsDeadlineDeps(deps);
  const input = Object.fromEntries(params);
  const rawPeriod = params.get("period_days");
  const parsed = accountAnalyticsSchema.safeParse({ ...input,
    ...(rawPeriod !== null && rawPeriod !== "all" ? { period_days: Number(rawPeriod) } : {}) });
  if (!parsed.success) return invalidAnalyticsInput("Invalid account report arguments: check account UUID, period_days, media_type and cursor.");
  const owned = await loadOwnedAccount(deps, userId, parsed.data.social_account_id, { savedHistory: true });
  if ("error" in owned) return owned.error;
  const { account } = owned;
  const mediaType = parsed.data.media_type ?? "all";
  // The persisted Meta contract has no media format evidence. Refuse rather than guess formats or hide posts.
  if (["facebook", "threads"].includes(account.platform) && mediaType !== "all") {
    return invalidAnalyticsInput("media_type filtering is unavailable for Facebook/Threads saved reports because they do not record media formats.");
  }
  const reportParams = new URLSearchParams(params);
  reportParams.delete("media_type");
  if (["facebook", "threads"].includes(account.platform)) reportParams.set("analyticsContractVersion", "1");
  // Instagram's legacy report supports its own cursor, without the unified version flag.
  if (account.platform === "instagram") {
    const period = parsed.data.period_days ?? 7;
    const upstream = await deps.invoke("instagram-insights-report", { user_id: userId, social_account_id: account.id,
      period_days: period, ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}) }, READ_TIMEOUT_MS);
    const result = fromUpstream("instagram-insights-report", upstream);
    return result.status === 200 ? { ...result, body: filterAccountMedia(result.body, mediaType) } : result;
  }
  // Keep the existing TikTok passthrough and its validation unchanged.
  return await handleGetPostAnalytics(deps, userId, reportParams);
}

async function triggerAnalyticsSync(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  deps = analyticsDeadlineDeps(deps);
  const parsed = analyticsSyncSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("social_account_id must be a Postora account UUID.");
  const owned = await loadOwnedAccount(deps, userId, parsed.data.social_account_id);
  if ("error" in owned) return owned.error;
  const { account } = owned;
  if (!["instagram", "facebook", "threads"].includes(account.platform)) return unsupported("Analytics collection", account.platform, "instagram, facebook, threads");
  const name = account.platform === "instagram" ? "instagram-insights-sync" : "meta-owned-analytics-sync";
  const body = account.platform === "instagram"
    ? { action: "enqueue", user_id: userId, social_account_id: account.id }
    : { action: "enqueue", user_id: userId, platform: account.platform, accountId: account.id };
  const upstream = await deps.invoke(name, body, READ_TIMEOUT_MS);
  const receipt = analyticsSyncReceipt(upstream.status, upstream.data);
  const result = fromUpstream(name, upstream);
  // Preserve old successful job fields. Refusals expose a bounded public receipt;
  // old free-form messages could contain incorrect reconnect advice.
  const upstreamBody = asRecord(upstream.data);
  const payload = receipt.accepted ? asRecord(result.body) : {
    ...(["collection_disabled", "collection_not_eligible", "settings_unavailable"].includes(String(upstreamBody.error)) ? { error: upstreamBody.error } : {}),
    ...(Number.isSafeInteger(upstreamBody.retry_after_seconds) && Number(upstreamBody.retry_after_seconds) >= 0 ? { retry_after_seconds: upstreamBody.retry_after_seconds } : {}),
    ...(typeof upstreamBody.job_id === "string" && isValidUuid(upstreamBody.job_id) ? { job_id: upstreamBody.job_id } : {}),
  };
  return { status: upstream.status >= 500 && !["collection_disabled", "settings_unavailable", "audit_unavailable"].includes(receipt.reason_code)
    ? result.status : upstream.status, body: { ...payload, ...receipt } };
}

async function competitorRpc(deps: ServiceProxyDeps, name: string, args: Record<string, unknown>): Promise<ProxyResult> {
  if (!deps.rpc) return proxyError(503, "COMPETITOR_UNAVAILABLE", "Competitor tracking is unavailable.");
  const result = await deps.rpc(name, args);
  if (result.error) {
    console.warn("[n8n-api] competitor request refused", { code: result.error.code });
    const code = result.error.code;
    if (code === "P0002") return proxyError(404, "COMPETITOR_NOT_FOUND", "Competitor not found or not owned by the authenticated user.");
    if (code === "23514" && result.error.message?.startsWith("COMPETITOR_QUOTA_EXCEEDED")) return proxyError(409, "COMPETITOR_QUOTA_EXCEEDED", "The tracked competitor limit has been reached.");
    if (code === "23514" && result.error.message?.startsWith("COMPETITOR_ADD_FAILED")) return proxyError(409, "COMPETITOR_ADD_CONFLICT", "The competitor changed concurrently; retry the request.");
    if (code === "23514" || code === "22023") return invalidAnalyticsInput("Invalid competitor handle, label or report arguments.");
    return proxyError(503, "COMPETITOR_UNAVAILABLE", "Competitor tracking is unavailable.");
  }
  if (result.data === null) return proxyError(503, "COMPETITOR_UNAVAILABLE", "Competitor tracking returned no result.");
  return { status: 200, body: stripCredentialUrls(result.data) };
}

async function competitorReport(deps: ServiceProxyDeps, userId: string, request: import("../competitor-tracking-report/contracts.ts").CompetitorReportRequest): Promise<ProxyResult> {
  // The store keeps the same strict projection validator as the UI report. Its bearer is unused by this explicit-owner adapter.
  let refusal: ProxyResult | undefined;
  const store = new CompetitorReportStore(async (_name, args) => {
    const result = await competitorRpc(deps, "read_competitor_tracking_report_v2_for_user", { p_user_id: userId, ...args });
    if (result.status !== 200) { refusal = result; return { data: null, error: { code: "unavailable" } }; }
    return { data: result.body, error: null };
  });
  try {
    const raw = await store.readReportInput(request, "");
    const report = assembleCompetitorReport({ action: request.action, request, raw }, new Date(), COMPETITOR_REPORT_BASELINE_POLICY);
    return { status: 200, body: stripCredentialUrls(report) };
  } catch {
    console.warn("[n8n-api] competitor report unavailable");
    return refusal ?? proxyError(503, "COMPETITOR_UNAVAILABLE", "The competitor report could not be read.");
  }
}

export async function handleListCompetitors(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const parsed = listCompetitorsSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("Use state active/removed, limit 1-50 and a bounded report cursor.");
  return competitorReport(deps, userId, { action: "list", state: parsed.data.state ?? "active", limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor ?? null });
}

export async function handleTrackCompetitor(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const parsed = trackCompetitorSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("Use an Instagram handle of 1-30 letters, digits, underscores or periods (no consecutive periods), and a label of at most 120 characters.");
  return competitorRpc(deps, "add_competitor_watchlist_for_user", { p_user_id: userId, p_username: normalizeTrackedHandle(parsed.data.username), p_label: parsed.data.label ?? null });
}

export async function handleUntrackCompetitor(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const parsed = untrackCompetitorSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("watchlist_id must be a UUID from list_competitors.");
  return competitorRpc(deps, "update_competitor_watchlist_for_user", { p_user_id: userId, p_watchlist_id: parsed.data.watchlist_id, p_label: null, p_is_active: false });
}

export async function handleGetCompetitorReport(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const parsed = competitorReportSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("Use a watchlist UUID, period_days 7/30, limit 1-50 and a bounded report cursor.");
  return competitorReport(deps, userId, { action: "detail", watchlistId: parsed.data.watchlist_id,
    periodDays: parsed.data.period_days ?? 30, limit: parsed.data.limit ?? 20, cursor: parsed.data.cursor ?? null });
}

export async function handleAnalyzeBrand(deps: ServiceProxyDeps, userId: string, rawBody: unknown): Promise<ProxyResult> {
  const parsed = analyzeBrandSchema.safeParse(rawBody);
  if (!parsed.success) return invalidAnalyticsInput("Invalid brand analysis filters; platform must be facebook or instagram.");
  if (parsed.data.platform === "instagram" && (parsed.data.offset ?? 0) > 100) return invalidAnalyticsInput("Instagram offset must be between 0 and 100.");
  const username = normalizeBrandHandle(parsed.data.handle, parsed.data.platform);
  if (!username) return invalidAnalyticsInput("Use a valid handle or a profile URL on the selected platform.");
  const upstream = await deps.invoke("brand-scrape", { user_id: userId, platform: parsed.data.platform, username, offset: parsed.data.offset ?? 0 }, READ_TIMEOUT_MS);
  const result = fromUpstream("brand-scrape", upstream);
  return result.status === 200 ? { ...result, body: filterBrandPosts(result.body, parsed.data) } : result;
}
