// Live provider reads. The door logs all outcomes through withPartnerAuth.
// Signed references prove that a provider object was seen on a bound account's
// feed. Raw provider ids (including caller-supplied post ids) are never authority.
import type { CommentActionAccount } from "./commentActions.ts";
import { isDirectInstagramAccount } from "./messengerCredentials.ts";
import { youtubeCommentCapability } from "./youtubeCommentCapability.ts";
import { composioClientFromEnv } from "./composioClient.ts";
import { getYouTubeComment, listThreads, listYouTubeRepliesPage, type YouTubeCommentsDeps } from "./youtubeComments.ts";
import { decodeId } from "../partner-api/v1/ids.ts";
import { encodeCursor, readPageRequest } from "../partner-api/v1/pagination.ts";
import type { V1ErrorCode } from "../partner-api/v1/errors.ts";

export interface CommentContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  accountIds: string[];
  requestId: string;
  entitledPlatforms?: readonly string[];
}
export interface CommentDeps {
  fetcher?: typeof fetch;
  signingSecret?: string;
  youtube?: YouTubeCommentsDeps;
}
type Account = CommentActionAccount & { id: string; workspace_id: string; platform_user_id: string; is_active: boolean; needs_reauth?: boolean };
type Target = { workspace: string; account: string; identity: string; platform: string; post: string; comment: string };
export interface CommentResource {
  id: string;
  account_id: string;
  platform: string;
  platform_comment_id: string;
  platform_post_id: string;
  text: string;
  created_at: string | null;
  parent_comment_id: string | null;
  author_name: string | null;
  hidden: boolean | null;
}
export class CommentOpError extends Error {
  constructor(public code: V1ErrorCode) { super(code); }
}
const ACCOUNT_COLUMNS = "id,workspace_id,platform,platform_user_id,access_token,refresh_token,token_expires_at,auth_provider,connection_id,ig_auth_type,account_metadata,is_active,needs_reauth";
export const COMMENT_PLATFORMS = ["facebook", "instagram", "youtube"];
const bytes = new TextEncoder();
function pack(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function unpack(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
async function signingKey(deps: CommentDeps): Promise<CryptoKey> {
  const secret = deps.signingSecret ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new CommentOpError("internal_error");
  return await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function seal(prefix: string, value: unknown, deps: CommentDeps): Promise<string> {
  const payload = pack(bytes.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(deps), bytes.encode(`${prefix}.${payload}`));
  return `${prefix}.${payload}.${pack(new Uint8Array(signature))}`;
}
async function unseal<T>(prefix: string, token: string, deps: CommentDeps): Promise<T | null> {
  const key = await signingKey(deps);
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== prefix || token.length > 16000) return null;
    if (!await crypto.subtle.verify("HMAC", key, unpack(parts[2]), bytes.encode(`${prefix}.${parts[1]}`))) return null;
    return JSON.parse(new TextDecoder().decode(unpack(parts[1]))) as T;
  } catch { return null; } // Untrusted token syntax/signature, never a provider read.
}
export function requireCommentCapability(account: Account, action: string): void {
  if (!COMMENT_PLATFORMS.includes(account.platform) || (action === "delete_comment" && account.platform === "youtube")) {
    throw new CommentOpError("unsupported_capability");
  }
  if (!account.is_active) throw new CommentOpError("account_not_connected");
  if (account.needs_reauth || (account.platform === "youtube" && youtubeCommentCapability(account) !== "capable")) {
    throw new CommentOpError("account_needs_reauth");
  }
  if (account.auth_provider !== "composio" && !account.access_token) throw new CommentOpError("account_needs_reauth");
}
async function accounts(ctx: CommentContext): Promise<Account[]> {
  if (!ctx.accountIds.length) return [];
  const { data, error } = await ctx.admin.from("social_accounts").select(ACCOUNT_COLUMNS)
    .eq("workspace_id", ctx.workspaceId).in("id", ctx.accountIds).order("id", { ascending: true });
  if (error) throw new CommentOpError("internal_error");
  return data ?? [];
}
export async function resolveComment(ctx: CommentContext, id: string, deps: CommentDeps = {}) {
  const target = await unseal<Target>("cmt", id, deps);
  if (!target || target.workspace !== ctx.workspaceId || !ctx.accountIds.includes(target.account)) throw new CommentOpError("resource_not_found");
  const account = (await accounts({ ...ctx, accountIds: [target.account] }))[0];
  if (!account || account.platform !== target.platform || account.platform_user_id !== target.identity) throw new CommentOpError("resource_not_found");
  return { account, target };
}
export function youtubeDeps(ctx: CommentContext, deps: CommentDeps): YouTubeCommentsDeps {
  return deps.youtube ?? { admin: ctx.admin, fetcher: deps.fetcher, composio: composioClientFromEnv() };
}
function graphBase(account: Account): string {
  return `https://${isDirectInstagramAccount(account) ? "graph.instagram.com" : "graph.facebook.com"}/v22.0`;
}
// deno-lint-ignore no-explicit-any
async function graphRead(account: Account, path: string, query: Record<string, string>, deps: CommentDeps): Promise<any> {
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(`${graphBase(account)}/${path}?${new URLSearchParams({ ...query, access_token: account.access_token! })}`, { signal: AbortSignal.timeout(15000) });
  } catch { throw new CommentOpError("meta_error"); }
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || value.error) throw new CommentOpError("meta_error");
  return value;
}
function fields(account: Account): string {
  return account.platform === "facebook" ? "id,from{id,name},message,created_time,is_hidden,parent" : "id,from{id,username},text,timestamp,hidden,username";
}
// deno-lint-ignore no-explicit-any
async function present(ctx: CommentContext, account: Account, post: string, row: any, deps: CommentDeps): Promise<CommentResource> {
  if (typeof row.id !== "string" || !row.id) throw new CommentOpError("meta_error");
  const target: Target = { workspace: ctx.workspaceId, account: account.id, identity: account.platform_user_id, platform: account.platform, post, comment: row.id };
  return {
    id: await seal("cmt", target, deps), account_id: account.id, platform: account.platform,
    platform_comment_id: row.id, platform_post_id: post,
    text: row.message ?? row.text ?? "", created_at: row.created_time ?? row.timestamp ?? row.publishedAt ?? null,
    parent_comment_id: row.parent?.id ?? row.parentId ?? null,
    author_name: row.from?.name ?? row.from?.username ?? row.username ?? row.authorName ?? null,
    hidden: row.is_hidden ?? row.hidden ?? (row.moderationStatus ? row.moderationStatus === "rejected" : null),
  };
}
export async function getComment(ctx: CommentContext, id: string, deps: CommentDeps = {}, resolved?: Awaited<ReturnType<typeof resolveComment>>): Promise<CommentResource> {
  const { account, target } = resolved ?? await resolveComment(ctx, id, deps);
  requireCommentCapability(account, "get_comment");
  if (account.platform === "youtube") {
    const result = await getYouTubeComment(account, youtubeDeps(ctx, deps), target.comment);
    if (!result.ok) throw new CommentOpError(result.kind === "not_found" ? "resource_not_found" : "meta_error");
    return await present(ctx, account, target.post, result.value, deps);
  }
  return await present(ctx, account, target.post, await graphRead(account, encodeURIComponent(target.comment), { fields: fields(account) }, deps), deps);
}

