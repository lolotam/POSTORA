// The Stage 4 handler.
//
// `index.ts` only routes: when `action` is in the Stage 4 set it hands the
// already-authenticated caller to this module BEFORE the legacy account
// lookup. The handler is built from injected ports so it is testable
// without Supabase.

import { z } from "https://esm.sh/zod@3.25.76";
import {
  STAGE4_ACTIONS,
  type Stage4Action,
  type Stage4ModerationStatus,
  type Stage4Reason,
  type Stage4Request,
  stage4RequestSchema,
  STAGE4_ACTION_CAPABILITY,
  STAGE4_ACTION_REQUIRES_HELD,
  type Stage4VideoRow,
  type Stage4CommentRow,
  type Stage4VideoPagePayload,
  type Stage4ThreadPagePayload,
  type Stage4ReplyPagePayload,
  type Stage4ReceiptPayload,
  type Stage4BanConfirmationPayload,
  type Stage4OperationStatusPayload,
  type Stage4CapabilitiesPayload,
} from "./contracts.ts";
import {
  HANDLE_PREFIX,
  CURSOR_PREFIX,
  BAN_CONFIRMATION_PREFIX,
  sealHandle,
  unsealHandle,
  sealCursor,
  unsealCursor,
  sealBanConfirmation,
  unsealBanConfirmation,
  HANDLE_TTL_MS,
  CURSOR_TTL_MS,
  BAN_CONFIRMATION_TTL_MS,
} from "./sealing.ts";
import { normaliseText, computeIntentDigest, computeLogicalDigests, type DigestKeys } from "./digests.ts";
import * as provider from "./provider.ts";
import type { Stage4ProviderClass } from "./provider.ts";
import { writeRefusalAudit, sanitiseAction } from "./audit.ts";
import { readCapabilities, admitsCapability } from "./rollout.ts";
import { stage4RateLimit, STAGE4_RATE_LIMITS } from "./rateLimit.ts";

export interface Stage4Deps {
  admin: any;
  fetcher: typeof fetch;
  now: () => number;
  newRequestId: () => string;
  auth: (req: Request) => Promise<{ userId: string; isServiceRole: boolean }>;
  signingSecret: string;
}

const cors = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  ...extra,
});

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function refusal(
  deps: Stage4Deps,
  status: number,
  reason: Stage4Reason,
  requestId: string,
  headers: Record<string, string>,
  audit: { action: string; userId: string | null; accountId: string | null; operationId: string | null; providerClass?: string | null },
): Response {
  // Fire and forget the audit; never let it change the response.
  void writeRefusalAudit(deps.admin, {
    action: audit.action,
    reason,
    providerClass: audit.providerClass ?? null,
    requestId,
    userId: audit.userId,
    accountId: audit.accountId,
    operationId: audit.operationId,
  }, { rateLimitBucket: async () => true });
  return json(status, { ok: false, request_id: requestId, reason }, headers);
}

function ok(body: unknown, headers: Record<string, string>): Response {
  return json(200, body, headers);
}

// ---- account read (verified) ---------------------------------------------

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  auth_provider: string | null;
  is_active: boolean;
  needs_reauth: boolean;
  binding_generation: number;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  account_metadata: unknown;
}

async function readAccount(admin: any, accountId: string, userId: string): Promise<AccountRow | null> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("id,user_id,platform,platform_user_id,auth_provider,is_active,needs_reauth,binding_generation,access_token,refresh_token,token_expires_at,account_metadata")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as AccountRow;
}

// ---- token preparation (shared helper) ------------------------------------

async function prepareToken(
  account: AccountRow,
  deps: Stage4Deps,
): Promise<{ ok: true; token: string } | { ok: false; reason: Stage4Reason }> {
  // Reuse the shared helper via a dynamic import to avoid a circular dep.
  const mod = await import("../../_shared/youtubeComments.ts");
  const nativeAccount = {
    id: account.id,
    platform: "youtube" as const,
    auth_provider: "native" as const,
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    token_expires_at: account.token_expires_at,
    platform_user_id: account.platform_user_id,
    needs_reauth: account.needs_reauth,
  };
  const result = await (mod as any).nativeAccessToken(nativeAccount, { admin: deps.admin, fetcher: deps.fetcher }, {});
  if (!result.ok) {
    if (result.kind === "unauthorized") return { ok: false, reason: "account_needs_reauth" };
    return { ok: false, reason: "upstream" };
  }
  return { ok: true, token: result.value.token };
}

// ---- digest keys ----------------------------------------------------------

async function loadDigestKeys(admin: any): Promise<DigestKeys> {
  const { data, error } = await admin.rpc("youtube_comment_digest_keys");
  if (error || !data) throw new Error("digest_keys_unavailable");
  const keys = (data.keys ?? []).map((k: { version: number; key: string }) => ({
    version: k.version,
    key: k.key,
  }));
  return { activeVersion: data.active_version, keys };
}

// ---- handle verification --------------------------------------------------

async function verifyHandle(
  handle: string,
  deps: Stage4Deps,
  expected: { ownerId: string; accountId: string; generation: number; videoId?: string; commentId?: string },
): Promise<{ ok: true; payload: any } | { ok: false; reason: Stage4Reason }> {
  const payload = await unsealHandle(handle, { signingSecret: deps.signingSecret, now: deps.now() });
  if (!payload) return { ok: false, reason: "invalid_handle" };
  if (payload.e < deps.now()) return { ok: false, reason: "expired_handle" };
  if (payload.o !== expected.ownerId) return { ok: false, reason: "cross_context" };
  if (payload.a !== expected.accountId) return { ok: false, reason: "cross_context" };
  if (payload.g !== expected.generation) return { ok: false, reason: "cross_context" };
  if (expected.videoId && payload.vi !== expected.videoId) return { ok: false, reason: "cross_context" };
  if (expected.commentId && payload.co !== expected.commentId) return { ok: false, reason: "cross_context" };
  return { ok: true, payload };
}

