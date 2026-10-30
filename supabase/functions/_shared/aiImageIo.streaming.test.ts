import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { chooseUpscaleOutputFormat, fetchOutputImage, imageInputFrom, parseToolRequest, readImageInput, resultNameFor, resumeTokenOf } from "./aiImageIo.ts";

/** PNG signature + IHDR header: enough for type sniffing. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  return bytes;
}
const jsonRequest = (body: unknown) => new Request("https://f.example", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A body that yields `chunk` on each pull and records how many pulls happened and whether it was cancelled. */
function countingBody(chunk: Uint8Array, chunks: number) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled++;
      if (seen.pulled > chunks) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

Deno.test("fetchOutputImage stops reading once the body passes the size limit, instead of buffering it all", async () => {
  const { body, seen } = countingBody(new Uint8Array(100).fill(1), 1000);
  const fetchFn = (() => Promise.resolve(new Response(body))) as typeof fetch; // no Content-Length
  const result = await fetchOutputImage("https://c.example/o", { fetchFn, maxBytes: 250 });
  assertEquals(result.ok, false);
  assertEquals(seen.cancelled, true);
  assertEquals(seen.pulled < 10, true, `pulled ${seen.pulled} chunks of 1000`);
});

Deno.test("fetchOutputImage keeps its deadline while the body is being read", async () => {
  // Headers arrive at once and the body never ends: only a deadline that covers the body stops it.
  let aborted = false;
  const fetchFn = ((_: string | URL | Request, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png()); } }); // never closes
    return Promise.resolve(new Response(body));
  }) as typeof fetch;
  const started = Date.now();
  const result = await fetchOutputImage("https://c.example/o", { fetchFn, timeoutMs: 50 });
  assertEquals(result.ok === false && result.error.includes("timed out"), true);
  assertEquals(Date.now() - started < 2000, true);
  assertEquals(aborted, true);
});

Deno.test("multipart: a file wins over image_url (the order the old handlers had)", async () => {
  const both = new FormData();
  both.append("file", new File([png()], "a.png", { type: "image/png" }));
  both.append("image_url", "https://x.example/other.jpg");
  const withFile = await readImageInput(new Request("https://f.example", { method: "POST", body: both }));
  assertEquals(withFile.ok && withFile.input.kind, "bytes");

  const urlOnly = new FormData();
  urlOnly.append("image_url", "https://x.example/other.jpg");
  const withUrl = await readImageInput(new Request("https://f.example", { method: "POST", body: urlOnly }));
  assertEquals(withUrl.ok && withUrl.input, { kind: "url", url: "https://x.example/other.jpg" });
});

Deno.test("JSON keeps the URL over image_base64", async () => {
  const result = await readImageInput(jsonRequest({ image_url: "https://x.example/a.jpg", image_base64: btoa(String.fromCharCode(...png())) }));
  assertEquals(result.ok && result.input.kind, "url");
});

Deno.test("a JSON body far over the image limit is refused as 413 before it is parsed", async () => {
  const result = await readImageInput(jsonRequest({ image_base64: "A".repeat(500_000) }), 1000);
  assertEquals(result.ok === false && result.status, 413);
});

Deno.test("a follow-up request is recognised by its prediction_id, in JSON and in a form", async () => {
  const json = await parseToolRequest(jsonRequest({ prediction_id: "tok.en" }));
  assertEquals(json.ok && resumeTokenOf(json.fields), "tok.en");
  const form = new FormData();
  form.append("prediction_id", "tok.en");
  const multipart = await parseToolRequest(new Request("https://f.example", { method: "POST", body: form }));
  assertEquals(multipart.ok && resumeTokenOf(multipart.fields), "tok.en");
  assertEquals(resumeTokenOf({ prediction_id: "" }), null);
  assertEquals(resumeTokenOf({ prediction_id: 7 }), null);
});

Deno.test("a follow-up body carries no image, so it is not mistaken for a new job", async () => {
  const body = await parseToolRequest(jsonRequest({ prediction_id: "tok.en" }));
  if (!body.ok) throw new Error("body should parse");
  const asImage = await imageInputFrom(body);
  assertEquals(asImage.ok, false);
});

Deno.test("upscale output format: as asked, else png for a PNG input (keeps transparency) and jpeg otherwise", () => {
  const pngBytes = { kind: "bytes", bytes: png(), extension: "png", mime: "image/png" } as const;
  const jpgBytes = { kind: "bytes", bytes: png(), extension: "jpg", mime: "image/jpeg" } as const;
  assertEquals(chooseUpscaleOutputFormat(undefined, pngBytes), "png");
  assertEquals(chooseUpscaleOutputFormat("", jpgBytes), "jpeg");
  assertEquals(chooseUpscaleOutputFormat(undefined, { kind: "url", url: "https://x.example/cutout.PNG?v=1" }), "png");
  assertEquals(chooseUpscaleOutputFormat(undefined, { kind: "url", url: "https://x.example/photo.jpg" }), "jpeg");
  assertEquals(chooseUpscaleOutputFormat("png", jpgBytes), "png");
  assertEquals(chooseUpscaleOutputFormat("jpeg", pngBytes), "jpeg");
  assertEquals(chooseUpscaleOutputFormat("webp", pngBytes), null);
});

Deno.test("the result name is stable for one prediction and different between predictions", async () => {
  assertEquals(await resultNameFor("pred-1"), await resultNameFor("pred-1"));
  assertEquals((await resultNameFor("pred-1")) === (await resultNameFor("pred-2")), false);
  assertEquals(/^[0-9a-f]{32}$/.test(await resultNameFor("pred-1")), true);
});
