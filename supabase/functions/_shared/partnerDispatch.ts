// Partner send dispatch: the durable pre-call boundary, the takeover hard
// stop, and the settle ladder (D13, Phase 3 Stage 1, deliverables 3.2/3.3).
//
// Extracted from partner-api/index.ts so the SAME production path serves the
// frozen alias today and POST /v1/messages in Stage 2, and so the crash-test
// gate can drive it end to end through the Fetcher seam. The door keeps the
// response envelope; this module owns everything between "idempotency
// claimed" and "idempotency settled".
//
// ORDER OF OPERATIONS (each step's position is load-bearing):
//
//   1. reserve quota          -- a refused request must leave NO intent row,
//                                or an orphan `intended` would poison the
//                                key for a retry that never dispatched;
//   2. INSERT intent, COMMIT  -- 3.2: durable and visible to other
//                                connections BEFORE the provider call. A
//                                crash here leaves no row and the retry may
//                                safely dispatch (never-dispatched is
//                                resolvable);
//   3. sendTemplate           -- the ONLY provider call, including its
//                                internal register+retry double post(): that
//                                pair is ONE dispatch attempt under this ONE
//                                intent row (3.3's trap);
//   4. settle intent          -- always BEFORE the idempotency settle, so the
//                                intent row is never behind the request row
//                                a takeover would read;
//   5. settle idempotency     -- fenced on the attempt token from the claim.
//
// A takeover is any attempt whose intent INSERT conflicts: the previous
// attempt committed an intent, so the provider may already have been called.
// It NEVER calls the provider (invariant 1). What it returns depends on the
// row it found:
//
//   intended      -> CAS to `indeterminate` (the verdict only a takeover may
//                    write); respond 409 idempotency_indeterminate
//   indeterminate -> same 409 (already refused by an earlier takeover)
//   sent / reconciled_sent / failed
//                 -> the previous attempt recorded a DEFINITE outcome but
//                    died before settling the request row; replay that
//                    outcome verbatim. Replaying is not re-dispatching --
//                    the provider is never touched.

import { type PartnerKeyRecord } from "./partnerApiKeys.ts";
import {
  completeIdempotency,
  markIndeterminate,
} from "./partnerApiIdempotency.ts";
import { confirmQuota, indeterminateQuota, releaseQuota, reserveQuota } from "./partnerApiMetering.ts";
import {
  markIntentFailed,
  markIntentSent,
  recordDispatchIntent,
  takeoverIntentToIndeterminate,
  type DispatchIntentRow,
} from "./partnerDispatchIntents.ts";
import {
  sendMedia,
  sendTemplate,
  sendText,
  WhatsAppOpError,
  type Fetcher,
  type SendMediaInput,
  type SendResult,
  type SendTemplateInput,
  type SendTextInput,
  type WhatsAppOpsContext,
} from "./whatsappPartnerOps.ts";

export interface PartnerDispatchDeps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  record: PartnerKeyRecord;
  ctx: WhatsAppOpsContext;
  idempotencyKey: string;
  /** Held from the idempotency claim; fences every settle below. */
  attemptToken: string;
  input: PartnerSendInput;
  /** Injectable for the crash-test gate; defaults to global fetch. */
  fetcher?: Fetcher;
}

/**
 * What to send. A discriminated union rather than two dispatch functions,
 * because the whole point of D13 is that there is exactly ONE path from
 * "idempotency claimed" to "provider called" -- a second entry point is a
 * second place to forget the intent row, which is the duplicate this module
 * exists to prevent.
 */
export type PartnerSendInput =
  | ({ kind: "template" } & SendTemplateInput)
  | ({ kind: "text" } & SendTextInput)
  | ({ kind: "media" } & SendMediaInput);

/**
 * The only provider invocation in the partner surface. Both arms are reached
 * from step 3 below, under an already-committed intent row, and both stamp
 * that row's id as the correlator.
 *
 * Deliberately NOT exported: a route that could call this directly could call
 * it without an intent.
 */
function performSend(
  ctx: WhatsAppOpsContext,
  input: PartnerSendInput,
  intentId: string,
  fetcher?: Fetcher,
): Promise<SendResult> {
  if (input.kind === "text") {
    return sendText(ctx, { ...input, callbackData: intentId }, fetcher);
  }
  if (input.kind === "media") {
    return sendMedia(ctx, { ...input, callbackData: intentId }, fetcher);
  }
  return sendTemplate(ctx, { ...input, callbackData: intentId }, fetcher);
}

