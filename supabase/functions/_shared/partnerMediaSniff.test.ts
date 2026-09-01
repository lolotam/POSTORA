// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  MAX_BYTES_BY_KIND,
  PARTNER_MEDIA_TYPES,
  sniffPartnerMedia,
  validatePartnerMedia,
} from "./partnerMediaSniff.ts";

// ---------------------------------------------------------------------------
// The D10 control matrix's "accepted types" row, and Phase 4's exit criterion:
// "a file whose extension and real content disagree is rejected."
//
// M1 is the load-bearing test. Everything else here checks that the sniffer
// recognises what it should; M1 checks that recognising is not optional —
// that the client's claim never wins over the bytes. A sniffer that is
// correct but advisory protects nothing.
// ---------------------------------------------------------------------------

function bytes(...values: (number | string)[]): Uint8Array {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "number") out.push(v);
    else for (const ch of v) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
}

/** Real magic-number prefixes, padded so every one clears SNIFF_BYTES. */
const SAMPLES: Record<string, Uint8Array> = {
  "image/png": bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0),
  "image/jpeg": bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0),
  "application/pdf": bytes("%PDF-1.7", 0, 0, 0, 0),
  "audio/ogg": bytes("OggS", 0, 0, 0, 0, 0, 0, 0, 0),
  "audio/amr": bytes("#!AMR", 0, 0, 0, 0, 0, 0, 0),
  "video/mp4": bytes(0, 0, 0, 0x20, "ftyp", "isom", 0, 0, 0, 0),
  "video/3gpp": bytes(0, 0, 0, 0x20, "ftyp", "3gp4", 0, 0, 0, 0),
  "audio/aac": bytes(0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0),
  "audio/mpeg": bytes("ID3", 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0),
};

// --- M1 — the exit criterion -----------------------------------------------

Deno.test("M1: a declared type that disagrees with the bytes is REFUSED, not corrected", () => {
  // The interesting case is not a typo. It is a file a client calls a PDF
  // that is really something else — and silently correcting it to the sniffed
  // type would make the gate a relabeller instead of a refusal.
  const outcome = validatePartnerMedia(SAMPLES["image/png"]!, "application/pdf");
  assertEquals(outcome.ok, false);
  assertEquals(outcome.ok === false && outcome.reason, "declared_mismatch");
});

Deno.test("M1b: a declared type outside the allowlist entirely is also a mismatch", () => {
  // application/x-msdownload over real PNG bytes. The disagreement is the
  // condition; whether the claim was even a legal type is beside the point.
  const outcome = validatePartnerMedia(SAMPLES["image/png"]!, "application/x-msdownload");
  assertEquals(outcome.ok === false && outcome.reason, "declared_mismatch");
});

// --- M2 — every advertised type is actually recognised ---------------------

Deno.test("M2: all nine allowlisted types sniff to themselves", () => {
  for (const type of PARTNER_MEDIA_TYPES) {
    assertEquals(sniffPartnerMedia(SAMPLES[type]!), type, type);
    // And each is accepted when the client declares it honestly.
    const outcome = validatePartnerMedia(SAMPLES[type]!, type);
    assertEquals(outcome.ok, true, type);
  }
  // Anti-false-green: the loop above proves nothing if the sample table has
  // quietly lost entries.
  assertEquals(Object.keys(SAMPLES).length, PARTNER_MEDIA_TYPES.length);
});

// --- M3/M4/M5 — the three places a naive sniffer gets it wrong -------------

Deno.test("M3: AAC is tested before MP3, because ADTS satisfies the MPEG sync mask", () => {
  // 0xF1 & 0xE0 === 0xE0. Put the MP3 check first and every AAC file is
  // reported as audio/mpeg and sent with the wrong WhatsApp type.
  assertEquals(sniffPartnerMedia(bytes(0xff, 0xf1, 0, 0)), "audio/aac");
  assertEquals(sniffPartnerMedia(bytes(0xff, 0xf9, 0, 0)), "audio/aac");
  // A genuine MP3 frame sync still resolves to MP3.
  assertEquals(sniffPartnerMedia(bytes(0xff, 0xfb, 0, 0)), "audio/mpeg");
});

