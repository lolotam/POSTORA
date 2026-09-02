// Webhook subscription management (deliverables 5.6, 5.7).
//
// Design record: docs/decisions/2026-09-02-d5-webhook-substrate.md.
//
// THE TENANCY BOUNDARY IS THE WORKSPACE, NOT THE KEY -- deliberately.
//
// Every query below scopes by `workspace_id`, so a second key in the same
// workspace can read, update, rotate and delete a subscription this key
// created. That was raised in review as a possible privilege boundary, and it
// is a decision rather than an oversight:
//
//   * The workspace IS the tenant. Two keys in one workspace are one customer,
//     and a key holding `webhooks:manage` can already create its own
//     subscription and receive its own secret -- so key-scoping would not deny
//     it any capability, only the ability to disturb a sibling integration.
//   * Key-scoping would break D12. Credential rotation supersedes a key with a
//     new one; if subscriptions were key-owned, every rotation would strand
//     them, and rotation is meant to be routine.
//   * It matches Phase 4: partner media is workspace-owned for the same
//     reason, and a different answer here would mean two tenancy models one
//     directory apart.
//
// The residual risk is blast radius WITHIN a tenant: a compromised key can
// disrupt a sibling integration's webhooks. If that ever needs narrowing, the
// shape is a per-key subscription filter on the LIST and a `created_by_key_id`
// predicate on the mutations -- additive, and nothing here forecloses it.
//
// Every route here is class C, including the reads' siblings, because D7
// classifies by RISK and not by billability: a webhook test makes Postora
// issue an outbound request to a partner-supplied URL, which is SSRF
// amplification wearing a read's clothes. The two genuine reads (list, get)
// stay class A.

import { v1ErrorResponse } from "./errors.ts";
import { v1Collection, v1JsonResponse } from "./respond.ts";
import { decodeId, encodeId } from "./ids.ts";
import { boundAccountIds } from "./binding.ts";
import type { V1AuthedContext } from "./authenticated.ts";
import { validateWebhookTarget } from "../../_shared/webhookSecurity.ts";
import {
  CERTIFIED_EVENT_TYPES,
  type CertifiedEventType,
  enqueuePartnerWebhookEvent,
  isCertifiedEventType,
} from "../../_shared/partnerWebhookEvents.ts";

/** The one place a subscription secret is minted. */
const SECRET_BYTES = 32;

/**
 * How long the previous secret keeps verifying after a rotation.
 *
 * A full retry ladder is 1m + 5m + 30m + 2h + 6h ~= 8h36m from the first
 * attempt, so 24h covers every in-flight delivery with margin while still
 * bounding how long a leaked secret stays live.
 */
const SECRET_OVERLAP_HOURS = 24;

const SUPPORTED_PLATFORMS = ["whatsapp"];

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  platform: string | null;
  social_account_id: string | null;
  secret_version: number;
  is_active: boolean;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
}

const WEBHOOK_COLUMNS =
  "id, url, events, platform, social_account_id, secret_version, is_active, " +
  "consecutive_failures, last_success_at, last_failure_at, last_error, " +
  "disabled_at, disabled_reason, created_at";

/**
 * The partner-facing shape. The SECRET IS NEVER IN IT: it is returned exactly
 * twice in a subscription's life, by create and by rotate, and a read that
 * could hand it back would make every `webhooks:read` grant a credential
 * grant.
 */
function present(row: WebhookRow): Record<string, unknown> {
  return {
    id: encodeId("wh", row.id),
    url: row.url,
    events: row.events,
    platform: row.platform,
    account_id: row.social_account_id ? encodeId("acc", row.social_account_id) : null,
    is_active: row.is_active,
    secret_version: row.secret_version,
    health: {
      consecutive_failures: row.consecutive_failures,
      last_success_at: row.last_success_at,
      last_failure_at: row.last_failure_at,
      last_error: row.last_error,
      disabled_at: row.disabled_at,
      disabled_reason: row.disabled_reason,
    },
    created_at: row.created_at,
  };
}

function mintSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return `whsec_${
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }`;
}

type Invalid = { ok: false; res: Response };
type Valid<T> = { ok: true; value: T };

interface WebhookInput {
  url: string;
  events: CertifiedEventType[];
  platform: string | null;
  accountId: string | null;
}

function invalid(requestId: string, message: string): Invalid {
  return { ok: false, res: v1ErrorResponse("invalid_request", requestId, { message }) };
}

/**
 * Validate the fields common to create and update.
 *
 * `partial` lets PATCH omit a field without it reading as "clear it" -- the
 * caller decides which absences are legal, this decides what a PRESENT value
 * must look like.
 */
