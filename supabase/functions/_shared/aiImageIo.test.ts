import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  discardStaged,
  fetchOutputImage,
  pngSize,
  readImageInput,
  stageInput,
  storeResult,
  toDataUri,
  type ImageInput,
} from "./aiImageIo.ts";
import type { OpeninaryConfig } from "./openinary.ts";

const config: OpeninaryConfig = { serverUrl: "https://o.example", apiKey: "test-key", folderPrefix: "postora.cloud" };

/** PNG signature + IHDR header: enough for type sniffing and size reading. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const jsonRequest = (body: unknown) => new Request("https://f.example", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Bytes = Extract<ImageInput, { kind: "bytes" }>;
async function bytesOf(req: Request, maxBytes?: number): Promise<{ input: ImageInput; fields: Record<string, unknown> }> {
  const result = await readImageInput(req, maxBytes);
  if (!result.ok) throw new Error(`unexpected refusal: ${result.message}`);
  return result;
}

Deno.test("image_url is accepted as-is and the other fields are handed back", async () => {
  const { input, fields } = await bytesOf(jsonRequest({ image_url: "https://x.example/a.jpg", scale: 4, platform: "atlascloud" }));
  assertEquals(input, { kind: "url", url: "https://x.example/a.jpg" });
  assertEquals([fields.scale, fields.platform], [4, "atlascloud"]);
});

Deno.test("the URL wins when both a URL and base64 are sent", async () => {
  const { input } = await bytesOf(jsonRequest({ image_url: "https://x.example/a.jpg", image_base64: b64(png(1, 1)) }));
  assertEquals(input.kind, "url");
});

Deno.test("raw base64 and a data URI both decode, and the type comes from the bytes not the label", async () => {
  const bytes = png(2, 3);
  for (const image_base64 of [b64(bytes), `data:image/jpeg;base64,${b64(bytes)}`]) {
    const { input } = await bytesOf(jsonRequest({ image_base64 }));
    assertEquals(input.kind, "bytes");
    const decoded = input as Bytes;
    assertEquals([decoded.extension, decoded.mime, decoded.bytes.length], ["png", "image/png", bytes.length]);
  }
});

Deno.test("refuses what it cannot serve, with a status the caller can act on", async () => {
  const cases: Array<[string, unknown, number]> = [
    ["non-http URL", { image_url: "file:///etc/passwd" }, 400],
    ["not a URL", { image_url: "nope" }, 400],
    ["invalid base64", { image_base64: "%%%%" }, 400],
    ["not an image", { image_base64: b64(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])) }, 400],
    ["no image at all", { scale: 2 }, 400],
  ];
  for (const [name, body, status] of cases) {
    const result = await readImageInput(jsonRequest(body));
    assertEquals(result.ok === false && result.status, status, name);
  }
  const notJson = await readImageInput(new Request("https://f.example", { method: "POST", body: "plain", headers: { "content-type": "text/plain" } }));
  assertEquals(notJson.ok === false && notJson.status, 400);
});

Deno.test("an image over the size cap is 413, before and after decoding", async () => {
  const big = png(1, 1);
  const tooBigByEstimate = await readImageInput(jsonRequest({ image_base64: "A".repeat(200) }), 10);
  assertEquals(tooBigByEstimate.ok === false && tooBigByEstimate.status, 413);
  const tooBigDecoded = await readImageInput(jsonRequest({ image_base64: b64(big) }), 20);
  assertEquals(tooBigDecoded.ok === false && tooBigDecoded.status, 413);
});

Deno.test("multipart: a file and string fields are read; an oversize file is 413", async () => {
  const form = new FormData();
  form.append("file", new File([png(4, 4)], "a.png", { type: "image/png" }));
  form.append("scale", "3");
  const { input, fields } = await bytesOf(new Request("https://f.example", { method: "POST", body: form }));
  assertEquals((input as Bytes).extension, "png");
  assertEquals(fields.scale, "3");

  const tooBig = new FormData();
  tooBig.append("file", new File([png(4, 4)], "a.png"));
  const refused = await readImageInput(new Request("https://f.example", { method: "POST", body: tooBig }), 10);
  assertEquals(refused.ok === false && refused.status, 413);
});

Deno.test("a large multipart file does not blow the stack (the old btoa(...spread) did)", async () => {
  const large = new Uint8Array(300_000);
  large.set(png(1, 1));
  const form = new FormData();
  form.append("file", new File([large], "big.png"));
  const { input } = await bytesOf(new Request("https://f.example", { method: "POST", body: form }));
  assertEquals((input as Bytes).bytes.length, 300_000);
  assertStringIncludes(toDataUri(input as Bytes).slice(0, 30), "data:image/png;base64,");
});

Deno.test("toDataUri round-trips the bytes", () => {
  const bytes = png(5, 6);
  const uri = toDataUri({ kind: "bytes", bytes, extension: "png", mime: "image/png" });
  assertEquals(uri, `data:image/png;base64,${b64(bytes)}`);
});

Deno.test("pngSize reads the header and ignores other formats", () => {
  assertEquals(pngSize(png(1920, 1080)), { width: 1920, height: 1080 });
  assertEquals(pngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

type Recorded = { url: string; method: string; auth: string | null; folder?: string; fileName?: string };

/** Stands in for Openinary: lists nothing, stores uploads at folder/name, accepts deletes. */
async function withFakeOpeninary(
  behaviour: { uploadStatus?: number },
  run: (calls: Recorded[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Recorded = { url, method: init?.method ?? "GET", auth: headers.get("authorization") };
    calls.push(call);
    if (url.includes("/api/storage?")) return Promise.resolve(new Response(JSON.stringify({ files: [] })));
    if (call.method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.endsWith("/api/upload")) {
      const form = init?.body as FormData;
      call.folder = String(form.get("folder"));
      call.fileName = (form.get("files") as File).name;
      if (behaviour.uploadStatus && behaviour.uploadStatus !== 200) return Promise.resolve(new Response(JSON.stringify({ success: false, error: "boom" }), { status: behaviour.uploadStatus }));
      return Promise.resolve(new Response(JSON.stringify({ success: true, files: [{ path: `${call.folder}/${call.fileName}` }] })));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const pngInput: Bytes = { kind: "bytes", bytes: png(2, 2), extension: "png", mime: "image/png" };

Deno.test("an uploaded image is staged under the user's ai-tmp folder and gets a public delivery URL", async () => {
  await withFakeOpeninary({}, async (calls) => {
    const staged = await stageInput(config, "user-1", pngInput);
    assertEquals(staged.ok, true);
    if (!staged.ok) return;
    const upload = calls.find((c) => c.url.endsWith("/api/upload"))!;
    assertEquals(upload.auth, "Bearer test-key");
    assertEquals(upload.folder, "postora.cloud/postora/user-1/ai-tmp");
    assertEquals(staged.path, `${upload.folder}/${upload.fileName}`);
    assertEquals(upload.fileName?.endsWith(".png"), true);
    assertEquals(staged.url, `https://o.example/t/${staged.path}`);
  });
});

Deno.test("a result is stored under the user's upscaled or processed folder", async () => {
  await withFakeOpeninary({}, async (calls) => {
    const stored = await storeResult(config, "user-1", "processed", { bytes: png(2, 2), extension: "png", mime: "image/png" });
    assertEquals(stored.ok, true);
    assertEquals(calls.find((c) => c.url.endsWith("/api/upload"))?.folder, "postora.cloud/postora/user-1/processed");
  });
});

Deno.test("a failed Openinary write is reported, not thrown", async () => {
  await withFakeOpeninary({ uploadStatus: 500 }, async () => {
    const stored = await storeResult(config, "user-1", "upscaled", { bytes: png(2, 2), extension: "png", mime: "image/png" });
    assertEquals(stored.ok, false);
  });
});

Deno.test("discardStaged deletes the staged object and never throws", async () => {
  await withFakeOpeninary({}, async (calls) => {
    await discardStaged(config, "postora.cloud/postora/user-1/ai-tmp/x.png");
    const del = calls.find((c) => c.method === "DELETE")!;
    assertEquals(del.url, "https://o.example/api/storage/postora.cloud/postora/user-1/ai-tmp/x.png");
    assertEquals(del.auth, "Bearer test-key");
  });
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("down"))) as typeof fetch;
  try {
    await discardStaged(config, "p/x.png");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("fetchOutputImage returns bytes with the type read from them", async () => {
  const fetchFn = (() => Promise.resolve(new Response(png(8, 8)))) as typeof fetch;
  const result = await fetchOutputImage("https://cdn.example/o.png", { fetchFn });
  assertEquals(result.ok && [result.extension, result.mime], ["png", "image/png"]);
});

Deno.test("fetchOutputImage refuses an error status, a non-image, an empty body and an oversize one", async () => {
  const answer = (body: BodyInit | null, init?: ResponseInit) => (() => Promise.resolve(new Response(body, init))) as typeof fetch;
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: answer("nope", { status: 404 }) })).ok, false);
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: answer("<html>") })).ok, false);
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: answer(new Uint8Array(0)) })).ok, false);
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: answer(png(1, 1), { headers: { "content-length": "999999999" } }) })).ok, false);
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: answer(png(1, 1)), maxBytes: 10 })).ok, false);
  assertEquals((await fetchOutputImage("https://c.example/o", { fetchFn: (() => Promise.reject(new Error("dns"))) as typeof fetch })).ok, false);
});