Deno.test("M4: an ISO-BMFF box with a non-video brand is unrecognised, not video", () => {
  // `M4A ` is audio inside an MP4 container. Accepting it as video/mp4 would
  // build a WhatsApp video message around an audio file, which Meta rejects.
  assertEquals(sniffPartnerMedia(bytes(0, 0, 0, 0x20, "ftyp", "M4A ")), null);
  assertEquals(sniffPartnerMedia(bytes(0, 0, 0, 0x20, "ftyp", "qt  ")), null);
});

Deno.test("M5: webp is recognised by the app's sniffer but NOT accepted here", () => {
  // On WhatsApp a webp is a sticker — a different message type with different
  // rules. base64Media.ts accepts it for social posts; this gate must not.
  const webp = bytes("RIFF", 0, 0, 0, 0, "WEBP");
  assertEquals(sniffPartnerMedia(webp), null);
  assertEquals(validatePartnerMedia(webp).ok, false);
});

// --- M6 — the size row, at its exact boundary ------------------------------

Deno.test("M6: the limit is inclusive, and one byte over is too_large", () => {
  const png = SAMPLES["image/png"]!;
  const atLimit = new Uint8Array(MAX_BYTES_BY_KIND.image);
  atLimit.set(png.subarray(0, png.length));
  assertEquals(validatePartnerMedia(atLimit).ok, true, "a file exactly at the limit is within it");

  const overLimit = new Uint8Array(MAX_BYTES_BY_KIND.image + 1);
  overLimit.set(png.subarray(0, png.length));
  const outcome = validatePartnerMedia(overLimit);
  assertEquals(outcome.ok === false && outcome.reason, "too_large");
  assertEquals(outcome.ok === false && outcome.kind, "image");
});

Deno.test("M6b: the limits are per KIND, not one global number", () => {
  // A 6 MB PDF is fine and a 6 MB image is not. A single global limit would
  // make one of those wrong, and the document publishes four numbers.
  const pdf = SAMPLES["application/pdf"]!;
  const big = new Uint8Array(6 * 1024 * 1024);
  big.set(pdf.subarray(0, pdf.length));
  assertEquals(validatePartnerMedia(big).ok, true);

  const png = SAMPLES["image/png"]!;
  const bigImage = new Uint8Array(6 * 1024 * 1024);
  bigImage.set(png.subarray(0, png.length));
  assertEquals(validatePartnerMedia(bigImage).ok, false);
});

// --- M7/M8 — the boundaries enumerated in the source -----------------------

Deno.test("M7: a synonym spelling is not a disagreement", () => {
  // A browser labelling a real JPEG `image/jpg` has not lied about anything.
  // Rejecting it would make the gate look broken rather than strict.
  assertEquals(validatePartnerMedia(SAMPLES["image/jpeg"]!, "image/jpg").ok, true);
  assertEquals(validatePartnerMedia(SAMPLES["audio/mpeg"]!, "audio/mp3").ok, true);
  // Parameters and case are not part of a type's identity either.
  assertEquals(
    validatePartnerMedia(SAMPLES["image/png"]!, "IMAGE/PNG; charset=binary").ok,
    true,
  );
});

Deno.test("M8: empty, short and unrecognised inputs each get their own answer", () => {
  assertEquals(validatePartnerMedia(new Uint8Array(0)).ok, false);
  assertEquals(
    validatePartnerMedia(new Uint8Array(0)).ok === false &&
      (validatePartnerMedia(new Uint8Array(0)) as { reason: string }).reason,
    "empty",
  );
  // Shorter than every signature: unrecognised rather than a crash on a
  // bounds read.
  assertEquals(sniffPartnerMedia(bytes(0x89)), null);
  assertEquals(sniffPartnerMedia(bytes("not a real file at all")), null);
});