export interface PartnerSendSuccessBody {
  success: true;
  message_id: string;
  state: "accepted_by_meta";
  recorded_in_inbox: boolean;
}

export type PartnerDispatchResult =
  | { outcome: "sent"; body: PartnerSendSuccessBody }
  | { outcome: "failed"; httpStatus: number; errorCode: string; body: unknown }
  /** A stored outcome from a previous attempt, replayed verbatim. */
  | { outcome: "replayed"; httpStatus: number; body: unknown }
  /** Not resendable; the door answers 409 idempotency_indeterminate. */
  | { outcome: "indeterminate" };

/** The alias error envelope, mirrored from the door so STORED replay bodies
 *  are byte-identical to the ones the door builds live. Swept by
 *  contractConformance's source patterns — every literal code here is
 *  documented in docs/api/openapi.yaml. */
function errorBody(code: string, message: string, retryable: boolean, details?: unknown) {
  return { success: false, error: { code, message, retryable, ...(details ? { details } : {}) } };
}

/**
 * What the intent row records about the attempt, for the operator who has to
 * resolve a terminal `indeterminate` (D13 R3's named escalation path).
 *
 * Enough to identify the message; never the message ITSELF. A text body may
 * carry anything a partner's customer typed, and an intent row outlives key
 * deletion by design -- so the body stays out and only its length is kept.
 */
function summaryOf(input: PartnerSendInput): Record<string, unknown> {
  if (input.kind === "text") {
    return {
      recipient_phone: input.recipientPhone,
      message_type: "text",
      body_length: input.body.length,
    };
  }
  if (input.kind === "media") {
    return {
      recipient_phone: input.recipientPhone,
      message_type: input.mediaKind,
      // The media file this send referred to -- durable, and the thing an
      // operator reconciling an indeterminate intent actually needs.
      media_file_id: input.mediaFileId,
      caption_length: input.caption?.length ?? 0,
    };
  }
  return {
    recipient_phone: input.recipientPhone,
    message_type: "template",
    template_name: input.templateName,
    template_language: input.templateLanguage,
  };
}

export async function dispatchPartnerTemplate(
  deps: PartnerDispatchDeps,
): Promise<PartnerDispatchResult> {
  const { admin, record, ctx, idempotencyKey, attemptToken, input } = deps;

  // ---- 1. quota, before the intent: a refused request must not leave one --
  const reserved = await reserveQuota(admin, record);
  if (!reserved) {
    // reserve_partner_quota increments before it reports, so the refused
    // attempt gives its unit back, and the claim is settled so a retry sees
    // a clean quota error instead of `processing` forever.
    await releaseQuota(admin, record);
    const body = errorBody("quota_exceeded", "Monthly quota exhausted for this key", false);
    await completeIdempotency(admin, record.id, idempotencyKey, attemptToken, 429, body)
      .catch((e) => console.error("[partner-dispatch] settle after quota refusal failed:", e));
    return { outcome: "failed", httpStatus: 429, errorCode: "quota_exceeded", body };
  }

  // ---- 2. the durable pre-call boundary (3.2) + takeover check (3.3) ------
  let intent;
  try {
    intent = await recordDispatchIntent(admin, {
      keyId: record.id,
      workspaceId: ctx.workspaceId,
      socialAccountId: ctx.accountId,
      idempotencyKey,
      summary: summaryOf(input),
    });
  } catch (err) {
    // Nothing was dispatched and nothing will be: this attempt provably made
    // no provider call, so its own reservation goes back. The claim stays
    // `processing` and its lease expiry lets a later retry try again from a
    // clean slate (no intent row exists).
    await releaseQuota(admin, record);
    throw err;
  }

  if (intent.status === "existing") {
    return takeoverResolution(deps, intent.row);
  }

  // ---- 3. the provider call, under exactly one intent row ----------------
  try {
    const result = await performSend(ctx, input, intent.intentId, deps.fetcher);

    const body: PartnerSendSuccessBody = {
      success: true,
      message_id: result.messageId,
      state: "accepted_by_meta",
      recorded_in_inbox: result.persisted,
    };

    // Intent BEFORE idempotency, always: a crash between the two leaves a
    // row that says `sent` with the wamid and the replayable body, which is
    // precisely what the takeover above needs to replay instead of guessing.
    await markIntentSent(admin, intent.intentId, result.messageId, 200, body);
    await confirmQuota(admin, record);

    try {
      await completeIdempotency(admin, record.id, idempotencyKey, attemptToken, 200, body);
    } catch (settleError) {
      console.error("[partner-dispatch] settle failed after a successful send:", settleError);
      // `indeterminate` is the one state no retry will ever re-send from.
      await markIndeterminate(admin, record.id, idempotencyKey, attemptToken).catch(() => {});
    }
    return { outcome: "sent", body };
  } catch (err) {
    // ---- unknown outcome: indeterminate, never failed (invariant 5) -------
    // The intent row deliberately STAYS `intended`: only a takeover writes
    // `indeterminate` (decision record §2). The idempotency row carries the
    // partner-facing verdict, and a webhook carrying the intent id can still
    // reconcile this row later.
    if (!(err instanceof WhatsAppOpError)) {
      await indeterminateQuota(admin, record);
      await markIndeterminate(admin, record.id, idempotencyKey, attemptToken);
      return { outcome: "indeterminate" };
    }
    if (err.indeterminate) {
      await indeterminateQuota(admin, record);
      await markIndeterminate(admin, record.id, idempotencyKey, attemptToken)
        .catch((e) => console.error("[partner-dispatch] indeterminate mark failed:", e));
      return { outcome: "indeterminate" };
    }

    // ---- definite rejection: proof of non-delivery ------------------------
    const failure = errorBody(
      err.code, err.message, false,
      err.metaCode ? { meta_code: err.metaCode } : undefined,
    );
    await markIntentFailed(admin, intent.intentId, err.status, failure);
    // Quota is released ONLY here: a rejection proves nothing was delivered.
    await releaseQuota(admin, record);
    // Settling must not turn a clean rejection into a generic 500.
    await completeIdempotency(admin, record.id, idempotencyKey, attemptToken, err.status, failure)
      .catch((e) => console.error("[partner-dispatch] settle after rejection failed:", e));
    return { outcome: "failed", httpStatus: err.status, errorCode: err.code, body: failure };
  }
}

