// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  partnerMessagingCapability,
  type PartnerConnectionMode,
  type PartnerMessageType,
} from "./partnerMessagingCapabilities.ts";

// ---------------------------------------------------------------------------
// Phase 9.2 — the capability matrix, walked EXHAUSTIVELY.
//
// Every mode × every type, no sampling. The point is not that any single
// cell is right; it is that NO cell is missing or ambiguous: each result is
// exactly one of the two declared shapes, and the specific families the
// brief pins (evolution_qr refuses everything, cloud_api carries every
// media type) are asserted per cell rather than in aggregate.
//
// The matrix's Record types make a missing cell a compile error under
// `deno check`, but CI runs --no-check — so this walk is the runtime half of
// the exhaustiveness guarantee.
// ---------------------------------------------------------------------------

const TYPES: PartnerMessageType[] = ["text", "template", "image", "video", "audio", "document"];

const KNOWN_MODES: PartnerConnectionMode[] = ["cloud_api", "coexistence", "evolution_qr", null];

/** Shape check shared by every cell: exactly one of the two declared
 *  outcomes, with a non-empty human message when refused. */
function assertCellShaped(mode: string | null, type: PartnerMessageType, cell: unknown) {
  const c = cell as { supported?: boolean; code?: unknown; message?: unknown };
  assertEquals(
    typeof c.supported,
    "boolean",
    `cell ${mode} x ${type} must state supported as a boolean`,
  );
  if (c.supported === true) {
    assertEquals(
      Object.keys(c).length,
      1,
      `cell ${mode} x ${type} is supported and must carry nothing else`,
    );
    return;
  }
  assertEquals(
    c.code === "unsupported_direct_qr" || c.code === "unsupported_capability",
    true,
    `cell ${mode} x ${type} refuses with an unknown code: ${String(c.code)}`,
  );
  assertEquals(
    typeof c.message === "string" && (c.message as string).length > 0,
    true,
    `cell ${mode} x ${type} refuses without a partner-safe message`,
  );
}

Deno.test("every mode x type cell is exactly one of the two declared shapes", () => {
  for (const mode of KNOWN_MODES) {
    for (const type of TYPES) {
      assertCellShaped(mode, type, partnerMessagingCapability(mode, type));
    }
  }
});

Deno.test("evolution_qr refuses EVERY message type, as unsupported_direct_qr — not unsupported_capability", () => {
  // The account's connection is the problem, not the request's shape:
  // errors.ts pins that vocabulary distinction and the alias has emitted
  // unsupported_direct_qr for QR-mode for years. The route test
  // (messages.capability.test.ts C1) proves the refusal now happens with
  // zero side effects; this pins the verdict for all six types, including
  // the template and text cells the suspended route cannot drive.
  for (const type of TYPES) {
    const cell = partnerMessagingCapability("evolution_qr", type);
    assertEquals(cell.supported, false, `evolution_qr x ${type} must be refused`);
    assertEquals(
      (cell as { code: string }).code,
      "unsupported_direct_qr",
      `evolution_qr x ${type} must keep the QR-mode code, not unsupported_capability`,
    );
  }
});

Deno.test("cloud_api supports every message type, media included", () => {
  for (const type of TYPES) {
    const cell = partnerMessagingCapability("cloud_api", type);
    assertEquals(cell.supported, true, `cloud_api x ${type} must be supported`);
  }
});

Deno.test("coexistence and null support every message type — the matrix records today's behaviour", () => {
  // coexistence: a Cloud API number awaiting registration; text/media may
  // meet a typed meta_error until registered, which is not an opaque
  // failure. null: legal per the CHECK, and every existing send path treats
  // it as Cloud API (the deep guards refuse only 'evolution_qr').
  for (const type of TYPES) {
    assertEquals(partnerMessagingCapability("coexistence", type).supported, true);
    assertEquals(partnerMessagingCapability(null, type).supported, true);
  }
});

Deno.test("an unknown connection_mode string is REFUSED, never guessed", () => {
  // The CHECK vocabulary is three values plus null; anything else means the
  // database and the matrix have drifted, and the answer must fail closed
  // rather than wave an unrecognised mode through to Meta. "cloud" is the
  // value the old test fixtures used — exactly the shape of mistake this
  // guards against.
  for (const mode of ["cloud", "", "EVOLUTION_QR", "legacy"]) {
    for (const type of TYPES) {
      const cell = partnerMessagingCapability(mode, type);
      assertEquals(cell.supported, false, `unknown mode "${mode}" x ${type} must be refused`);
      assertEquals(
        (cell as { code: string }).code,
        "unsupported_capability",
        `unknown mode "${mode}" x ${type} refuses with unsupported_capability`,
      );
    }
  }
});
