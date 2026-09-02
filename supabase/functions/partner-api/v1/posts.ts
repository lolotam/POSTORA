// The /v1 posts surface — Phase 8, first tranche (spec §7 endpoint table):
//
//   POST   /v1/posts                 create (posts:write,    class C, Idempotency-Key)
//   GET    /v1/posts/{id}            read   (posts:read,     class A)
//   GET    /v1/posts/{id}/status     per-target status (posts:read, class A)
//   POST   /v1/posts/{id}/schedule   schedule / reschedule (posts:schedule, C)
//   DELETE /v1/posts/{id}/schedule   unschedule (posts:schedule, C)
//
// POST /{id}/publish is DELIBERATELY absent: it needs the 7.2/7.3 platform
// registry (the postToX bodies are still inside process-post/index.ts, which
// D9 forbids importing or bridging to). Publishing a /v1 post today happens
// the way it happens for every post: schedule it, and the cron publishes it.
//
// ADDRESSABILITY — the partner_api_posts binding row
// --------------------------------------------------
// posts has no workspace anchor (only user_id), so /v1 addresses EXACTLY the
// posts a partner key created, proven by a partner_api_posts row in the key's
// workspace. UI-created posts have no row and answer resource_not_found —
// fail-closed, same shape as binding.ts. A guessed tenant is worse than a
// missing one.
//
// THE CRON CONTRACT
// -----------------
// A scheduled /v1 post publishes because its row matches
// process-scheduled-posts' pickup predicate EXACTLY:
//
//     status IN ('pending','scheduled') AND scheduled_at <= now()
//
// so this module writes status 'scheduled' with a non-null scheduled_at and
// never any other combination. supabase/tests/partner_posts.sql asserts a
// /v1-created row against that predicate verbatim — an endpoint that 200s
// while writing an unmatchable row would "work" forever and publish nothing.

import { claimIdempotency, completeIdempotency, hashRequest } from "../../_shared/partnerApiIdempotency.ts";
import { decodeId, encodeId } from "./ids.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/** Strict ISO-8601 with an explicit offset. Date.parse alone is NOT a
 *  validator — it accepts "May 8, 2026", whose comma then reaches PostgREST's
 *  filter grammar (this bit production once; see the memory record). The
 *  offset is required because a partner's "14:00" without one would silently
 *  mean the edge worker's timezone. */
const ISO_8601_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The shape check above is not a calendar check: Date.UTC NORMALISES, so
 * "2026-02-30" becomes March 2nd and "24:00" becomes tomorrow, and a partner
 * who typo'd a date would get a post published on a day they never named.
 * So the components are round-tripped through Date.UTC and anything that did
 * not survive unchanged is refused.
 */
function parseScheduledAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_8601_RE.exec(value);
  if (!match) return null;

  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
  const second = match[6] ? Number(match[6]) : 0;
  const millis = match[7] ? Math.round(Number(`0.${match[7]}`) * 1000) : 0;

  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (
    asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day || asUtc.getUTCHours() !== hour ||
    asUtc.getUTCMinutes() !== minute || asUtc.getUTCSeconds() !== second
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetMins) * (match[9] === "-" ? -1 : 1);
  }
  return new Date(asUtc.getTime() - offsetMinutes * 60_000).toISOString();
}

interface PostRow {
  id: string;
  caption: string | null;
  platforms: string[] | null;
  media_file_ids: string[] | null;
  status: string;
  scheduled_at: string | null;
  posted_at: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
}

/** The published shape. Targets come from metadata.selected_account_ids —
 *  the same field the scheduler reads — so what /v1 reports and what will
 *  actually publish cannot be two different lists. */
function presentPost(row: PostRow): Record<string, unknown> {
  const targetIds = Array.isArray(row.metadata?.selected_account_ids)
    ? (row.metadata!.selected_account_ids as string[])
    : [];
  return {
    id: encodeId("post", row.id),
    caption: row.caption ?? "",
    platforms: row.platforms ?? [],
    status: row.status,
    scheduled_at: row.scheduled_at,
    posted_at: row.posted_at,
    created_at: row.created_at,
    media_file_ids: (row.media_file_ids ?? []).map((id) => encodeId("media", id)),
    targets: targetIds.map((id) => encodeId("acc", id)),
  };
}

/**
 * The binding lookup every route below starts with: the post id resolves iff
 * a partner_api_posts row exists IN THIS KEY'S WORKSPACE. A UI post, another
 * workspace's post, and a nonexistent post are all `resource_not_found` —
 * indistinguishable on purpose (D11's resource-read rule).
 */