/**
 * What a takeover does with the intent row it found. It NEVER calls the
 * provider -- that is invariant 1, and the assertions in
 * partnerDispatch.crash.test.ts exist to fail if this ever regresses.
 */
async function takeoverResolution(
  deps: PartnerDispatchDeps,
  found: DispatchIntentRow,
): Promise<PartnerDispatchResult> {
  const { admin, record, idempotencyKey, attemptToken } = deps;

  let state = found.state;
  if (state === "intended") {
    // The previous attempt's outcome is unknown. This row now says so,
    // durably, and nothing will ever dispatch against this key again.
    state = await takeoverIntentToIndeterminate(admin, found.id);
  }

  if (state === "intended" || state === "indeterminate") {
    // This attempt provably made no provider call, so its own reservation is
    // released. The PREVIOUS attempt's unit deliberately is not: the message
    // may have been delivered, and indeterminate keeps its quota.
    await releaseQuota(admin, record);
    await markIndeterminate(admin, record.id, idempotencyKey, attemptToken);
    return { outcome: "indeterminate" };
  }

  // sent / reconciled_sent / failed: a definite, recorded outcome. Release
  // this attempt's reservation (again: no provider call was made), settle the
  // claim with the stored verdict so future retries replay it through the
  // claim path directly, and hand the stored body back for verbatim replay.
  await releaseQuota(admin, record);
  const httpStatus = found.http_status ?? 200;
  const body = found.response_body ?? replayFallback(found);
  await completeIdempotency(admin, record.id, idempotencyKey, attemptToken, httpStatus, body)
    .catch((e) => console.error("[partner-dispatch] settle after takeover replay failed:", e));
  return { outcome: "replayed", httpStatus, body };
}

/** Only reachable for `reconciled_sent` rows, which prove the send through a
 *  webhook and therefore carry a wamid but no stored partner response (the
 *  original attempt died before building one). `sent` and `failed` rows are
 *  guaranteed a stored body by the migration's
 *  partner_dispatch_intents_settled_names_outcome CHECK. */
function replayFallback(found: DispatchIntentRow): PartnerSendSuccessBody {
  return {
    success: true,
    message_id: found.wamid ?? found.id,
    state: "accepted_by_meta",
    // Unknown, honestly: the crashed attempt may or may not have recorded
    // the inbox row before dying. Reported conservatively.
    recorded_in_inbox: false,
  };
}
