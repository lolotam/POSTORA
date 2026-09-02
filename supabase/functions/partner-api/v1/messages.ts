// POST /v1/messages — text, template and media sends (3.5, and Phase 4's 4.5).
//
// Media arrived in Phase 4, behind the D10 control matrix
// (docs/decisions/2026-09-01-d10-media-control-matrix.md). A send never
// carries bytes: it names a `media_id` that POST /v1/media already sniffed,
// sized and stored. There is deliberately NO `link` passthrough — a
// partner-supplied URL would route around every control in that matrix and
// hand Meta something nobody validated.
//
// EVERY SEND GOES THROUGH `dispatchPartnerTemplate`. That is not a stylistic
// preference — it is the D13 safety property. That function owns the durable
// pre-call intent, the takeover hard stop, and the settle ladder. A route that
// called `sendText` or `sendTemplate` directly would have no intent row, and a
// crash mid-call would let a retry send the customer a SECOND REAL MESSAGE —
// exactly the defect Phase 3 Stage 1 closed. `performSend` is deliberately not
// exported from partnerDispatch.ts so this cannot be done by accident.
//
// Before ANY of that, the 9.2 capability matrix is consulted at the door
// (partnerMessagingCapabilities.ts): a connection mode × message type cell
// that can never be sent is refused before the media row is read, before a
// URL is minted, before a key is claimed and before an intent exists.

import { claimIdempotency, hashRequest } from "../../_shared/partnerApiIdempotency.ts";
import { dispatchPartnerTemplate, type PartnerSendInput } from "../../_shared/partnerDispatch.ts";
import { loadPartnerMedia, mediaSendability, signPartnerMediaUrl } from "../../_shared/partnerMediaStore.ts";
import { partnerMessagingCapability, type PartnerMessageType } from "../../_shared/partnerMessagingCapabilities.ts";
import { assertActionAuthorized, PartnerAuthError } from "../../_shared/partnerApiKeys.ts";
import { isActionSuspended, satisfyingScopesFor } from "../router.ts";
import { decodeId } from "./ids.ts";
import { v1ErrorResponse, type V1ErrorCode } from "./errors.ts";
import { resolveWhatsAppAccount, type V1AuthedContext } from "./authenticated.ts";

/** The media message types, which are also WhatsApp's own type names and the
 *  `file_type` stored on the media row — one vocabulary, so a mismatch is a
 *  comparison rather than a mapping table. */
const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

/** The message types this endpoint can carry today. Anything else is
 *  `unsupported_capability` — a permanent, non-retryable "that does not
 *  exist", distinct from a permission problem or an outage. */
const SUPPORTED_TYPES = new Set(["text", "template", ...MEDIA_TYPES]);

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Postora-Request-Id": requestId,
    },
  });
}

/**
 * The parts of a send that identify the REQUEST, for the idempotency hash.
 *
 * For text and template that is the whole input. For media it is emphatically
 * not: `mediaUrl` is a freshly signed URL whose token and expiry differ on
 * every mint, so hashing the input would give the same logical send a
 * different hash each time. A partner retrying with the same Idempotency-Key
 * -- the exact behaviour the header exists to make safe -- would get
 * `idempotency_conflict` instead of a replay, and the D13 guarantee would be
 * unreachable for every media send.
 *
 * So the basis is the caller-controlled fields only: what they asked for, not
 * what we minted to satisfy it.
 */
function idempotencyBasisOf(input: PartnerSendInput): unknown {
  if (input.kind !== "media") return input;
  const { mediaUrl: _signed, ...stable } = input;
  return stable;
}

/**
 * Turn a `media_id` into a send input, or the refusal to answer with.
 *
 * Four checks, in this order, and the order is the contract:
 *
 *   1. The id is well-formed. A malformed one 404s without a query, so a typo
 *      is neither a 500 nor an existence oracle (ids.ts).
 *   2. The row exists IN THIS KEY'S WORKSPACE. `loadPartnerMedia` puts the
 *      workspace in the lookup, not in a check afterwards, so a media_id
 *      belonging to another tenant is indistinguishable from one that never
 *      existed. This is the tenancy boundary of the whole phase: without it a
 *      partner could send another workspace's files to their own customers.
 *   3. The requested type matches what the file actually IS — established by
 *      sniffing at upload time, not by anything the partner has said since.
 *   4. The file is SENDABLE — its scan_state is neither `pending` nor
 *      `rejected` (9.3). Applied BEFORE the URL is minted, same rule as the
 *      9.2 door: a refused file must not produce a live read capability.
 */
