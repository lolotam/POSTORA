import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normaliseAttachmentEntry, readResendAttachmentList, type ResendAttachmentList } from "./resendAttachmentList.ts";

const answer = (body: BodyInit | null, status = 200) => () => Promise.resolve(new Response(body, { status }));

Deno.test("a readable list is returned normalised, in either shape Resend sends", async () => {
  const entry = { id: "att_1", filename: "a.pdf", content_type: "application/pdf", download_url: "https://r/x" };
  const expected: ResendAttachmentList = { ok: true, attachments: [{ id: "att_1", filename: "a.pdf", contentType: "application/pdf", downloadUrl: "https://r/x" }] };
  assertEquals(await readResendAttachmentList("em", "k", answer(JSON.stringify({ data: [entry] }))), expected);
  assertEquals(await readResendAttachmentList("em", "k", answer(JSON.stringify([entry]))), expected);
  assertEquals(await readResendAttachmentList("em", "k", answer(JSON.stringify({ data: [] }))), { ok: true, attachments: [] });
});

Deno.test("a list that cannot be read is a failure, never an empty list", async () => {
  assertEquals(await readResendAttachmentList("em", "k", answer("{}", 503)), { ok: false, status: 503, detail: "non-2xx" });
  assertEquals(await readResendAttachmentList("em", "k", answer("<html>")), { ok: false, status: 200, detail: "body is not JSON" });
  assertEquals(await readResendAttachmentList("em", "k", answer(JSON.stringify({ data: "x" }))), { ok: false, status: 200, detail: "unexpected list shape" });
  const offline = () => Promise.reject(new TypeError("connection reset"));
  assertEquals(await readResendAttachmentList("em", "k", offline), { ok: false, status: null, detail: "TypeError" });
});

Deno.test("an entry with missing or non-string fields gets safe defaults", () => {
  assertEquals(normaliseAttachmentEntry({ filename: 42, contentType: "image/png", url: "https://r/y" }), {
    id: null,
    filename: "attachment",
    contentType: "image/png",
    downloadUrl: "https://r/y",
  });
  assertEquals(normaliseAttachmentEntry(null), { id: null, filename: "attachment", contentType: "application/octet-stream", downloadUrl: null });
});