function readWebhookFields(
  body: Record<string, unknown>,
  requestId: string,
  partial: boolean,
): Valid<Partial<WebhookInput>> | Invalid {
  const out: Partial<WebhookInput> = {};

  if (body.url !== undefined) {
    if (typeof body.url !== "string") return invalid(requestId, "url must be a string");
    // The SAME validator the delivery path revalidates with on every redirect
    // hop, applied at registration so an unusable target is refused where the
    // partner can see it rather than accumulating failed deliveries.
    const rejection = validateWebhookTarget(body.url);
    if (rejection) return invalid(requestId, "url must be a public HTTPS URL");
    out.url = body.url;
  } else if (!partial) {
    return invalid(requestId, "url is required");
  }

  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      return invalid(requestId, "events must be a non-empty array");
    }
    const events: CertifiedEventType[] = [];
    for (const event of body.events) {
      if (typeof event !== "string" || !isCertifiedEventType(event)) {
        // The list is named in the message on purpose. A closed allowlist that
        // refuses without saying what it accepts turns a typo and an
        // uncertified event into the same opaque 400.
        return invalid(
          requestId,
          `events may only contain: ${CERTIFIED_EVENT_TYPES.join(", ")}`,
        );
      }
      events.push(event);
    }
    out.events = events;
  } else if (!partial) {
    return invalid(requestId, "events is required");
  }

  if (body.platform !== undefined && body.platform !== null) {
    if (typeof body.platform !== "string" || !SUPPORTED_PLATFORMS.includes(body.platform)) {
      return invalid(requestId, `platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`);
    }
    out.platform = body.platform;
  } else if (body.platform === null) {
    out.platform = null;
  }

  return { ok: true, value: out };
}

/**
 * Resolve an optional `account_id` filter against the key's bindings.
 *
 * An id naming an account this key is not bound to answers
 * `resource_not_found`, not a permission error -- D11's rule, and the reason
 * is that `resource_forbidden` would confirm the account exists.
 */
