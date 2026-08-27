import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  describeBase64Failure,
  normalizeBase64Media,
  sniffBase64MimeType,
} from "./base64Media.ts";

// Real 1x1 payloads, so the magic numbers under test are the ones a client actually sends.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const JPEG_HEAD = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==";

Deno.test("sniffs the formats a social post actually carries", () => {
  assertEquals(sniffBase64MimeType(PNG_1X1), "image/png");
  assertEquals(sniffBase64MimeType(GIF_1X1), "image/gif");
  assertEquals(sniffBase64MimeType(JPEG_HEAD), "image/jpeg");
});

// RIFF carries a four-byte length between the magic and the WEBP tag, so a signature that
// required those bytes to be constant would reject every real file.
Deno.test("sniffs webp across the variable length field", () => {
  const riff = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x01, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
  const payload = btoa(String.fromCharCode(...riff));
  assertEquals(sniffBase64MimeType(payload), "image/webp");
});

Deno.test("sniffs mp4 from ftyp at offset four", () => {
  const mp4 = new Uint8Array([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const payload = btoa(String.fromCharCode(...mp4));
  assertEquals(sniffBase64MimeType(payload), "video/mp4");
});

Deno.test("returns null rather than guessing an unknown payload", () => {
  assertEquals(sniffBase64MimeType(btoa("just some text")), null);
});

Deno.test("passes an existing data URL through untouched", () => {
  const dataUrl = `data:image/png;base64,${PNG_1X1}`;
  assertEquals(normalizeBase64Media(dataUrl), { ok: true, dataUrl });
});

// The bug this module exists for: the MCP tool promises "data URL or raw base64", and a
// raw payload was rejected with a format error that read like a corrupt image.
Deno.test("promotes raw base64 to a data URL by sniffing it", () => {
  assertEquals(normalizeBase64Media(PNG_1X1), {
    ok: true,
    dataUrl: `data:image/png;base64,${PNG_1X1}`,
  });
});

Deno.test("falls back to the caller's mime_type only when sniffing fails", () => {
  const opaque = btoa("not a format we know");
  assertEquals(normalizeBase64Media(opaque, "image/heic"), {
    ok: true,
    dataUrl: `data:image/heic;base64,${opaque}`,
  });
});

// The bytes outrank the hint: a client that mislabels a PNG should still get a PNG.
Deno.test("prefers the sniffed type over a wrong hint", () => {
  const outcome = normalizeBase64Media(PNG_1X1, "video/mp4");
  assertEquals(outcome, { ok: true, dataUrl: `data:image/png;base64,${PNG_1X1}` });
});

Deno.test("strips whitespace a client wrapped the payload in", () => {
  const wrapped = `${PNG_1X1.slice(0, 20)}\n  ${PNG_1X1.slice(20)}`;
  assertEquals(normalizeBase64Media(wrapped), {
    ok: true,
    dataUrl: `data:image/png;base64,${PNG_1X1}`,
  });
});

Deno.test("refuses an empty payload", () => {
  assertEquals(normalizeBase64Media(""), { ok: false, reason: "empty" });
  assertEquals(normalizeBase64Media("   "), { ok: false, reason: "empty" });
  assertEquals(normalizeBase64Media(null), { ok: false, reason: "empty" });
});

Deno.test("refuses an unrecognised payload with no hint", () => {
  assertEquals(normalizeBase64Media(btoa("mystery bytes")), {
    ok: false,
    reason: "unrecognised_type",
  });
});

// A malformed data: prefix means the client intended a data URL. Reinterpreting the whole
// string as raw base64 would upload the header as image bytes.
Deno.test("refuses a malformed data URL instead of re-reading it as raw base64", () => {
  assertEquals(normalizeBase64Media("data:image/png,notbase64"), {
    ok: false,
    reason: "unrecognised_type",
  });
});

// CodeRabbit, PR #41: a valid header plus a non-empty body passed without the body ever
// being decoded, so garbage reached Cloudinary and failed there with a message about its
// internals rather than about the caller's input.
Deno.test("refuses a data URL whose body is not base64", () => {
  assertEquals(normalizeBase64Media("data:image/png;base64,%%%%"), {
    ok: false,
    reason: "undecodable",
  });
});

Deno.test("refuses raw garbage even when a mime hint is supplied", () => {
  assertEquals(normalizeBase64Media("%%%not base64%%%", "image/png"), {
    ok: false,
    reason: "undecodable",
  });
});

Deno.test("failure text tells the caller what to send instead", () => {
  assertEquals(describeBase64Failure("empty"), "Media payload was empty.");
  assertEquals(describeBase64Failure("undecodable"), "Media payload is not valid base64.");
  assertEquals(
    describeBase64Failure("unrecognised_type").includes("mime_type"),
    true,
  );
});
