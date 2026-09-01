// POST /v1/messages — text and template sends (deliverable 3.5).
//
// Attachments are NOT here: they need Phase 4's media controls, and shipping
// an interim media contract now would freeze a shape Phase 4 has to break.
//
// EVERY SEND GOES THROUGH `dispatchPartnerTemplate`. That is not a stylistic
// preference — it is the D13 safety property. That function owns the durable
// pre-call intent, the takeover hard stop, and the settle ladder. A route that
// called `sendText` or `sendTemplate` directly would have no intent row, and a
// crash mid-call would let a retry send the customer a SECOND REAL MESSAGE —
// exactly the defect Phase 3 Stage 1 closed. `performSend` is deliberately not
// exported from partnerDispatch.ts so this cannot be done by accident.

import { claimIdempotency, hashRequest } from "../../_shared/partnerApiIdempotency.ts";
import { dispatchPartnerTemplate, type PartnerSendInput } from "../../_shared/partnerDispatch.ts";
import { isActionSuspended } from "../router.ts";
import { v1ErrorResponse, type V1ErrorCode } from "./errors.ts";
import { resolveWhatsAppAccount, type V1AuthedContext } from "./authenticated.ts";

/** The message types this endpoint can carry today. Anything else is
 *  `unsupported_capability` — a permanent, non-retryable "that does not
 *  exist", distinct from a permission problem or an outage. */
const SUPPORTED_TYPES = new Set(["text", "template"]);

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Postora-Request-Id": requestId,
    },
  });
}

export async function postMessages(
  req: Request,
  authed: V1AuthedContext,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "A JSON object body is required",
    });
  }
  const payload = body as Record<string, unknown>;
  const type = String(payload.type ?? "");

  // Capability BEFORE the suspension check: "this type does not exist" is a
  // permanent fact about the request, while the suspension is a temporary
  // fact about the platform. Answering `temporarily_unavailable` to a
  // misspelled type would send a partner away to wait for something that will
  // never work.
  if (!SUPPORTED_TYPES.has(type)) {
    return v1ErrorResponse("unsupported_capability", requestId, {
      message: `Message type "${type || "(missing)"}" is not supported`,
      details: { supported_types: [...SUPPORTED_TYPES] },
    });
  }

  // The 0A safety suspension applies to /v1 exactly as it applies to the
  // alias, and through the SAME flag. Restoration must open both surfaces
  // with one deliberate decision rather than leaving /v1 quietly open.
  // Checked after the scope gate in withPartnerAuth, preserving the alias's
  // ordering: a key lacking the scope still gets `insufficient_scope`.
  if (type === "template" && isActionSuspended("send_template")) {
    return v1ErrorResponse("temporarily_unavailable", requestId);
  }

  const recipient = String(payload.recipient_phone ?? "");
  if (!recipient) {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "recipient_phone is required",
    });
  }

  let input: PartnerSendInput;
  if (type === "text") {
    const text = payload.text;
    const textBody = typeof text === "object" && text !== null
      ? String((text as Record<string, unknown>).body ?? "")
      : "";
    if (!textBody) {
      return v1ErrorResponse("invalid_request", requestId, {
        message: "text.body is required for a text message",
      });
    }
    input = { kind: "text", recipientPhone: recipient, body: textBody };
  } else {
    const template = payload.template;
    const t = typeof template === "object" && template !== null
      ? template as Record<string, unknown>
      : {};
    const name = String(t.name ?? "");
    if (!name) {
      return v1ErrorResponse("invalid_request", requestId, {
        message: "template.name is required for a template message",
      });
    }
    input = {
      kind: "template",
      recipientPhone: recipient,
      templateName: name,
      templateLanguage: String(t.language ?? "en_US"),
      components: Array.isArray(t.components) ? t.components : undefined,
    };
  }

  // Sends cost money and reach a real customer, so the key is REQUIRED — the
  // same rule the alias applies. Without it there is nothing to make the
  // retry safe, and D13's whole boundary hangs off it.
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return v1ErrorResponse("missing_idempotency_key", requestId);
  }

  const account = await resolveWhatsAppAccount(authed);
  if (!account.ok) return account.res;

  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest(input),
  );

  if (claim.outcome === "conflict") return v1ErrorResponse("idempotency_conflict", requestId);
  if (claim.outcome === "in_progress") return v1ErrorResponse("idempotency_in_progress", requestId);
  if (claim.outcome === "indeterminate") {
    return v1ErrorResponse("idempotency_indeterminate", requestId);
  }
  if (claim.outcome === "replay") {
    // A settled outcome from a previous attempt. Replaying is not
    // re-dispatching; the provider is never touched.
    return json(claim.body, claim.httpStatus, requestId);
  }

  const dispatched = await dispatchPartnerTemplate({
    admin,
    record,
    ctx: account.ctx,
    idempotencyKey,
    attemptToken: claim.attemptToken,
    input,
  });

  switch (dispatched.outcome) {
    case "sent":
      return json(dispatched.body, 200, requestId);
    case "replayed":
      return json(dispatched.body, dispatched.httpStatus, requestId);
    case "indeterminate":
      // Terminal, and never advertised as retryable (D13 R3).
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    case "failed":
      // The dispatch core already produced the alias-shaped body; /v1 restates
      // the typed code in its own envelope rather than forwarding a foreign
      // shape (D2 — the two envelopes differ on purpose).
      return v1ErrorResponse(dispatched.errorCode as V1ErrorCode, requestId);
  }
}