async function resolveBoundPost(
  authed: V1AuthedContext,
  rawId: string,
): Promise<{ ok: true; post: PostRow } | { ok: false; res: Response }> {
  const { admin, record, requestId } = authed;

  const postId = decodeId("post", rawId);
  if (postId === null) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }

  const { data: bindingRow, error: bindingError } = await admin
    .from("partner_api_posts")
    .select("post_id")
    .eq("post_id", postId)
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();
  if (bindingError) {
    console.error(`[partner-api] post binding lookup failed (request ${requestId}):`, bindingError);
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }
  if (!bindingRow) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }

  const { data: post, error: postError } = await admin
    .from("posts")
    .select("id, caption, platforms, media_file_ids, status, scheduled_at, posted_at, created_at, metadata")
    .eq("id", postId)
    .maybeSingle();
  if (postError) {
    console.error(`[partner-api] post fetch failed (request ${requestId}):`, postError);
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }
  if (!post) {
    // A binding with no post: post_id is a CASCADE FK, so this is a torn read
    // between the two queries, not a partner mistake.
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }

  return { ok: true, post: post as PostRow };
}

// ---------------------------------------------------------------------------
// POST /v1/posts
// ---------------------------------------------------------------------------

export async function createPost(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  // A create is billed to quota, so the key is required — the same rule the
  // other durable writes apply.
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) return v1ErrorResponse("missing_idempotency_key", requestId);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "A JSON body is required",
    });
  }
  const payload = body as Record<string, unknown>;

  // targets[] per D11: explicit, non-empty, no "publish to everything"
  // shorthand (spec §15.4's multi-account rule).
  if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "`targets` must be a non-empty array of account ids",
    });
  }
  const targetIds: string[] = [];
  for (const raw of payload.targets) {
    const accountId = typeof raw === "string" ? decodeId("acc", raw) : null;
    // A malformed target answers as an unknown one — see ids.ts.
    if (accountId === null) return v1ErrorResponse("resource_not_found", requestId);
    if (!targetIds.includes(accountId)) targetIds.push(accountId);
  }

  const caption = typeof payload.caption === "string" ? payload.caption : "";

  let scheduledAt: string | null = null;
  if (payload.scheduled_at !== undefined && payload.scheduled_at !== null) {
    scheduledAt = parseScheduledAt(payload.scheduled_at);
    if (scheduledAt === null) {
      return v1ErrorResponse("invalid_request", requestId, {
        message: "`scheduled_at` must be an ISO-8601 timestamp with an explicit offset, e.g. 2026-09-03T14:00:00Z",
      });
    }
  }

  const mediaIds: string[] = [];
  if (payload.media_file_ids !== undefined) {
    if (!Array.isArray(payload.media_file_ids)) {
      return v1ErrorResponse("invalid_request", requestId, {
        message: "`media_file_ids` must be an array of media ids",
      });
    }
    for (const raw of payload.media_file_ids) {
      const mediaId = typeof raw === "string" ? decodeId("media", raw) : null;
      if (mediaId === null) return v1ErrorResponse("resource_not_found", requestId);
      if (!mediaIds.includes(mediaId)) mediaIds.push(mediaId);
    }
  }

  // Every target must be bound to THIS key. An unbound target — another
  // workspace's account, a revoked binding, a guess — answers
  // resource_not_found, teaching a prober nothing (D11).
  //
  // Queried for the REQUESTED ids, not via boundAccountIds(): that helper
  // refuses outright past BOUND_ACCOUNT_FILTER_MAX bindings because it exists
  // for unfiltered listings, and binding a 201st account must not take away
  // a key's ability to create a post for the first.
  const { data: bindingRows, error: bindingError } = await admin
    .from("partner_api_key_accounts")
    .select("social_account_id")
    .eq("key_id", record.id)
    .eq("workspace_id", record.workspaceId)
    .in("social_account_id", targetIds);
  if (bindingError) {
    console.error(`[partner-api] post target binding lookup failed (request ${requestId}):`, bindingError);
    return v1ErrorResponse("internal_error", requestId);
  }
  if ((bindingRows ?? []).length !== targetIds.length) {
    return v1ErrorResponse("resource_not_found", requestId);
  }

  // Hydrate the targets: platform set, activity, and OWNER. Workspace-scoped
  // again per binding.ts's "tenancy is proven twice".
  const { data: accountRows, error: accountsError } = await admin
    .from("social_accounts")
    .select("id, user_id, platform, is_active")
    .in("id", targetIds)
    .eq("workspace_id", record.workspaceId);
  if (accountsError) {
    console.error(`[partner-api] post target fetch failed (request ${requestId}):`, accountsError);
    return v1ErrorResponse("internal_error", requestId);
  }
  const accounts = (accountRows ?? []) as {
    id: string;
    user_id: string;
    platform: string;
    is_active: boolean;
  }[];
  if (accounts.length !== targetIds.length) {
    return v1ErrorResponse("resource_not_found", requestId);
  }
  for (const account of accounts) {
    if (account.platform === "whatsapp") {
      // WhatsApp is a messaging surface; process-post has no branch for it.
      // Refusing here beats a post that sits in `pending` forever.
      return v1ErrorResponse("unsupported_capability", requestId, {
        message: "WhatsApp accounts cannot receive feed posts; use POST /v1/messages",
      });
    }
    if (!account.is_active) {
      return v1ErrorResponse("invalid_request", requestId, {
        message: "A target account is disconnected; reconnect it in Postora first",
      });
    }
  }

  // ONE owner. A workspace can hold accounts owned by different members, and
  // the quota trigger charges posts.user_id — mixed-owner targets would bill
  // one member for another member's post.
  const owners = [...new Set(accounts.map((a) => a.user_id))];
  if (owners.length !== 1) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "All target accounts must belong to one Postora user; split the post per owner",
    });
  }
  const platforms = [...new Set(accounts.map((a) => a.platform))];

  // Media must be THIS workspace's uploads. Pre-Phase-4 app uploads carry
  // workspace_id NULL and match nothing, by design (see media.ts).
  if (mediaIds.length > 0) {
    const { data: mediaRows, error: mediaError } = await admin
      .from("media_files")
      .select("id")
      .in("id", mediaIds)
      .eq("workspace_id", record.workspaceId);
    if (mediaError) {
      console.error(`[partner-api] post media check failed (request ${requestId}):`, mediaError);
      return v1ErrorResponse("internal_error", requestId);
    }
    if ((mediaRows ?? []).length !== mediaIds.length) {
      return v1ErrorResponse("resource_not_found", requestId);
    }
  }

  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest({
      action: "create_post",
      caption,
      targets: [...targetIds].sort(),
      media: [...mediaIds].sort(),
      scheduled_at: scheduledAt,
    }),
  );
  if (claim.outcome === "conflict") return v1ErrorResponse("idempotency_conflict", requestId);
  if (claim.outcome === "in_progress") return v1ErrorResponse("idempotency_in_progress", requestId);
  if (claim.outcome === "indeterminate") {
    return v1ErrorResponse("idempotency_indeterminate", requestId);
  }
  if (claim.outcome === "replay") {
    return v1JsonResponse(claim.body, requestId, claim.httpStatus);
  }

  // Atomic: posts row + addressability binding (+ the post.scheduled enqueue,
  // via the trigger) in one transaction. Two client-side writes would leave a
  // billed, invisible post for a crash to strand.
  const { data: created, error: createError } = await admin.rpc("partner_create_post", {
    p_workspace_id: record.workspaceId,
    p_key_id: record.id,
    p_user_id: owners[0],
    p_caption: caption,
    p_platforms: platforms,
    p_media_file_ids: mediaIds,
    p_selected_account_ids: targetIds,
    p_scheduled_at: scheduledAt,
  });
  if (createError) {
    // The quota trigger's refusal arrives as a raised exception whose message
    // is prefixed POST_QUOTA_. That is the OWNER's plan limit, not an API
    // limit — but to the partner it is the same verdict: quota_exceeded.
    if (typeof createError.message === "string" && createError.message.includes("POST_QUOTA_")) {
      return v1ErrorResponse("quota_exceeded", requestId, {
        message: "The workspace owner's post quota is exhausted",
      });
    }
    console.error(`[partner-api] post create failed (request ${requestId}):`, createError);
    return v1ErrorResponse("internal_error", requestId);
  }

  const responseBody = presentPost(created as PostRow);
  await completeIdempotency(admin, record.id, idempotencyKey, claim.attemptToken, 201, responseBody);
  return v1JsonResponse(responseBody, requestId, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/posts/{id}
// ---------------------------------------------------------------------------

export async function getPost(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const resolved = await resolveBoundPost(authed, params.id ?? "");
  if (!resolved.ok) return resolved.res;
  return v1JsonResponse(presentPost(resolved.post), authed.requestId);
}

// ---------------------------------------------------------------------------
// GET /v1/posts/{id}/status
// ---------------------------------------------------------------------------

/** Per-target truth lives in platform_posts (D11): one row per (account,
 *  sub-post), so a two-platform post where one side failed reads as exactly
 *  that, not as a single collapsed verdict. Provider ids are separate,
 *  clearly named fields — never the primary id (§7.1). */
export async function getPostStatus(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, requestId } = authed;

  const resolved = await resolveBoundPost(authed, params.id ?? "");
  if (!resolved.ok) return resolved.res;

  const { data: rows, error } = await admin
    .from("platform_posts")
    .select("social_account_id, platform, status, platform_post_id, platform_post_url, error_message, posted_at")
    .eq("post_id", resolved.post.id)
    .order("posted_at", { ascending: true });
  if (error) {
    console.error(`[partner-api] post status fetch failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }

  return v1JsonResponse({
    post_id: encodeId("post", resolved.post.id),
    status: resolved.post.status,
    scheduled_at: resolved.post.scheduled_at,
    // deno-lint-ignore no-explicit-any
    targets: (rows ?? []).map((row: any) => ({
      account_id: row.social_account_id ? encodeId("acc", row.social_account_id) : null,
      platform: row.platform,
      status: row.status,
      provider_post_id: row.platform_post_id ?? null,
      provider_post_url: row.platform_post_url ?? null,
      error_message: row.error_message ?? null,
      posted_at: row.posted_at ?? null,
    })),
  }, requestId);
}

// ---------------------------------------------------------------------------
// POST /v1/posts/{id}/schedule — schedule or reschedule
// ---------------------------------------------------------------------------

/** No Idempotency-Key: setting the same scheduled_at twice IS the same state,
 *  and the outbox's occurrence dedup absorbs the duplicate emit — the
 *  operation is naturally idempotent in a way a create is not. */
export async function schedulePost(
  req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, requestId } = authed;

  const resolved = await resolveBoundPost(authed, params.id ?? "");
  if (!resolved.ok) return resolved.res;

  const body = await req.json().catch(() => null);
  const scheduledAt = parseScheduledAt((body as Record<string, unknown> | null)?.scheduled_at);
  if (scheduledAt === null) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "`scheduled_at` must be an ISO-8601 timestamp with an explicit offset, e.g. 2026-09-03T14:00:00Z",
    });
  }

  // Only a not-yet-published post can be (re)scheduled. 'processing' is
  // already in the publisher's hands; 'completed'/'failed' are terminal.
  if (resolved.post.status !== "pending" && resolved.post.status !== "scheduled") {
    return v1ErrorResponse("invalid_request", requestId, {
      message: `A post with status "${resolved.post.status}" cannot be scheduled`,
    });
  }

  // The status guard is IN the predicate, not just checked above: the read
  // and this write are two requests, and the cron may have flipped the post
  // to 'processing' between them. A raced update then matches zero rows.
  const { data: updated, error } = await admin
    .from("posts")
    .update({ scheduled_at: scheduledAt, status: "scheduled" })
    .eq("id", resolved.post.id)
    .in("status", ["pending", "scheduled"])
    .select("id, caption, platforms, media_file_ids, status, scheduled_at, posted_at, created_at, metadata")
    .maybeSingle();
  if (error) {
    console.error(`[partner-api] post schedule failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!updated) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "The post began publishing before the schedule landed; check GET /v1/posts/{id}/status",
    });
  }

  return v1JsonResponse(presentPost(updated as PostRow), requestId);
}

