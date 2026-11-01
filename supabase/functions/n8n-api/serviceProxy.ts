// Service-role proxy routes behind the MCP tools list_comments, list_messages,
// get_post_analytics, generate_caption, generate_hashtags and generate_image.
// The target functions accept a user JWT or a service-role call carrying
// user_id (_shared/auth-helper.ts serviceRoleCallerUserId). n8n-api has already
// resolved userId from the API key; this module checks that the account
// belongs to that user and only then calls the function with the service role
// and that user_id. The functions apply their own plan checks and AI rate
// limits to the user_id they receive. Every dependency is injected so the tests
// run against fakes.

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
  loadAccount(accountId: string): Promise<{ account: ProxyAccount | null; failed: boolean }>;
  invoke(functionName: string, body: Record<string, unknown>, timeoutMs: number): Promise<InvokeResult>;
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
const THREADS_PERIODS = [7, 14, 30, 90];

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

async function loadOwnedAccount(deps: ServiceProxyDeps, userId: string, rawAccountId: unknown): Promise<Owned> {
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
  // An inactive (disconnected) account would make threads-insights fall back to
  // a different Threads account, so the proxy never forwards one.
  if (account.is_active === false) {
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
  if (typeof value === "string") return /access_token=/i.test(value) ? null : value;
  if (Array.isArray(value)) return value.map(stripCredentialUrls);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
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
  const owned = await loadOwnedAccount(deps, userId, params.get("social_account_id"));
  if ("error" in owned) return owned.error;
  const { account } = owned;
  if (version !== null && !["threads", "facebook"].includes(account.platform)) {
    return proxyError(400, "UNSUPPORTED_CONTRACT_VERSION", "This platform does not yet support analyticsContractVersion: 1.");
  }
  const rawPeriod = textField(params.get("period_days"));
  const periodDays = rawPeriod ? Number(rawPeriod) : 7;
  if (!THREADS_PERIODS.includes(periodDays)) {
    return proxyError(400, "INVALID_PERIOD", `period_days must be one of ${THREADS_PERIODS.join(", ")}`);
  }
  if (account.platform === "threads") {
    const upstream = await deps.invoke("threads-insights", { user_id: userId, accountId: account.id, periodDays,
      ...(version !== null ? { analyticsContractVersion: 1 } : {}), ...(cursor !== null ? { cursor } : {}) }, READ_TIMEOUT_MS);
    return fromUpstream("threads-insights", upstream);
  }
  if (account.platform === "facebook" && version !== null) {
    const upstream = await deps.invoke("facebook-page-insights", { user_id: userId, accountId: account.id, periodDays,
      analyticsContractVersion: 1, ...(cursor !== null ? { cursor } : {}) }, READ_TIMEOUT_MS);
    return fromUpstream("facebook-page-insights", upstream);
  }
  if (account.platform === "tiktok") {
    // tiktok-analytics returns the account's recent videos and has no period.
    const upstream = await deps.invoke("tiktok-analytics", { user_id: userId, social_account_id: account.id }, READ_TIMEOUT_MS);
    return fromUpstream("tiktok-analytics", upstream);
  }
  if (account.platform === "instagram") {
    const upstream = await deps.invoke("instagram-insights-report", { user_id: userId, social_account_id: account.id, period_days: periodDays }, READ_TIMEOUT_MS);
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
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/** Production `loadAccount` over the service-role client. */
export function supabaseAccountLoader(supabase: AccountQueryClient): ServiceProxyDeps["loadAccount"] {
  return async (accountId) => {
    const { data, error } = await supabase
      .from("social_accounts")
      .select("id, user_id, platform, platform_user_id, is_active")
      .eq("id", accountId)
      .maybeSingle();
    if (error) {
      console.error("[n8n-api] service proxy: social account lookup failed");
      return { account: null, failed: true };
    }
    return { account: (data as ProxyAccount | null) ?? null, failed: false };
  };
}