interface Continuation {
  workspace: string; filter: string; account: string;
  post?: string; feedAfter?: string; after?: string;
  parents?: Array<{ id: string; post: string }>;
  replyAfter?: string;
  checkpoint: string;
}
interface Filters { platform?: string; postId?: string; accountId?: string }
async function selectedPosts(ctx: CommentContext, postId: string): Promise<Map<string, string>> {
  const id = decodeId("post", postId);
  if (!id) throw new CommentOpError("resource_not_found");
  const { data: binding, error: bindingError } = await ctx.admin.from("partner_api_posts")
    .select("post_id").eq("post_id", id).eq("workspace_id", ctx.workspaceId).maybeSingle();
  if (bindingError) throw new CommentOpError("internal_error");
  if (!binding) throw new CommentOpError("resource_not_found");
  const { data, error } = await ctx.admin.from("platform_posts")
    .select("social_account_id,platform_post_id,social_accounts!inner(workspace_id)")
    .eq("post_id", id).eq("social_accounts.workspace_id", ctx.workspaceId).in("social_account_id", ctx.accountIds);
  if (error) throw new CommentOpError("internal_error");
  if (!data?.length) throw new CommentOpError("resource_not_found");
  return new Map(data.filter((row: { platform_post_id: string | null }) => row.platform_post_id)
    .map((row: { social_account_id: string; platform_post_id: string }) => [row.social_account_id, row.platform_post_id]));
}
function nextAfter(value: { data?: unknown; paging?: { next?: string; cursors?: { after?: string } } }): string | undefined {
  if (!Array.isArray(value.data)) throw new CommentOpError("meta_error");
  if (!value.paging?.next) return undefined;
  if (!value.paging.cursors?.after) throw new CommentOpError("meta_error");
  // Never follow provider-supplied URLs (nor put access tokens in cursors).
  return value.paging.cursors.after;
}
export async function listComments(ctx: CommentContext, req: Request, filters: Filters, deps: CommentDeps = {}) {
  if (filters.platform && !COMMENT_PLATFORMS.includes(filters.platform)) throw new CommentOpError("unsupported_capability");
  if (filters.accountId && !ctx.accountIds.includes(filters.accountId)) throw new CommentOpError("resource_not_found");
  const filter = JSON.stringify(filters);
  const url = new URL(req.url);
  const rawCursor = url.searchParams.get("cursor");
  const continuation = rawCursor ? await unseal<Continuation>("cpage", rawCursor, deps) : null;
  if (rawCursor && (!continuation || continuation.workspace !== ctx.workspaceId || continuation.filter !== filter)) throw new CommentOpError("invalid_request");
  // readPageRequest validates the common limit and encoded checkpoint. Provider
  // continuation lives alongside it; it is not a fabricated local keyset.
  if (continuation) url.searchParams.set("cursor", continuation.checkpoint);
  else url.searchParams.delete("cursor");
  const page = readPageRequest(new Request(url), ctx.requestId);
  if (!page.ok) throw new CommentOpError("invalid_request");
  const scoped = filters.accountId ? { ...ctx, accountIds: [filters.accountId] } : ctx;
  const posts = filters.postId ? await selectedPosts(scoped, filters.postId) : null;
  const scopedCandidates = (await accounts(scoped)).filter((a) => COMMENT_PLATFORMS.includes(a.platform) && (!filters.platform || a.platform === filters.platform) && (!posts || posts.has(a.id)));
  const candidates = scopedCandidates.filter((a) => !ctx.entitledPlatforms || ctx.entitledPlatforms.includes(a.platform));
  if (scopedCandidates.length && !candidates.length) throw new CommentOpError("feature_not_entitled");
  const index = continuation ? candidates.findIndex((a) => a.id === continuation.account) : 0;
  if (continuation && index < 0) throw new CommentOpError("resource_not_found");
  if (!candidates.length) return { data: [], next_cursor: null };
  const account = candidates[index];
  requireCommentCapability(account, "list_comments");
  let state: Partial<Continuation> = continuation ?? {};
  let post = posts?.get(account.id) ?? state.post;
  let rows: CommentResource[] = [];
  let after: string | undefined;
  let parents = state.parents ?? [];
  let replyAfter: string | undefined;
  if (parents.length) {
    const parent = parents[0];
    if (account.platform === "youtube") {
      const result = await listYouTubeRepliesPage(account, youtubeDeps(ctx, deps), {
        parentId: parent.id, maxResults: Math.min(page.page.limit, account.auth_provider === "composio" ? 20 : 100), pageToken: state.replyAfter,
      });
      if (!result.ok) throw new CommentOpError("meta_error");
      rows = await Promise.all(result.value.items.map((row) => present(ctx, account, parent.post, row, deps)));
      replyAfter = result.value.nextPageToken ?? undefined;
    } else {
      const result = await graphRead(account, `${encodeURIComponent(parent.id)}/replies`, {
        fields: fields(account), limit: String(page.page.limit), ...(state.replyAfter ? { after: state.replyAfter } : {}),
      }, deps);
      replyAfter = nextAfter(result);
      rows = await Promise.all(result.data.map((row: Record<string, unknown>) => present(ctx, account, parent.post, { ...row, parentId: parent.id }, deps)));
    }
    if (!replyAfter) parents = parents.slice(1);
    after = state.after;
  } else if (account.platform === "youtube") {
    const result = await listThreads(account, youtubeDeps(ctx, deps), {
      ...(post ? { videoId: post } : { channelId: account.platform_user_id }),
      pageToken: state.after, maxResults: Math.min(page.page.limit, account.auth_provider === "composio" ? 20 : 100),
    });
    if (!result.ok) throw new CommentOpError("meta_error");
    rows = await Promise.all(result.value.items.map((row) => {
      const raw = row.raw as { snippet?: { topLevelComment?: { id?: string } } };
      // A thread id is not the comment id accepted by comments.insert/list.
      return present(ctx, account, row.videoId, { ...row, id: raw?.snippet?.topLevelComment?.id }, deps);
    }));
    after = result.value.nextPageToken ?? undefined;
    parents = rows.filter((_row, i) => result.value.items[i].totalReplyCount > 0)
      .map((row) => ({ id: row.platform_comment_id, post: row.platform_post_id }));
  } else {
    if (!post) {
      const feed = await graphRead(account, `${encodeURIComponent(account.platform_user_id)}/${account.platform === "facebook" ? "feed" : "media"}`, { fields: "id", limit: "1", ...(state.feedAfter ? { after: state.feedAfter } : {}) }, deps);
      const feedAfter = nextAfter(feed);
      post = feed.data[0]?.id;
      state = { ...state, feedAfter };
      if (feed.data.length > 1 || (post !== undefined && typeof post !== "string")) throw new CommentOpError("meta_error");
    }
    if (post) {
      const comments = await graphRead(account, `${encodeURIComponent(post)}/comments`, {
        fields: fields(account), limit: String(page.page.limit), ...(account.platform === "facebook" ? { filter: "stream" } : {}), ...(state.after ? { after: state.after } : {}),
      }, deps);
      after = nextAfter(comments);
      rows = await Promise.all(comments.data.map((row: unknown) => present(ctx, account, post!, row, deps)));
      if (account.platform === "instagram") parents = rows.map((row) => ({ id: row.platform_comment_id, post: row.platform_post_id }));
    }
  }
  const checkpoint = encodeCursor({ timestamp: new Date().toISOString(), id: account.id });
  let next: Continuation | null = null;
  const base = { workspace: ctx.workspaceId, filter, checkpoint, account: account.id };
  if (parents.length) next = { ...base, post, feedAfter: state.feedAfter, after, parents, replyAfter };
  else if (after) next = { ...base, post, feedAfter: state.feedAfter, after };
  else if (!posts && state.feedAfter) next = { ...base, feedAfter: state.feedAfter };
  else if (candidates[index + 1]) next = { ...base, account: candidates[index + 1].id };
  return { data: rows, next_cursor: next ? await seal("cpage", next, deps) : null };
}
