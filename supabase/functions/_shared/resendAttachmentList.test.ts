import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { downloadResendAttachment, isValidResendEmailId, normaliseAttachmentEntry, readResendAttachmentList, type ResendAttachmentList } from "./resendAttachmentList.ts";

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

Deno.test("an email id outside Resend's format is refused before any request", async () => {
  const urls: string[] = [];
  const fetcher = (input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ data: [] })));
  };
  for (const id of ["..", ".", "x/../../domains", "", "a b"]) {
    assertEquals(await readResendAttachmentList(id, "k", fetcher), { ok: false, status: null, detail: "invalid email id" });
  }
  assertEquals(urls, []);
  assertEquals(isValidResendEmailId("4ef9a417-02e9-4d39-ad75-9611e0fcc33c"), true);
  await readResendAttachmentList("4ef9a417-02e9-4d39-ad75-9611e0fcc33c", "k", fetcher);
  assertEquals(urls, ["https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c/attachments"]);
});

Deno.test("a download follows redirects only while every hop stays on HTTPS", async () => {
  const hops: string[] = [];
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
  const chain = (map: Record<string, Response>) => (input: string | URL | Request) => {
    hops.push(String(input));
    return Promise.resolve(map[String(input)] ?? new Response("file"));
  };

  const ok = await downloadResendAttachment("https://cdn.resend.com/a", "k", chain({ "https://cdn.resend.com/a": redirectTo("https://storage.example/b") }));
  assertEquals([ok?.status, hops], [200, ["https://cdn.resend.com/a", "https://storage.example/b"]]);

  hops.length = 0;
  const downgraded = await downloadResendAttachment("https://cdn.resend.com/a", "k", chain({ "https://cdn.resend.com/a": redirectTo("http://storage.example/b") }));
  assertEquals([downgraded, hops], [null, ["https://cdn.resend.com/a"]]);

  hops.length = 0;
  const loop = await downloadResendAttachment("https://cdn.resend.com/a", "k", () => {
    hops.push("x");
    return Promise.resolve(redirectTo("https://cdn.resend.com/a"));
  });
  assertEquals([loop, hops.length], [null, 4]);
});
