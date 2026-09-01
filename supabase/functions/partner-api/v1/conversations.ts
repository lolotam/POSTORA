// GET /v1/conversations, /{id} and /{id}/messages (deliverables 2.4–2.6).
//
// WHY THESE READS ARE WHATSAPP-ONLY, STATED SO IT IS A DECISION
// -------------------------------------------------------------
// `messaging_cache` is cross-platform, so it LOOKS like the universal
// conversation table. It is not the whole story: the app reads WhatsApp
// messages from `whatsapp_messages` and Meta DMs from `social_inbox_events`
// (src/hooks/useMessaging.ts:178), two tables with different shapes and no
// common message row. There is no per-message Meta table to read.
//
// So `/v1` publishes WhatsApp conversations and refuses the rest EXPLICITLY,
// rather than listing a Facebook conversation whose `/messages` would then
// answer an empty page. An empty page is a lie a partner cannot distinguish
// from a quiet inbox; `unsupported_capability` is a fact they can act on. A
// bound non-WhatsApp account is not hidden either — `GET /v1/accounts` lists
// it, because it IS bound, and `resource_not_found` there would be a
// different lie.
//
// D7 risk class **A** throughout: bounded local reads, no outbound call.
//
// THE PUBLISHED ID IS THE SURROGATE, NOT THE NATURAL KEY
// ------------------------------------------------------
// `messaging_cache.conversation_id` is text of the form
// `wa_<phone_number_id>_<msisdn>` — the customer's phone number is inside it.
// `/v1` publishes `messaging_cache.id` (a UUID) as `conv_…` and never emits
// the text key, so a customer MSISDN does not end up in every partner's URL
// bar and error tracker. The counterparty is still reachable, as
// `participant_name` — a named field a partner needs in order to reply, which
// is exactly §7.1's distinction between a named provider field and an id.

import {
  boundAccountIds,
  selectBoundAccounts,
} from "./binding.ts";
import { decodeId, encodeId } from "./ids.ts";
import { keysetFilter, paginate, readPageRequest } from "./pagination.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1Collection, v1JsonResponse } from "./respond.ts";
import type { V1AuthedContext } from "./authenticated.ts";

/** The only platform whose per-message rows this surface can read. See the
 *  header: this is a data-model fact, not a policy choice. */
const READABLE_PLATFORM = "whatsapp";

const CONVERSATION_COLUMNS =
  "id, social_account_id, platform, participant_name, last_message_preview, " +
  "last_message_at, unread_count";

const MESSAGE_COLUMNS =
  "id, social_account_id, conversation_id, message_id, message_text, " +
  "message_type, direction, status, timestamp";

// deno-lint-ignore no-explicit-any
function presentConversation(row: any): Record<string, unknown> {
  return {
    id: encodeId("conv", row.id),
    account_id: encodeId("acc", row.social_account_id),
    platform: row.platform,
    participant_name: row.participant_name ?? null,
    last_message_preview: row.last_message_preview ?? null,
    last_message_at: row.last_message_at ?? null,
    unread_count: row.unread_count ?? 0,
  };
}

// deno-lint-ignore no-explicit-any
function presentMessage(row: any, conversationUuid: string | null): Record<string, unknown> {
  return {
    id: encodeId("msg", row.id),
    conversation_id: conversationUuid === null ? null : encodeId("conv", conversationUuid),
    account_id: encodeId("acc", row.social_account_id),
    direction: row.direction,
    type: row.message_type,
    text: row.message_text ?? null,
    status: row.status,
    timestamp: row.timestamp,
    // The wamid. §7.1: a provider id is a separate, clearly named field —
    // never the primary id, which must stay stable and Postora-owned.
    provider_message_id: row.message_id ?? null,
  };
}

/** `?account_id=` narrowed to the bound set, or the refusal to send. */
function accountFilterFrom(
  req: Request,
  boundIds: string[],
  requestId: string,
): { ok: true; ids: string[] } | { ok: false; res: Response } {
  const raw = new URL(req.url).searchParams.get("account_id");
  if (raw === null || raw === "") return { ok: true, ids: boundIds };
  const accountId = decodeId("acc", raw);
  // A malformed selector answers as an unbound one does — the partner learns
  // nothing about which account ids exist.
  if (accountId === null) return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  return selectBoundAccounts(boundIds, accountId, requestId);
}

export async function listConversations(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const page = readPageRequest(req, requestId);
  if (!page.ok) return page.res;

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;

  const scope = accountFilterFrom(req, bound.ids, requestId);
  if (!scope.ok) return scope.res;
  // An unbound key reads nothing. Short-circuiting also keeps an empty
  // `IN ()` — which PostgREST rejects — off the wire.
  if (scope.ids.length === 0) return v1Collection([], null, requestId);

  let query = admin
    .from("messaging_cache")
    .select(CONVERSATION_COLUMNS)
    .eq("workspace_id", record.workspaceId)
    .eq("platform", READABLE_PLATFORM)
    .in("social_account_id", scope.ids)
    // The sort key must be non-null for a keyset cursor to be a total
    // ordering, and `last_message_at` is nullable. A conversation with no
    // last message has nothing to page BY and nothing to show — excluding it
    // is what makes the cursor sound, and it is stated in the OpenAPI
    // description so it is a documented boundary rather than a surprise.
    .not("last_message_at", "is", null)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    // One row beyond the page: its existence is what proves there is a next
    // page. See paginate().
    .limit(page.page.limit + 1);

  if (page.page.cursor) {
    // ONE .or() call, built whole. A second .or() on the same builder
    // REPLACES the first rather than AND-ing with it — this repo shipped that
    // bug to production once already (PR #35). keysetFilter is the only place
    // the disjunction is spelled.
    query = query.or(keysetFilter("last_message_at", page.page.cursor));
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[partner-api] v1 conversation listing failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }

  const { page: rows, nextCursor } = paginate(
    data ?? [],
    page.page.limit,
    // deno-lint-ignore no-explicit-any
    (row: any) => ({ timestamp: row.last_message_at, id: row.id }),
  );
  return v1Collection(rows.map(presentConversation), nextCursor, requestId);
}