async function resolveAccountFilter(
  authed: V1AuthedContext,
  raw: unknown,
): Promise<Valid<string | null> | Invalid> {
  const { requestId } = authed;
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return invalid(requestId, "account_id must be a string");

  const accountId = decodeId("acc", raw);
  if (accountId === null) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return { ok: false, res: bound.res };
  if (!bound.ids.includes(accountId)) {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  return { ok: true, value: accountId };
}

/** Load one subscription, scoped to the caller's workspace. */
async function loadWebhook(
  authed: V1AuthedContext,
  webhookId: string,
): Promise<
  | { outcome: "found"; row: WebhookRow }
  | { outcome: "missing" }
  | { outcome: "error" }
> {
  const { data, error } = await authed.admin
    .from("partner_webhooks")
    .select(WEBHOOK_COLUMNS)
    .eq("id", webhookId)
    .eq("workspace_id", authed.record.workspaceId)
    .maybeSingle();

  // An error is NOT an absence. `resource_not_found` is non-retryable, so
  // answering it during a database blip tells a partner to stop retrying
  // something that exists and is theirs.
  if (error) {
    console.error(`[partner-api] webhook lookup failed (request ${authed.requestId}):`, error);
    return { outcome: "error" };
  }
  if (!data) return { outcome: "missing" };
  return { outcome: "found", row: data as WebhookRow };
}

/** The id in the path, or the refusal to answer with. */
function pathWebhookId(
  params: Record<string, string>,
  requestId: string,
): Valid<string> | Invalid {
  const webhookId = decodeId("wh", params.id ?? "");
  if (webhookId === null) {
    // A malformed id and an unknown one answer identically -- otherwise the
    // difference tells a prober which of their guesses had the right shape.
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  return { ok: true, value: webhookId };
}

// ---------------------------------------------------------------------------
// GET /v1/webhooks
// ---------------------------------------------------------------------------
export async function listWebhooks(
  _req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const { data, error } = await admin
    .from("partner_webhooks")
    .select(WEBHOOK_COLUMNS)
    .eq("workspace_id", record.workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error(`[partner-api] webhook listing failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }

  // next_cursor is null rather than absent: subscriptions are few enough that
  // this listing is not paginated, and a client's "loop while next_cursor is
  // not null" must still terminate correctly here.
  return v1Collection((data ?? []).map((row: WebhookRow) => present(row)), null, requestId);
}

// ---------------------------------------------------------------------------
// POST /v1/webhooks
// ---------------------------------------------------------------------------
export async function createWebhook(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return v1ErrorResponse("invalid_request", requestId);
  }

  const fields = readWebhookFields(body as Record<string, unknown>, requestId, false);
  if (!fields.ok) return fields.res;

  const account = await resolveAccountFilter(authed, (body as Record<string, unknown>).account_id);
  if (!account.ok) return account.res;

  const secret = mintSecret();
  const { data, error } = await admin
    .from("partner_webhooks")
    .insert({
      workspace_id: record.workspaceId,
      created_by_key_id: record.id,
      url: fields.value.url,
      events: fields.value.events,
      platform: fields.value.platform ?? null,
      social_account_id: account.value,
      secret,
      secret_version: 1,
    })
    .select(WEBHOOK_COLUMNS)
    .maybeSingle();

  if (error || !data) {
    console.error(`[partner-api] webhook create failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }

  // No Idempotency-Key requirement, unlike a send, and the difference is what
  // a duplicate COSTS. A duplicated message reaches a customer and cannot be
  // recalled; a duplicated subscription is a visible row the partner can list
  // and delete. Demanding the header here would be ceremony that buys nothing.
  return v1JsonResponse({ ...present(data as WebhookRow), secret }, requestId, 201);
}

// ---------------------------------------------------------------------------
// GET /v1/webhooks/{id}
// ---------------------------------------------------------------------------
export async function getWebhook(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const id = pathWebhookId(params, authed.requestId);
  if (!id.ok) return id.res;

  const loaded = await loadWebhook(authed, id.value);
  if (loaded.outcome === "error") return v1ErrorResponse("internal_error", authed.requestId);
  if (loaded.outcome === "missing") {
    return v1ErrorResponse("resource_not_found", authed.requestId);
  }
  return v1JsonResponse(present(loaded.row), authed.requestId);
}

// ---------------------------------------------------------------------------
// PATCH /v1/webhooks/{id}
// ---------------------------------------------------------------------------
export async function updateWebhook(
  req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const id = pathWebhookId(params, requestId);
  if (!id.ok) return id.res;

  const body = await req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return v1ErrorResponse("invalid_request", requestId);
  }
  const fields = readWebhookFields(body as Record<string, unknown>, requestId, true);
  if (!fields.ok) return fields.res;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.value.url !== undefined) patch.url = fields.value.url;
  if (fields.value.events !== undefined) patch.events = fields.value.events;
  if (fields.value.platform !== undefined) patch.platform = fields.value.platform;

  const raw = body as Record<string, unknown>;
  if (raw.account_id !== undefined) {
    const account = await resolveAccountFilter(authed, raw.account_id);
    if (!account.ok) return account.res;
    patch.social_account_id = account.value;
  }

  if (raw.is_active !== undefined) {
    if (typeof raw.is_active !== "boolean") {
      return invalid(requestId, "is_active must be a boolean").res;
    }
    patch.is_active = raw.is_active;
    // Re-enabling is how a partner recovers an endpoint the ladder disabled,
    // so the disabled reason must be cleared with it -- otherwise the next
    // reader sees an active subscription still claiming it was disabled.
    if (raw.is_active) {
      patch.disabled_at = null;
      patch.disabled_reason = null;
      patch.consecutive_failures = 0;
    }
  }

  const { data, error } = await admin
    .from("partner_webhooks")
    .update(patch)
    .eq("id", id.value)
    .eq("workspace_id", record.workspaceId)
    .select(WEBHOOK_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error(`[partner-api] webhook update failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!data) return v1ErrorResponse("resource_not_found", requestId);
  return v1JsonResponse(present(data as WebhookRow), requestId);
}

// ---------------------------------------------------------------------------
// DELETE /v1/webhooks/{id}
// ---------------------------------------------------------------------------
export async function deleteWebhook(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const id = pathWebhookId(params, requestId);
  if (!id.ok) return id.res;

  // Undelivered rows go with it (ON DELETE CASCADE). That is the right
  // reading of a deletion: a partner who removed a subscription is not owed
  // its backlog, and keeping the rows would leave an outbox the worker skips
  // forever because the claim joins to a webhook that no longer exists.
  const { data, error } = await admin
    .from("partner_webhooks")
    .delete()
    .eq("id", id.value)
    .eq("workspace_id", record.workspaceId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(`[partner-api] webhook delete failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!data) return v1ErrorResponse("resource_not_found", requestId);
  return new Response(null, { status: 204, headers: { "X-Postora-Request-Id": requestId } });
}

// ---------------------------------------------------------------------------
// POST /v1/webhooks/{id}/rotate-secret
// ---------------------------------------------------------------------------
export async function rotateWebhookSecret(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const id = pathWebhookId(params, requestId);
  if (!id.ok) return id.res;

  const secret = mintSecret();

  // ONE statement, under a row lock, because read-then-update loses a race:
  // two overlapping rotations both read version n and both write n+1, and the
  // secret the FIRST caller was told to deploy is then neither current nor
  // previous. It verifies nothing, during the very overlap the rotation
  // promised, and that partner's only way to find out is their deliveries
  // failing.
  //
  // Folding the read in also removes the separate secret lookup, whose
  // discarded error turned a transient read failure into a NULL
  // previous_secret written beside a non-null version and expiry -- surfacing
  // as a confusing CHECK violation instead of as the read failure it was.
  //
  // The old secret keeps verifying for the overlap: rotating without one
  // breaks every receiver between the moment the rotation lands and the moment
  // they finish deploying the new value, which would make rotation an outage
  // and so make nobody rotate.
  const { data, error } = await admin.rpc("rotate_partner_webhook_secret", {
    p_webhook_id: id.value,
    p_workspace_id: record.workspaceId,
    p_new_secret: secret,
    p_overlap_hours: SECRET_OVERLAP_HOURS,
  });

  if (error) {
    console.error(`[partner-api] webhook rotate failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  // A set-returning function reaches supabase-js as an ARRAY even for one row.
  // Zero rows means the id is not this workspace's -- the same answer an id
  // that never existed gets.
  const rotated = (Array.isArray(data) ? data[0] : data) as
    | (WebhookRow & { previous_secret_expires_at: string })
    | undefined;
  if (!rotated) return v1ErrorResponse("resource_not_found", requestId);

  await recordRotation(authed, id.value);

  return v1JsonResponse({
    ...present(rotated),
    secret,
    previous_secret_expires_at: rotated.previous_secret_expires_at,
  }, requestId);
}

/** D12's audit trail. A rotation that leaves no record is indistinguishable
 *  from a compromise, which is the one thing an audit log exists to separate. */
async function recordRotation(authed: V1AuthedContext, webhookId: string): Promise<void> {
  const { error } = await authed.admin.from("partner_audit_logs").insert({
    workspace_id: authed.record.workspaceId,
    key_id: authed.record.id,
    action: "rotate",
    request_id: authed.requestId,
    metadata: { target: "partner_webhook", webhook_id: webhookId },
  });
  if (error) {
    // Logged, not fatal: the rotation itself has already committed, and
    // failing the response now would tell the partner their new secret does
    // not exist when it does.
    console.error(`[partner-api] webhook rotation audit write failed:`, error);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/webhooks/{id}/test  (deliverable 5.7)
// ---------------------------------------------------------------------------
export async function testWebhook(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const id = pathWebhookId(params, requestId);
  if (!id.ok) return id.res;

  const loaded = await loadWebhook(authed, id.value);
  if (loaded.outcome === "error") return v1ErrorResponse("internal_error", requestId);
  if (loaded.outcome === "missing") return v1ErrorResponse("resource_not_found", requestId);
  const webhook = loaded.row;

  if (!webhook.is_active) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "This webhook is disabled; re-enable it before sending a test",
    });
  }
  if (!webhook.events.includes("webhook.test")) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "This webhook is not subscribed to webhook.test",
    });
  }

  // A manual trigger has no natural resource key, and two tests are genuinely
  // two occurrences -- so the id is minted per request rather than derived.
  // This is the one event this phase certifies, and it is certifiable exactly
  // because there is no state change to crash between: the enqueue below IS
  // the transition.
  const occurrenceId = `webhook.test:${crypto.randomUUID()}`;
  try {
    await enqueuePartnerWebhookEvent(admin, {
      workspaceId: record.workspaceId,
      eventType: "webhook.test",
      occurrenceId,
      payload: {
        type: "webhook.test",
        webhook_id: encodeId("wh", webhook.id),
        requested_at: new Date().toISOString(),
      },
      platform: webhook.platform,
      accountId: webhook.social_account_id,
      // ONE subscription: this is a request to exercise {id}, not an event
      // that happened in the world. Without it a partner testing endpoint A
      // posts that test to every other compatible subscription in the
      // workspace, then reads what arrives at B as evidence about A.
      restrictToWebhookId: webhook.id,
    });
  } catch (err) {
    console.error(`[partner-api] webhook test enqueue failed (request ${requestId}):`, err);
    return v1ErrorResponse("internal_error", requestId);
  }

  // 202, not 200: the event is DURABLY QUEUED, not delivered. Answering 200
  // would claim an outcome the outbox exists precisely because Postora cannot
  // yet know -- the worker delivers on its own cadence and its own ladder.
  return v1JsonResponse({ status: "queued", occurrence_id: occurrenceId }, requestId, 202);
}