async function buildMediaSend(
  authed: V1AuthedContext,
  payload: Record<string, unknown>,
  recipient: string,
  type: string,
): Promise<{ ok: true; input: PartnerSendInput } | { ok: false; res: Response }> {
  const { admin, record, requestId } = authed;

  const rawId = String(payload.media_id ?? "");
  const mediaId = decodeId("media", rawId);
  if (mediaId === null) return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };

  const caption = typeof payload.caption === "string" ? payload.caption : undefined;
  // WhatsApp rejects a caption on an audio message. Refusing here names the
  // real problem; letting it through would surface as a Meta error about a
  // field the partner did not knowingly set.
  if (type === "audio" && caption) {
    return {
      ok: false,
      res: v1ErrorResponse("invalid_request", requestId, {
        message: "Audio messages cannot carry a caption",
      }),
    };
  }

  const loaded = await loadPartnerMedia(admin, record.workspaceId, mediaId);
  // An error is not an absence: `resource_not_found` is non-retryable, so
  // answering it during a database blip tells a partner to stop retrying a
  // file that exists and is theirs.
  if (loaded.outcome === "error") {
    return { ok: false, res: v1ErrorResponse("internal_error", requestId) };
  }
  if (loaded.outcome === "missing") {
    return { ok: false, res: v1ErrorResponse("resource_not_found", requestId) };
  }
  const stored = loaded.media;

  if (stored.kind !== type) {
    return {
      ok: false,
      res: v1ErrorResponse("invalid_request", requestId, {
        message: `That media file is ${stored.kind}, not ${type}`,
      }),
    };
  }

  // 9.3: the scan-state gate, via the ONE shared rule so every send path
  // (this route today, the publishing route when it lands) refuses the same
  // rows for the same reasons. `pending` is retryable — the state is
  // expected to change on its own once a scanner exists; `rejected` never
  // is. Both come before the URL: a refused file must not mint one.
  const sendability = mediaSendability(stored);
  if (!sendability.ok) {
    return {
      ok: false,
      res: v1ErrorResponse(sendability.code, requestId, { message: sendability.message }),
    };
  }

  // Minted last, and only once everything else has passed: the URL is a live
  // read capability, so it should not exist for a request that was going to be
  // refused anyway.
  const mediaUrl = await signPartnerMediaUrl(admin, stored.filePath);
  if (!mediaUrl) return { ok: false, res: v1ErrorResponse("internal_error", requestId) };

  return {
    ok: true,
    input: {
      kind: "media",
      recipientPhone: recipient,
      mediaUrl,
      mediaKind: type as "image" | "video" | "audio" | "document",
      caption,
      filename: typeof payload.filename === "string" ? payload.filename : undefined,
      mediaFileId: stored.id,
    },
  };
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

  // ---- PER-TYPE SCOPE, and why the route-level check is not enough ----
  //
  // The route is authorised as `send_template`, whose satisfying set is
  // ["whatsapp:template.send", "messages:send"] -- so a key holding ONLY the
  // frozen legacy scope reaches this handler. That scope authorises approved
  // TEMPLATE sending and nothing else (D3), yet without this check it would
  // also buy unsuspended free-form text and media session sends: a credential
  // silently gaining authority its holder never asked for, which is exactly
  // the escalation D3 was rewritten to prevent, arriving through a different
  // door.
  //
  // The text half of this predates Phase 4 -- it landed with 3.5 -- and is
  // fixed here rather than left, because leaving one escalated while fixing
  // the other would be indefensible and it is the same line of code. No
  // partner is affected: there are zero active legacy-scoped keys.
  const typeAction = type === "template"
    ? "send_template"
    : (MEDIA_TYPES.has(type) ? "send_media" : "send_text");
  const satisfying = satisfyingScopesFor(typeAction);
  if (satisfying === undefined) {
    console.error(`[partner-api] v1 message type "${type}" declares unknown action "${typeAction}"`);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (satisfying !== null) {
    try {
      assertActionAuthorized(record, typeAction, satisfying);
    } catch (err) {
      if (err instanceof PartnerAuthError) {
        return v1ErrorResponse(err.code as V1ErrorCode, requestId);
      }
      throw err;
    }
  }

  // ---- 9.2: the capability matrix, decided AT THE DOOR ---------------------
  //
  // Applied BEFORE the template suspension below: a QR-mode account can
  // NEVER carry a template, and `temporarily_unavailable` would tell the
  // partner to wait for something that will never work -- the same
  // permanent-before-temporary rule the type check above follows.
  //
  // The account is resolved HERE — earlier than it used to be — because the
  // matrix needs its connection_mode, and because the refusal must precede
  // every side effect this route can produce. The old order answered a media
  // send to a QR-mode account only from the deep guard in sendMedia, AFTER
  // the media row was loaded, a signed URL minted, an idempotency key
  // claimed and a dispatch intent recorded. A request that was always going
  // to be refused had already spent a key and created a live read
  // capability.
  //
  // QR-mode refusals keep `unsupported_direct_qr` (the account's connection
  // is the problem — errors.ts pins that vocabulary); the deep guards in
  // whatsappPartnerOps stay as defence in depth for every other caller.
  const account = await resolveWhatsAppAccount(authed);
  if (!account.ok) return account.res;

  const capability = partnerMessagingCapability(
    account.ctx.connectionMode,
    type as PartnerMessageType,
  );
  if (!capability.supported) {
    return v1ErrorResponse(capability.code, requestId, {
      message: capability.message,
      details: { connection_mode: account.ctx.connectionMode, type },
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
  if (MEDIA_TYPES.has(type)) {
    const media = await buildMediaSend(authed, payload, recipient, type);
    if (!media.ok) return media.res;
    input = media.input;
  } else if (type === "text") {
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

  const claim = await claimIdempotency(
    admin,
    record.id,
    idempotencyKey,
    await hashRequest(idempotencyBasisOf(input)),
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
