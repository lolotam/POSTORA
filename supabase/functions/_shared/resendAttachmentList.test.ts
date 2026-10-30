import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { downloadResendAttachment, normaliseAttachmentEntry, readResendAttachmentList, type ResendAttachmentList } from "./resendAttachmentList.ts";

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

Deno.test("the Resend key is only ever sent to a Resend host, and only over HTTPS", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization");
    calls.push({ url: String(input), auth });
    return Promise.resolve(new Response("x", { status: auth ? 200 : 403 }));
  };

  const fromResend = await downloadResendAttachment("https://cdn.resend.com/att/1?sig=a", "re_key", fetcher);
  assertEquals(fromResend?.status, 200);
  assertEquals(calls.map((c) => c.auth), [null, "Bearer re_key"]);

  calls.length = 0;
  const elsewhere = await downloadResendAttachment("https://evil.example/resend.com/att", "re_key", fetcher);
  assertEquals(elsewhere?.status, 403);
  assertEquals(calls.map((c) => c.auth), [null]);

  calls.length = 0;
  assertEquals(await downloadResendAttachment("http://cdn.resend.com/att/1", "re_key", fetcher), null);
  assertEquals(await downloadResendAttachment("not a url", "re_key", fetcher), null);
  assertEquals(calls, []);
});

Deno.test("the email id is encoded into the list URL", async () => {
  const urls: string[] = [];
  const fetcher = (input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ data: [] })));
  };
  await readResendAttachmentList("x/../../domains", "k", fetcher);
  assertEquals(urls, ["https://api.resend.com/emails/receiving/x%2F..%2F..%2Fdomains/attachments"]);
});