// ---------------------------------------------------------------------------
// DELETE /v1/posts/{id}/schedule — unschedule
// ---------------------------------------------------------------------------

/** Clearing the schedule parks the post as 'pending' with scheduled_at NULL —
 *  a combination the cron predicate can never match, so it will not publish
 *  until scheduled again. There is no post.unscheduled event: no such type is
 *  certified, and the trigger emits only on a non-null scheduled_at. */
export async function unschedulePost(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, requestId } = authed;

  const resolved = await resolveBoundPost(authed, params.id ?? "");
  if (!resolved.ok) return resolved.res;

  if (resolved.post.status !== "scheduled") {
    // Unscheduling a post that is not scheduled: 'pending' is already the
    // requested end state (idempotent success); anything else cannot be
    // pulled back.
    if (resolved.post.status === "pending") {
      return v1JsonResponse(presentPost(resolved.post), requestId);
    }
    return v1ErrorResponse("invalid_request", requestId, {
      message: `A post with status "${resolved.post.status}" has no schedule to remove`,
    });
  }

  const { data: updated, error } = await admin
    .from("posts")
    .update({ scheduled_at: null, status: "pending" })
    .eq("id", resolved.post.id)
    .eq("status", "scheduled")
    .select("id, caption, platforms, media_file_ids, status, scheduled_at, posted_at, created_at, metadata")
    .maybeSingle();
  if (error) {
    console.error(`[partner-api] post unschedule failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!updated) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "The post began publishing before the unschedule landed; check GET /v1/posts/{id}/status",
    });
  }

  return v1JsonResponse(presentPost(updated as PostRow), requestId);
}
