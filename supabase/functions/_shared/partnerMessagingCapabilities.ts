// The partner messaging capability matrix (Phase 9.2).
//
// ONE place answers "can this account, in its connection mode, carry this
// message type?" — answered AT THE DOOR, before any side effect. Before this
// module existed, a media send to a QR-mode account loaded the media row,
// MINTED A SIGNED STORAGE URL (a live read capability), claimed an
// idempotency key and recorded a dispatch intent, and only then did the deep
// guard in whatsappPartnerOps.sendMedia throw `unsupported_direct_qr`. A
// request that was always going to be refused had already produced a URL and
// consumed a key.
//
// The deep guards in whatsappPartnerOps.ts STAY, as defence in depth: the
// alias (messaging-api door) does not consult this matrix, and a future
// caller must not be able to reach the provider by forgetting the door
// check. This matrix is the early, side-effect-free refusal; those are the
// late, provider-adjacent one.
//
// EVERY CELL IS EXPLICIT. There is no default branch that guesses: the
// Record types below make a missing cell a TYPE ERROR under `deno check`
// (which is why CI running --no-check makes the unit test's exhaustive walk
// load-bearing as well), and a connection_mode string outside the column's
// CHECK vocabulary is refused — never waved through on the assumption that
// it probably means Cloud API. An explicit "no" costs a partner a support
// ticket; an implicit "yes" that dies at Meta is the opaque failure Phase
// 9's exit criterion forbids.

/** Exactly the values social_accounts_connection_mode_chk permits for a
 *  whatsapp row (20260821090000), plus the null the same constraint lets
 *  through — a CHECK treats NULL as satisfied, and the column predates the
 *  mode vocabulary, so null is representable even though every migration
 *  path backfills or defaults to 'cloud_api'. */
export type PartnerConnectionMode = "cloud_api" | "coexistence" | "evolution_qr" | null;

/** The message types POST /v1/messages can be asked to carry. Kept in one
 *  vocabulary with the route's SUPPORTED_TYPES: the route validates the type
 *  first, so anything reaching the matrix is one of these six. */
export type PartnerMessageType =
  | "text"
  | "template"
  | "image"
  | "video"
  | "audio"
  | "document";

/** The two shapes a cell can take. There is no third. */
export type MessagingCapability =
  | { supported: true }
  | { supported: false; code: "unsupported_direct_qr" | "unsupported_capability"; message: string };

const OK: MessagingCapability = { supported: true };

/** QR-mode refusals keep `unsupported_direct_qr`, not `unsupported_capability`:
 *  the problem is the ACCOUNT's connection, not the request's shape — errors.ts
 *  pins that distinction and the alias has emitted this code for years. */
function qr(message: string): MessagingCapability {
  return { supported: false, code: "unsupported_direct_qr", message };
}

// The matrix itself. Each row is spelled out per type — no shared "all
// supported" spread — so adding a seventh message type fails to compile
// rather than silently inheriting a row it was never reviewed for.
const MODE_MATRIX: Record<
  Exclude<PartnerConnectionMode, null>,
  Record<PartnerMessageType, MessagingCapability>
> = {
  // cloud_api: the mode this surface was built on. Every send op in
  // whatsappPartnerOps is Graph API shape and a cloud_api account is
  // registered there by definition.
  cloud_api: {
    text: OK,
    template: OK,
    image: OK,
    video: OK,
    audio: OK,
    document: OK,
  },
  // coexistence: also a Cloud API number, just one that was not registered
  // yet. sendTemplate self-heals registration on first send; text and media
  // are session sends that Meta may refuse with 133010 until the number is
  // registered — a typed meta_error, not an opaque failure, and the number
  // becomes permanently sendable, so the cell is supported.
  coexistence: {
    text: OK,
    template: OK,
    image: OK,
    video: OK,
    audio: OK,
    document: OK,
  },
  // evolution_qr: no phone number id on the Cloud API at all. Nothing is
  // sendable, and the wording per family preserves what the deep guards in
  // whatsappPartnerOps have always answered.
  evolution_qr: {
    text: qr("Free-form sends are not supported in Direct QR mode"),
    template: qr("Template messages are not supported in Direct QR mode"),
    image: qr("Media sends are not supported in Direct QR mode"),
    video: qr("Media sends are not supported in Direct QR mode"),
    audio: qr("Media sends are not supported in Direct QR mode"),
    document: qr("Media sends are not supported in Direct QR mode"),
  },
};

// null: legal per the CHECK (NULL satisfies it), and every existing send
// path already treats it as Cloud API — the guards in whatsappPartnerOps
// refuse only 'evolution_qr'. The migration backfilled all WhatsApp rows to
// 'cloud_api' and the column default is 'cloud_api', so null is at worst a
// legacy row; recording it as supported preserves today's behaviour rather
// than narrowing it under a refactor.
const NULL_MODE_MATRIX: Record<PartnerMessageType, MessagingCapability> = {
  text: OK,
  template: OK,
  image: OK,
  video: OK,
  audio: OK,
  document: OK,
};

/**
 * The cell for one connection mode × one message type.
 *
 * A connection_mode string outside the CHECK's vocabulary cannot occur in a
 * well-formed database — and is refused here rather than guessed at,
 * loudly, because if it ever DOES occur the database and this matrix have
 * drifted apart and the answer must fail closed while a human looks.
 */
export function partnerMessagingCapability(
  connectionMode: string | null | undefined,
  type: PartnerMessageType,
): MessagingCapability {
  if (connectionMode === null || connectionMode === undefined) {
    return NULL_MODE_MATRIX[type];
  }
  const row = (MODE_MATRIX as Record<string, Record<PartnerMessageType, MessagingCapability> | undefined>)[
    connectionMode
  ];
  if (row === undefined) {
    console.error(
      `[partner-api] unknown connection_mode "${connectionMode}" on a whatsapp account; ` +
        "refusing the send — the schema's CHECK vocabulary and the capability matrix have drifted",
    );
    return {
      supported: false,
      code: "unsupported_capability",
      message: "This account's connection mode is not recognized and cannot carry messages",
    };
  }
  return row[type];
}