// ---- chain validation for a thread row ------------------------------------

interface ChainCheckResult {
  ok: boolean;
  inconsistent: boolean;
  reason?: Stage4Reason;
}

function validateThreadChain(
  videoId: string,
  thread: any,
  accountChannel: string,
  verifiedVideoChannel: string,
): { ok: boolean; inconsistent: boolean } {
  // video verified as owned in this request (caller ensures verifiedVideoChannel === accountChannel)
  if (thread?.snippet?.videoId && thread.snippet.videoId !== videoId) return { ok: false, inconsistent: true };
  if (thread?.snippet?.channelId && thread.snippet.channelId !== accountChannel) return { ok: false, inconsistent: true };
  const top = thread?.snippet?.topLevelComment;
  if (top?.snippet?.parentId) return { ok: false, inconsistent: true };
  if (top?.snippet?.channelId && top.snippet.channelId !== accountChannel) return { ok: false, inconsistent: true };
  if (top?.snippet?.videoId && top.snippet.videoId !== videoId) return { ok: false, inconsistent: true };
  for (const r of thread?.replies?.comments ?? []) {
    if (r?.snippet?.parentId && r.snippet.parentId !== top?.id) return { ok: false, inconsistent: true };
    if (r?.snippet?.channelId && r.snippet.channelId !== accountChannel) return { ok: false, inconsistent: true };
    if (r?.snippet?.videoId && r.snippet.videoId !== videoId) return { ok: false, inconsistent: true };
  }
  return { ok: true, inconsistent: false };
}

// ---- row sealing ----------------------------------------------------------

function sealRow(
  deps: Stage4Deps,
  account: AccountRow,
  videoId: string,
  thread: any,
  kind: "thread" | "reply",
  comment: any,
  observedStatus: string | null,
  canonicalParent: string,
  authorChannel: string | null,
): Promise<string> {
  return sealHandle(
    {
      o: account.user_id,
      a: account.id,
      g: account.binding_generation,
      c: account.platform_user_id,
      vi: videoId,
      th: String(thread?.id ?? ""),
      co: String(comment?.id ?? ""),
      k: kind,
      p: canonicalParent,
      au: authorChannel ?? "",
      s: observedStatus,
    },
    { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: HANDLE_TTL_MS },
  );
}

// ---- parse rows -----------------------------------------------------------

function parseThreadRow(
  thread: any,
  account: AccountRow,
  videoId: string,
): { threadRow: Stage4CommentRow; replyRows: Stage4CommentRow[] } | null {
  const top = thread?.snippet?.topLevelComment;
  const topId = String(top?.id ?? thread?.id ?? "");
  const authorChannel = top?.snippet?.authorChannelId?.value ? String(top.snippet.authorChannelId.value) : null;
  const threadRow: Stage4CommentRow = {
    handle: "", // filled by caller after sealing
    kind: "thread",
    comment_id: topId,
    thread_id: String(thread?.id ?? ""),
    video_id: videoId,
    canonical_parent_id: "",
    author_channel_id: authorChannel,
    author_name: String(top?.snippet?.authorDisplayName ?? "Unknown"),
    author_avatar_url: top?.snippet?.authorProfileImageUrl ?? null,
    text: String(top?.snippet?.textOriginal ?? top?.snippet?.textDisplay ?? ""),
    published_at: String(top?.snippet?.publishedAt ?? new Date().toISOString()),
    like_count: Number(top?.snippet?.likeCount ?? 0),
    moderation_status: top?.snippet?.moderationStatus ? String(top.snippet.moderationStatus) : null,
    is_own: !!account.platform_user_id && authorChannel === account.platform_user_id,
  };
  const replyRows: Stage4CommentRow[] = (Array.isArray(thread?.replies?.comments) ? thread.replies.comments : []).map((r: any) => ({
    handle: "",
    kind: "reply" as const,
    comment_id: String(r?.id ?? ""),
    thread_id: String(thread?.id ?? ""),
    video_id: videoId,
    canonical_parent_id: topId,
    author_channel_id: r?.snippet?.authorChannelId?.value ? String(r.snippet.authorChannelId.value) : null,
    author_name: String(r?.snippet?.authorDisplayName ?? "Unknown"),
    author_avatar_url: r?.snippet?.authorProfileImageUrl ?? null,
    text: String(r?.snippet?.textOriginal ?? r?.snippet?.textDisplay ?? ""),
    published_at: String(r?.snippet?.publishedAt ?? new Date().toISOString()),
    like_count: Number(r?.snippet?.likeCount ?? 0),
    moderation_status: r?.snippet?.moderationStatus ? String(r.snippet.moderationStatus) : null,
    is_own: !!account.platform_user_id && (r?.snippet?.authorChannelId?.value === account.platform_user_id),
  }));
  return { threadRow, replyRows };
}

// ---- the handler ----------------------------------------------------------