/**
 * Load one conversation and prove the key may read it.
 *
 * Shared by the resource read and the message listing so the two cannot drift
 * into different answers about the same id — a `/messages` sub-resource that
 * checked the binding less strictly than its parent would be a tenancy hole
 * reachable by appending one path segment.
 */
async function loadBoundConversation(
  authed: V1AuthedContext,
  rawId: string,
): Promise<
  // deno-lint-ignore no-explicit-any
  { ok: true; row: any } | { ok: false; res: Response }
> {
  const { admin, record, requestId } = authed;

  const conversationId = decodeId("conv", rawId);
  if (conversationId === null) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return { ok: false, res: bound.res };
  if (bound.ids.length === 0) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }

  const { data, error } = await admin
    .from("messaging_cache")
    .select(CONVERSATION_COLUMNS)
    .eq("id", conversationId)
    .eq("workspace_id", record.workspaceId)
    // The binding filter is part of the LOOKUP, not a check applied to what
    // came back. A row fetched first and rejected second is one refactor away
    // from being returned by mistake; a row that was never selected cannot
    // be.
    .in("social_account_id", bound.ids)
    .maybeSingle();

  if (error) {
    console.error(`[partner-api] v1 conversation lookup failed (request ${requestId}):`, error);
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }
  if (!data) return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  if (data.platform !== READABLE_PLATFORM) {
    // Bound, and real — so not `resource_not_found`, which would deny a
    // resource the partner can see in `GET /v1/accounts`. This surface simply
    // has no per-message table for it. See the file header.
    return {
      ok: false,
      res: v1ErrorResponse("unsupported_capability", requestId, {
        message: `Conversations are readable for ${READABLE_PLATFORM} accounts only`,
      }),
    };
  }
  return { ok: true, row: data };
}

export async function getConversation(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const loaded = await loadBoundConversation(authed, params.id ?? "");
  if (!loaded.ok) return loaded.res;
  return v1JsonResponse(presentConversation(loaded.row), authed.requestId);
}

export async function listConversationMessages(
  req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, requestId } = authed;

  const page = readPageRequest(req, requestId);
  if (!page.ok) return page.res;

  const loaded = await loadBoundConversation(authed, params.id ?? "");
  if (!loaded.ok) return loaded.res;

  let query = admin
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    // BOTH predicates, and the second is not redundant. `whatsapp_messages`
    // has no workspace_id, and `messaging_cache` is unique on
    // (user_id, conversation_id) — so the same text conversation key can
    // exist for two different users. Filtering on the text key alone would
    // read another tenant's messages. The account id is what carries the
    // tenancy, because it is the value the binding proved.
    .eq("conversation_id", loaded.row.conversation_id)
    .eq("social_account_id", loaded.row.social_account_id)
    .order("timestamp", { ascending: false })
    .order("id", { ascending: false })
    .limit(page.page.limit + 1);

  if (page.page.cursor) {
    query = query.or(keysetFilter("timestamp", page.page.cursor));
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[partner-api] v1 message listing failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }

  const { page: rows, nextCursor } = paginate(
    data ?? [],
    page.page.limit,
    // deno-lint-ignore no-explicit-any
    (row: any) => ({ timestamp: row.timestamp, id: row.id }),
  );
  return v1Collection(
    // deno-lint-ignore no-explicit-any
    rows.map((row: any) => presentMessage(row, loaded.row.id)),
    nextCursor,
    requestId,
  );
}

/**
 * GET /v1/messages/{id}.
 *
 * Lives here rather than in messages.ts because it reads the conversation
 * tables, and because messages.ts owns the SEND path — the durable-dispatch
 * boundary D13 built. Keeping a read out of that file is deliberate: nothing
 * in this function should ever be able to reach a provider.
 */
export async function getMessage(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const messageId = decodeId("msg", params.id ?? "");
  if (messageId === null) return v1ErrorResponse("resource_not_found", requestId);

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  if (bound.ids.length === 0) return v1ErrorResponse("resource_not_found", requestId);

  const { data, error } = await admin
    .from("whatsapp_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", messageId)
    .in("social_account_id", bound.ids)
    .maybeSingle();

  if (error) {
    console.error(`[partner-api] v1 message lookup failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!data) return v1ErrorResponse("resource_not_found", requestId);

  // The message row carries only the TEXT conversation key, and /v1 never
  // publishes that (see the file header). Resolving it to the surrogate costs
  // one bounded lookup and is what lets a partner thread a single message
  // back to the conversation listing they already have.
  const { data: conversation } = await admin
    .from("messaging_cache")
    .select("id")
    .eq("conversation_id", data.conversation_id)
    .eq("social_account_id", data.social_account_id)
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();

  // Null when no cache row exists — a real state for a message whose
  // conversation was never cached. Reported as null rather than omitted, so
  // the field's presence does not vary between responses.
  return v1JsonResponse(presentMessage(data, conversation?.id ?? null), requestId);
}