export async function handleStage4(
  req: Request,
  deps: Stage4Deps,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const requestId = deps.newRequestId();
  const headers = { ...corsHeaders, "Content-Type": "application/json", "X-Request-Id": requestId };

  // Auth.
  let userId: string;
  let isServiceRole: boolean;
  try {
    const auth = await deps.auth(req);
    userId = auth.userId;
    isServiceRole = auth.isServiceRole;
  } catch {
    return refusal(deps, 401, "unauthorized", requestId, headers, {
      action: "unknown", userId: null, accountId: null, operationId: null,
    });
  }

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(deps, 400, "invalid_request", requestId, headers, {
      action: "unknown", userId, accountId: null, operationId: null,
    });
  }

  const parsed = stage4RequestSchema.safeParse(body);
  if (!parsed.success) {
    const action = sanitiseAction((body as { action?: unknown })?.action);
    return refusal(deps, 400, "invalid_request", requestId, headers, {
      action, userId, accountId: null, operationId: null,
    });
  }
  const input = parsed.data as Stage4Request;
  const action = input.action as Stage4Action;

  // Service-role callers are refused for every Stage 4 action.
  if (isServiceRole) {
    return refusal(deps, 403, "service_role_not_allowed", requestId, headers, {
      action, userId, accountId: (input as { social_account_id?: string }).social_account_id ?? null, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }

  const accountId = (input as { social_account_id: string }).social_account_id;

  // Rate limit.
  const rl = await stage4RateLimit(
    deps.admin,
    userId,
    action.startsWith("youtube_video_page") ? "read" : action,
    action === "youtube_ban_confirmation" ? STAGE4_RATE_LIMITS.ban.max : (STAGE4_ACTION_CAPABILITY[action] === "read" ? STAGE4_RATE_LIMITS.read.max : STAGE4_RATE_LIMITS.write.max),
    action === "youtube_ban_confirmation" ? STAGE4_RATE_LIMITS.ban.windowSeconds : (STAGE4_ACTION_CAPABILITY[action] === "read" ? STAGE4_RATE_LIMITS.read.windowSeconds : STAGE4_RATE_LIMITS.write.windowSeconds),
  );
  if (!rl.allowed) {
    return refusal(deps, 429, "rate_limited", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }

  // Account read (verified).
  const account = await readAccount(deps.admin, accountId, userId);
  if (!account) {
    return refusal(deps, 404, "not_found", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (account.platform !== "youtube") {
    return refusal(deps, 404, "not_found", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (account.auth_provider !== "native") {
    return refusal(deps, 403, "provider_unsupported", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (!account.is_active) {
    return refusal(deps, 403, "account_not_connected", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }
  if (account.needs_reauth) {
    return refusal(deps, 403, "account_needs_reauth", requestId, headers, {
      action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
    });
  }

  // Capability gate.
  const requiredCap = STAGE4_ACTION_CAPABILITY[action];
  if (requiredCap) {
    const admits = await admitsCapability(deps.admin, accountId, requiredCap);
    if (!admits) {
      // Distinguish capability_off vs prerequisite vs not_admitted via the
      // status payload.
      const status = await readCapabilities(deps.admin, accountId);
      const reason = (status.capabilities[requiredCap].reason ?? "capability_off") as Stage4Reason;
      return refusal(deps, 403, reason, requestId, headers, {
        action, userId, accountId, operationId: (input as { operation_id?: string }).operation_id ?? null,
      });
    }
  }

  // ---- youtube_stage4_capabilities ---------------------------------------
  if (action === "youtube_stage4_capabilities") {
    const status = await readCapabilities(deps.admin, accountId);
    const payload: Stage4CapabilitiesPayload = {
      account_id: accountId,
      capabilities: status.capabilities as any,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_video_page ------------------------------------------------
  if (action === "youtube_video_page") {
    const cursorToken = (input as any).cursor as string | undefined;
    let pt: string | undefined;
    if (cursorToken) {
      const c = await unsealCursor(cursorToken, { signingSecret: deps.signingSecret, now: deps.now() }) as any;
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.a2 !== "video_page") {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pt = c.pt;
    }
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    const res = await provider.listUploads(
      { fetcher: deps.fetcher },
      { id: account.id, platform_user_id: account.platform_user_id, access_token: tok.token },
      tok.token,
      { pageToken: pt },
    );
    if (res.kind === "refused") {
      return refusal(deps, 403, res.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }
    const items = ((res.body as any)?.items ?? []).map((it: any) => ({
      id: String(it?.snippet?.resourceId?.videoId ?? ""),
      title: String(it?.snippet?.title ?? ""),
      published_at: it?.snippet?.publishedAt ? String(it.snippet.publishedAt) : null,
      thumbnail_url: it?.snippet?.thumbnails?.default?.url ?? null,
    })).filter((v: Stage4VideoRow) => v.id);
    const nextProviderToken = (res.body as any)?.nextPageToken ? String((res.body as any)?.nextPageToken) : null;
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { v: 1, o: userId, a: accountId, g: account.binding_generation, vi: "", l: "published", p: null, a2: "video_page", e: 0, pt: nextProviderToken } as any,
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }
    const payload: Stage4VideoPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      items,
      next_cursor: nextCursor,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_thread_page ---------------------------------------------
  if (action === "youtube_thread_page") {
    const inp = input as Extract<Stage4Request, { action: "youtube_thread_page" }>;
    const requiresHeld = inp.list === "heldForReview";
    if (requiresHeld) {
      const admits = await admitsCapability(deps.admin, accountId, "held");
      if (!admits) {
        const status = await readCapabilities(deps.admin, accountId);
        const reason = (status.capabilities.held.reason ?? "capability_off") as Stage4Reason;
        return refusal(deps, 403, reason, requestId, headers, { action, userId, accountId, operationId: null });
      }
    }
    // Verify video ownership.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    const vres = await provider.readVideo({ fetcher: deps.fetcher }, tok.token, inp.video_id);
    if (vres.kind === "refused") {
      return refusal(deps, 403, vres.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (vres.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: vres.providerClass });
    }
    const videoItem = ((vres.body as any)?.items ?? [])[0];
    if (!videoItem || videoItem.id !== inp.video_id) {
      return refusal(deps, 404, "not_found_provider", requestId, headers, { action, userId, accountId, operationId: null });
    }
    if (videoItem?.snippet?.channelId !== account.platform_user_id) {
      return refusal(deps, 403, "video_not_owned", requestId, headers, { action, userId, accountId, operationId: null });
    }

    // Cursor.
    let pageToken: string | undefined;
    if ((input as any).cursor) {
      const c = await unsealCursor((input as any).cursor, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.vi !== inp.video_id || c.l !== inp.list || c.a2 !== "thread_page") {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pageToken = (c as any).pt;
    }

    const res = await provider.listThreadsPage(
      { fetcher: deps.fetcher },
      { id: account.id, platform_user_id: account.platform_user_id, access_token: tok.token },
      tok.token,
      { videoId: inp.video_id, moderationStatus: inp.list === "heldForReview" ? "heldForReview" : "published", pageToken },
    );
    if (res.kind === "refused") {
      const reason = res.reason === "comments_disabled" ? "comments_disabled" : (res.reason as Stage4Reason);
      return refusal(deps, reason === "comments_disabled" ? 403 : 403, reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }

    // Seal rows.
    const threads = Array.isArray((res.body as any)?.items) ? (res.body as any)?.items : [];
    const rows: Stage4CommentRow[] = [];
    let inconsistent = 0;
    for (const th of threads) {
      const check = validateThreadChain(inp.video_id, th, account.platform_user_id, account.platform_user_id);
      if (!check.ok) { inconsistent++; continue; }
      const parsed = parseThreadRow(th, account, inp.video_id);
      if (!parsed) { inconsistent++; continue; }
      // thread row
      const topHandle = await sealRow(deps, account, inp.video_id, th, "thread", th?.snippet?.topLevelComment ?? th, parsed.threadRow.moderation_status, "", parsed.threadRow.author_channel_id);
      parsed.threadRow.handle = topHandle;
      rows.push(parsed.threadRow);
      // reply rows
      for (let i = 0; i < parsed.replyRows.length; i++) {
        const r = parsed.replyRows[i];
        const replyHandle = await sealRow(deps, account, inp.video_id, th, "reply", th?.replies?.comments?.[i], r.moderation_status, parsed.threadRow.comment_id, r.author_channel_id);
        r.handle = replyHandle;
        rows.push(r);
      }
    }

    const nextProviderToken = (res.body as any)?.nextPageToken ? String((res.body as any)?.nextPageToken) : null;
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { v: 1, o: userId, a: accountId, g: account.binding_generation, vi: inp.video_id, l: inp.list, p: null, a2: "thread_page", e: 0, pt: nextProviderToken } as any,
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }

    const payload: Stage4ThreadPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      video_id: inp.video_id,
      list: inp.list,
      items: rows,
      next_cursor: nextCursor,
      inconsistent_count: inconsistent,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_reply_page ---------------------------------------------
  if (action === "youtube_reply_page") {
    const inp = input as Extract<Stage4Request, { action: "youtube_reply_page" }>;
    const h = await unsealHandle(inp.parent_handle, { signingSecret: deps.signingSecret, now: deps.now() });
    if (!h || h.o !== userId || h.a !== accountId || h.g !== account.binding_generation) {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
    }
    if (h.k !== "thread" && h.k !== "reply") {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
    }
    const canonicalParent = h.p === "" ? h.co : h.p;
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: null });
    }
    let pageToken: string | undefined;
    if ((input as any).cursor) {
      const c = await unsealCursor((input as any).cursor, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!c || c.o !== userId || c.a !== accountId || c.g !== account.binding_generation || c.a2 !== "reply_page" || c.p !== canonicalParent) {
        return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: null });
      }
      pageToken = (c as any).pt;
    }
    const res = await provider.listRepliesPage({ fetcher: deps.fetcher }, tok.token, { parentId: canonicalParent, pageToken });
    if (res.kind === "refused") {
      return refusal(deps, 403, res.reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: null, providerClass: "http_4xx" });
    }
    if (res.kind === "indeterminate") {
      return refusal(deps, 502, "upstream", requestId, headers, { action, userId, accountId, operationId: null, providerClass: res.providerClass });
    }
    const items = Array.isArray((res.body as any)?.items) ? (res.body as any)?.items : [];
    const rows: Stage4CommentRow[] = [];
    let inconsistent = 0;
    for (const r of items) {
      const parentId = r?.snippet?.parentId ? String(r.snippet.parentId) : null;
      if (parentId !== canonicalParent) { inconsistent++; continue; }
      const authorChannel = r?.snippet?.authorChannelId?.value ? String(r.snippet.authorChannelId.value) : null;
      if (r?.snippet?.channelId && r.snippet.channelId !== account.platform_user_id) { inconsistent++; continue; }
      if (r?.snippet?.videoId && r.snippet.videoId !== h.vi) { inconsistent++; continue; }
      const row: Stage4CommentRow = {
        handle: "",
        kind: "reply",
        comment_id: String(r?.id ?? ""),
        thread_id: h.th,
        video_id: h.vi,
        canonical_parent_id: canonicalParent,
        author_channel_id: authorChannel,
        author_name: String(r?.snippet?.authorDisplayName ?? "Unknown"),
        author_avatar_url: r?.snippet?.authorProfileImageUrl ?? null,
        text: String(r?.snippet?.textOriginal ?? r?.snippet?.textDisplay ?? ""),
        published_at: String(r?.snippet?.publishedAt ?? new Date().toISOString()),
        like_count: Number(r?.snippet?.likeCount ?? 0),
        moderation_status: r?.snippet?.moderationStatus ? String(r.snippet.moderationStatus) : null,
        is_own: !!account.platform_user_id && authorChannel === account.platform_user_id,
      };
      const replyHandle = await sealHandle(
        { o: userId, a: accountId, g: account.binding_generation, c: account.platform_user_id, vi: h.vi, th: h.th, co: row.comment_id, k: "reply", p: canonicalParent, au: authorChannel ?? "", s: row.moderation_status },
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: HANDLE_TTL_MS },
      );
      row.handle = replyHandle;
      rows.push(row);
    }
    const nextProviderToken = (res.body as any)?.nextPageToken ? String((res.body as any)?.nextPageToken) : null;
    let nextCursor: string | null = null;
    if (nextProviderToken) {
      nextCursor = await sealCursor(
        { v: 1, o: userId, a: accountId, g: account.binding_generation, vi: h.vi, l: "published", p: canonicalParent, a2: "reply_page", e: 0, pt: nextProviderToken } as any,
        { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: CURSOR_TTL_MS },
      );
    }
    const payload: Stage4ReplyPagePayload = {
      account_id: accountId,
      channel_id: account.platform_user_id,
      parent_handle: inp.parent_handle,
      items: rows,
      next_cursor: nextCursor,
      inconsistent_count: inconsistent,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_create_thread -----------------------------------------
  if (action === "youtube_create_thread") {
    const inp = input as Extract<Stage4Request, { action: "youtube_create_thread" }>;
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Verify video ownership.
    const vres = await provider.readVideo({ fetcher: deps.fetcher }, tok.token, inp.video_id);
    if (vres.kind !== "success") {
      return refusal(deps, vres.kind === "refused" ? 403 : 502, vres.kind === "refused" ? (vres.reason as Stage4Reason) : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: vres.kind === "refused" ? "http_4xx" : vres.providerClass });
    }
    const videoItem = ((vres.body as any)?.items ?? [])[0];
    if (!videoItem || videoItem.id !== inp.video_id || videoItem?.snippet?.channelId !== account.platform_user_id) {
      return refusal(deps, 403, "video_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const digestKeys = await loadDigestKeys(deps.admin);
    const intent = await computeIntentDigest(digestKeys, {
      action: "create_thread",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: inp.video_id,
      targetIds: [],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const logical = await computeLogicalDigests(digestKeys, {
      channelId: account.platform_user_id,
      videoId: inp.video_id,
      canonicalParent: "",
      text: inp.text,
    });

    // Claim.
    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "create_thread",
      p_targets: { video_id: inp.video_id },
      p_intent_digest: intent.digest,
      p_logical_digests: logical,
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, state: claim.data.state, result_comment_id: claim.data.result_comment_id, result_thread_id: claim.data.result_thread_id } as Stage4ReceiptPayload }, headers);
      }
      const status = reason === "possible_duplicate" || reason === "recently_posted" ? 409 : 400;
      return refusal(deps, status, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    // Mark dispatched (the authorisation boundary).
    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      // The receipt is already refused by the mark; nothing was sent.
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    // Exactly one HTTP request.
    const write = await provider.insertThread({ fetcher: deps.fetcher }, tok.token, {
      channelId: account.platform_user_id,
      videoId: inp.video_id,
      text: inp.text,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason: string | null = null;
    let resultThreadId: string | null = null;
    let resultCommentId: string | null = null;
    if (write.kind === "success") {
      const body = write.body as any;
      const threadId = body?.id ? String(body.id) : null;
      const topId = body?.snippet?.topLevelComment?.id ? String(body.snippet.topLevelComment.id) : (body?.id ? String(body.id) : null);
      const videoIdOk = body?.snippet?.videoId ? String(body.snippet.videoId) === inp.video_id : true;
      const channelOk = body?.snippet?.channelId ? String(body.snippet.channelId) === account.platform_user_id : true;
      if (threadId && topId && videoIdOk && channelOk) {
        outcome = "confirmed";
        resultThreadId = threadId;
        resultCommentId = topId;
      } else {
        outcome = "indeterminate";
        providerClass = "none";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    // Settle.
    await deps.admin.rpc("youtube_comment_op_settle", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
      p_reason: reason,
      p_provider_class: providerClass,
      p_result_thread_id: resultThreadId,
      p_result_comment_id: resultCommentId,
    });

    if (outcome === "confirmed") {
      const payload: Stage4ReceiptPayload = {
        operation_id: inp.operation_id,
        action: "create_thread",
        state: "confirmed",
        reason: null,
        provider_class: null,
        moderation_status: null,
        ban_requested: false,
        result_thread_id: resultThreadId,
        result_comment_id: resultCommentId,
        binding_generation: account.binding_generation,
        channel_id: account.platform_user_id,
      };
      return ok({ ok: true, request_id: requestId, data: payload }, headers);
    }
    if (outcome === "refused") {
      return refusal(deps, 403, reason as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: "http_4xx" });
    }
    return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "create_thread", state: "indeterminate", reason: "indeterminate", provider_class: providerClass, moderation_status: null, ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: account.binding_generation, channel_id: account.platform_user_id } as Stage4ReceiptPayload }, headers);
  }

  // ---- youtube_reply ---------------------------------------------------
  if (action === "youtube_reply") {
    const inp = input as Extract<Stage4Request, { action: "youtube_reply" }>;
    const h = await unsealHandle(inp.target_handle, { signingSecret: deps.signingSecret, now: deps.now() });
    if (!h || h.o !== userId || h.a !== accountId || h.g !== account.binding_generation) {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const canonicalParent = h.p === "" ? h.co : h.p;
    // Verify target by fresh read.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, h.co);
    if (cres.kind !== "success") {
      return refusal(deps, cres.kind === "refused" ? 404 : 502, cres.kind === "refused" ? "target_not_verified" : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: cres.kind === "refused" ? "http_4xx" : cres.providerClass });
    }
    const citem = ((cres.body as any)?.items ?? [])[0];
    if (!citem || citem.id !== h.co) {
      return refusal(deps, 404, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    if (citem?.snippet?.parentId && String(citem.snippet.parentId) !== canonicalParent) {
      return refusal(deps, 400, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    const digestKeys = await loadDigestKeys(deps.admin);
    const intent = await computeIntentDigest(digestKeys, {
      action: "reply",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const logical = await computeLogicalDigests(digestKeys, {
      channelId: account.platform_user_id,
      videoId: h.vi,
      canonicalParent,
      text: inp.text,
    });

    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "reply",
      p_targets: { video_id: h.vi, parent_comment_id: canonicalParent },
      p_intent_digest: intent.digest,
      p_logical_digests: logical,
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "reply", state: claim.data.state, result_comment_id: claim.data.result_comment_id } as Stage4ReceiptPayload }, headers);
      }
      const status = reason === "possible_duplicate" || reason === "recently_posted" ? 409 : 400;
      return refusal(deps, status, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    const write = await provider.insertReply({ fetcher: deps.fetcher }, tok.token, {
      parentId: canonicalParent,
      text: inp.text,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    let resultCommentId: string | null = null;
    if (write.kind === "success") {
      const body = write.body as any;
      const id = body?.id ? String(body.id) : null;
      const parentOk = body?.snippet?.parentId ? String(body.snippet.parentId) === canonicalParent : true;
      if (id && parentOk) {
        outcome = "confirmed";
        resultCommentId = id;
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    await deps.admin.rpc("youtube_comment_op_settle", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
      p_reason: reason2,
      p_provider_class: providerClass,
      p_result_thread_id: null,
      p_result_comment_id: resultCommentId,
    });

    if (outcome === "confirmed") {
      const payload: Stage4ReceiptPayload = {
        operation_id: inp.operation_id,
        action: "reply",
        state: "confirmed",
        reason: null,
        provider_class: null,
        moderation_status: null,
        ban_requested: false,
        result_thread_id: null,
        result_comment_id: resultCommentId,
        binding_generation: account.binding_generation,
        channel_id: account.platform_user_id,
      };
      return ok({ ok: true, request_id: requestId, data: payload }, headers);
    }
    if (outcome === "refused") {
      return refusal(deps, 403, reason2 as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: "http_4xx" });
    }
    return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "reply", state: "indeterminate", reason: "indeterminate", provider_class: providerClass, moderation_status: null, ban_requested: false, result_thread_id: null, result_comment_id: null, binding_generation: account.binding_generation, channel_id: account.platform_user_id } as Stage4ReceiptPayload }, headers);
  }

  // ---- youtube_edit_comment -------------------------------------------
  if (action === "youtube_edit_comment") {
    const inp = input as Extract<Stage4Request, { action: "youtube_edit_comment" }>;
    const h = await unsealHandle(inp.target_handle, { signingSecret: deps.signingSecret, now: deps.now() });
    if (!h || h.o !== userId || h.a !== accountId || h.g !== account.binding_generation) {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    if (h.k !== "thread" && h.k !== "reply") {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const authorChannel = h.au;
    if (!authorChannel || authorChannel !== account.platform_user_id) {
      return refusal(deps, 403, "target_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Fresh target read.
    const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, h.co);
    if (cres.kind !== "success") {
      return refusal(deps, cres.kind === "refused" ? 404 : 502, cres.kind === "refused" ? "target_not_verified" : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: cres.kind === "refused" ? "http_4xx" : cres.providerClass });
    }
    const citem = ((cres.body as any)?.items ?? [])[0];
    if (!citem || citem.id !== h.co) {
      return refusal(deps, 404, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
    if (!author || author !== account.platform_user_id) {
      return refusal(deps, 403, "target_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    // Claim (edit has no logical fence).
    const digestKeys = await loadDigestKeys(deps.admin);
    const intent = await computeIntentDigest(digestKeys, {
      action: "edit",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: null,
      banAuthor: false,
      text: inp.text,
    });
    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "edit",
      p_targets: { video_id: h.vi, comment_id: h.co },
      p_intent_digest: intent.digest,
      p_logical_digests: {},
      p_capability: "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "edit", state: claim.data.state, result_comment_id: h.co } as Stage4ReceiptPayload }, headers);
      }
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    const write = await provider.updateComment({ fetcher: deps.fetcher }, tok.token, { commentId: h.co, text: inp.text });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    if (write.kind === "success") {
      const body = write.body as any;
      if (body?.id && String(body.id) === h.co) {
        outcome = "confirmed";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    await deps.admin.rpc("youtube_comment_op_settle", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
      p_reason: reason2,
      p_provider_class: providerClass,
      p_result_thread_id: null,
      p_result_comment_id: h.co,
    });

    if (outcome === "confirmed") {
      const payload: Stage4ReceiptPayload = {
        operation_id: inp.operation_id,
        action: "edit",
        state: "confirmed",
        reason: null,
        provider_class: null,
        moderation_status: null,
        ban_requested: false,
        result_thread_id: null,
        result_comment_id: h.co,
        binding_generation: account.binding_generation,
        channel_id: account.platform_user_id,
      };
      return ok({ ok: true, request_id: requestId, data: payload }, headers);
    }
    if (outcome === "refused") {
      return refusal(deps, 403, reason2 as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: "http_4xx" });
    }
    return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "edit", state: "indeterminate", reason: "indeterminate", provider_class: providerClass, moderation_status: null, ban_requested: false, result_thread_id: null, result_comment_id: h.co, binding_generation: account.binding_generation, channel_id: account.platform_user_id } as Stage4ReceiptPayload }, headers);
  }

  // ---- youtube_ban_confirmation --------------------------------------
  if (action === "youtube_ban_confirmation") {
    const inp = input as Extract<Stage4Request, { action: "youtube_ban_confirmation" }>;
    const h = await unsealHandle(inp.target_handle, { signingSecret: deps.signingSecret, now: deps.now() });
    if (!h || h.o !== userId || h.a !== accountId || h.g !== account.binding_generation) {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Re-verify account capability for ban.
    const admits = await admitsCapability(deps.admin, accountId, "ban");
    if (!admits) {
      const status = await readCapabilities(deps.admin, accountId);
      const reason = (status.capabilities.ban.reason ?? "capability_off") as Stage4Reason;
      return refusal(deps, 403, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Fresh target read.
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, h.co);
    if (cres.kind !== "success") {
      return refusal(deps, cres.kind === "refused" ? 404 : 502, cres.kind === "refused" ? "target_not_verified" : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: cres.kind === "refused" ? "http_4xx" : cres.providerClass });
    }
    const citem = ((cres.body as any)?.items ?? [])[0];
    if (!citem || citem.id !== h.co) {
      return refusal(deps, 404, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
    if (!author || author === "" || author === account.platform_user_id) {
      return refusal(deps, 400, "target_missing_author", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const authorName = String(citem?.snippet?.authorDisplayName ?? "Unknown");
    const confirmation = await sealBanConfirmation(
      { o: userId, a: accountId, g: account.binding_generation, vi: h.vi, co: h.co, au: author, op: inp.operation_id },
      { signingSecret: deps.signingSecret, now: deps.now(), ttlMs: BAN_CONFIRMATION_TTL_MS },
    );
    const payload: Stage4BanConfirmationPayload = {
      confirmation,
      expires_in_seconds: 120,
      author_channel_id: author,
      author_name: authorName,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // ---- youtube_moderate_comment --------------------------------------
  if (action === "youtube_moderate_comment") {
    const inp = input as Extract<Stage4Request, { action: "youtube_moderate_comment" }>;
    const h = await unsealHandle(inp.target_handle, { signingSecret: deps.signingSecret, now: deps.now() });
    if (!h || h.o !== userId || h.a !== accountId || h.g !== account.binding_generation) {
      return refusal(deps, 400, "invalid_handle", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Ban token verification (only when present).
    let banAuthor = false;
    if (inp.ban_confirmation) {
      const bnc = await unsealBanConfirmation(inp.ban_confirmation, { signingSecret: deps.signingSecret, now: deps.now() });
      if (!bnc) {
        return refusal(deps, 400, "ban_confirmation_invalid", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      if (bnc.e < deps.now()) {
        return refusal(deps, 400, "ban_confirmation_expired", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      if (bnc.o !== userId || bnc.a !== accountId || bnc.g !== account.binding_generation || bnc.vi !== h.vi || bnc.co !== h.co || bnc.op !== inp.operation_id) {
        return refusal(deps, 400, "ban_confirmation_mismatch", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      // Re-verify the author by a fresh read.
      const tok = await prepareToken(account, deps);
      if (!tok.ok) {
        return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, h.co);
      if (cres.kind !== "success") {
        return refusal(deps, 404, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      const citem = ((cres.body as any)?.items ?? [])[0];
      const author = citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null;
      if (!author || author !== bnc.au || author === account.platform_user_id) {
        return refusal(deps, 400, "ban_confirmation_mismatch", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      // Capability check for ban.
      const admits = await admitsCapability(deps.admin, accountId, "ban");
      if (!admits) {
        const status = await readCapabilities(deps.admin, accountId);
        const reason = (status.capabilities.ban.reason ?? "capability_off") as Stage4Reason;
        return refusal(deps, 403, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
      }
      banAuthor = true;
    } else if (inp.status === "rejected") {
      // Plain reject: no ban. (banAuthor stays false.)
    }

    // Reject with ban requires the token. Reject without ban is fine.
    if (inp.status === "rejected" && inp.ban_confirmation && !banAuthor) {
      // token present but not verified → already refused above.
    }
    if (inp.status === "rejected" && banAuthor === false && inp.ban_confirmation) {
      return refusal(deps, 400, "ban_confirmation_invalid", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    // Verify video ownership (the handle carries the video).
    const tok = await prepareToken(account, deps);
    if (!tok.ok) {
      return refusal(deps, 401, tok.reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const vres = await provider.readVideo({ fetcher: deps.fetcher }, tok.token, h.vi);
    if (vres.kind !== "success") {
      return refusal(deps, vres.kind === "refused" ? 404 : 502, vres.kind === "refused" ? "target_not_verified" : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: vres.kind === "refused" ? "http_4xx" : vres.providerClass });
    }
    const videoItem = ((vres.body as any)?.items ?? [])[0];
    if (!videoItem || videoItem.id !== h.vi || videoItem?.snippet?.channelId !== account.platform_user_id) {
      return refusal(deps, 403, "video_not_owned", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    // Fresh target read.
    const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, h.co);
    if (cres.kind !== "success") {
      return refusal(deps, cres.kind === "refused" ? 404 : 502, cres.kind === "refused" ? "target_not_verified" : "upstream", requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: cres.kind === "refused" ? "http_4xx" : cres.providerClass });
    }
    const citem = ((cres.body as any)?.items ?? [])[0];
    if (!citem || citem.id !== h.co) {
      return refusal(deps, 404, "target_not_verified", requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    const digestKeys = await loadDigestKeys(deps.admin);
    const intent = await computeIntentDigest(digestKeys, {
      action: "moderate",
      accountId: account.id,
      bindingGeneration: account.binding_generation,
      videoId: h.vi,
      targetIds: [h.co],
      moderationStatus: inp.status,
      banAuthor,
      text: inp.status,
    });

    const claim = await deps.admin.rpc("youtube_comment_op_claim", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
      p_operation_id: inp.operation_id,
      p_action: "moderate",
      p_targets: {
        video_id: h.vi,
        comment_id: h.co,
        moderation_status: inp.status,
        ban_author: banAuthor,
        author_channel_id: citem?.snippet?.authorChannelId?.value ? String(citem.snippet.authorChannelId.value) : null,
      },
      p_intent_digest: intent.digest,
      p_logical_digests: {},
      p_capability: banAuthor ? "ban" : "write",
      p_request_id: requestId,
    });
    if (claim.error || !claim.data?.ok) {
      const reason = (claim.data?.reason ?? "upstream") as Stage4Reason;
      if (reason === "already_recorded") {
        return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "moderate", state: claim.data.state, result_comment_id: h.co } as Stage4ReceiptPayload }, headers);
      }
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    const attemptToken = claim.data.attempt_token;

    const mark = await deps.admin.rpc("youtube_comment_op_mark_dispatched", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_expected_channel: account.platform_user_id,
      p_expected_generation: account.binding_generation,
    });
    if (mark.error || !mark.data?.ok) {
      const reason = (mark.data?.reason ?? "upstream") as Stage4Reason;
      return refusal(deps, 409, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }

    const write = await provider.setModerationStatus({ fetcher: deps.fetcher }, tok.token, {
      commentId: h.co,
      status: inp.status,
      banAuthor,
    });
    let outcome: "confirmed" | "refused" | "indeterminate" = "indeterminate";
    let providerClass: Stage4ProviderClass = "none";
    let reason2: string | null = null;
    if (write.kind === "success") {
      // Moderation: only 204 is acceptance.
      if (write.status === 204) {
        outcome = "confirmed";
      } else {
        outcome = "indeterminate";
        providerClass = "none";
      }
    } else if (write.kind === "refused") {
      outcome = "refused";
      providerClass = "http_4xx";
      reason2 = write.reason;
    } else {
      outcome = "indeterminate";
      providerClass = write.providerClass;
    }

    await deps.admin.rpc("youtube_comment_op_settle", {
      p_owner_id: userId,
      p_operation_id: inp.operation_id,
      p_attempt_token: attemptToken,
      p_outcome: outcome,
      p_reason: reason2,
      p_provider_class: providerClass,
      p_result_thread_id: null,
      p_result_comment_id: h.co,
    });

    if (outcome === "confirmed") {
      const payload: Stage4ReceiptPayload = {
        operation_id: inp.operation_id,
        action: "moderate",
        state: "confirmed",
        reason: null,
        provider_class: null,
        moderation_status: inp.status,
        ban_requested: banAuthor,
        result_thread_id: null,
        result_comment_id: h.co,
        binding_generation: account.binding_generation,
        channel_id: account.platform_user_id,
      };
      return ok({ ok: true, request_id: requestId, data: payload }, headers);
    }
    if (outcome === "refused") {
      return refusal(deps, 403, reason2 as Stage4Reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id, providerClass: "http_4xx" });
    }
    return ok({ ok: true, request_id: requestId, data: { operation_id: inp.operation_id, action: "moderate", state: "indeterminate", reason: "indeterminate", provider_class: providerClass, moderation_status: inp.status, ban_requested: banAuthor, result_thread_id: null, result_comment_id: h.co, binding_generation: account.binding_generation, channel_id: account.platform_user_id } as Stage4ReceiptPayload }, headers);
  }

  // ---- youtube_operation_status --------------------------------------
  if (action === "youtube_operation_status") {
    const inp = input as Extract<Stage4Request, { action: "youtube_operation_status" }>;
    const { data, error } = await deps.admin.rpc("youtube_comment_op_status", {
      p_owner_id: userId,
      p_account_id: accountId,
      p_operation_id: inp.operation_id,
    });
    if (error || !data?.ok) {
      const reason = (data?.reason ?? "not_found") as Stage4Reason;
      return refusal(deps, 404, reason, requestId, headers, { action, userId, accountId, operationId: inp.operation_id });
    }
    // Edit observation (read-only, only with read capability).
    let observation: Stage4OperationStatusPayload["observation"] = null;
    let observedText: string | null = null;
    if (data.action === "edit" && data.result_comment_id) {
      const admits = await admitsCapability(deps.admin, accountId, "read");
      if (admits) {
        const tok = await prepareToken(account, deps);
        if (tok.ok) {
          const cres = await provider.readComment({ fetcher: deps.fetcher }, tok.token, String(data.result_comment_id));
          if (cres.kind === "success") {
            const citem = ((cres.body as any)?.items ?? [])[0];
            const text = citem?.snippet?.textOriginal ? String(citem.snippet.textOriginal) : null;
            if (text !== null) {
              // We don't have the requested text here (it's in the receipt's
              // intent, which we don't store). Report presence only.
              observedText = text;
              observation = "different_text_observed";
            } else {
              observation = "unavailable";
            }
          } else {
            observation = "unavailable";
          }
        } else {
          observation = "unavailable";
        }
      }
    }
    const payload: Stage4OperationStatusPayload = {
      operation_id: data.operation_id,
      action: data.action,
      state: data.state,
      reason: data.reason,
      provider_class: data.provider_class,
      moderation_status: data.moderation_status,
      ban_requested: data.ban_requested === true,
      result_thread_id: data.result_thread_id,
      result_comment_id: data.result_comment_id,
      binding_generation: data.binding_generation,
      channel_id: data.channel_id,
      observation,
      observed_text: observedText,
    };
    return ok({ ok: true, request_id: requestId, data: payload }, headers);
  }

  // Should never reach here (discriminated union covers all actions).
  return refusal(deps, 400, "invalid_request", requestId, headers, { action, userId, accountId, operationId: null });
}

