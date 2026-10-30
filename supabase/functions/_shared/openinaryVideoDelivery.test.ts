import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { OpeninaryConfig } from "./openinary.ts";
import { BUFFERED_UPLOAD_MAX_BYTES, declaredBytes, fetchVideoVariant, ingestVariant, MAX_DERIVED_BYTES, variantUrl } from "./openinaryVideoDelivery.ts";
import { OpeninaryVideoError } from "./openinaryVideoTransform.ts";

const config: OpeninaryConfig = { serverUrl: "https://cdn.example.test", apiKey: "k", folderPrefix: "postora.cloud" };
const SEGMENT = "w_720,h_1280,c_fill,q_80,f_mp4";
const PATH = "postora.cloud/media/u a/2026-10-30/clip one.mp4";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A scripted network: answers are consumed in order, every request URL is recorded. */
function scripted(...answers: (Response | (() => Response))[]) {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    urls.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error(`unexpected request to ${input}`);
    return Promise.resolve(typeof next === "function" ? next() : next);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await assertRejects(() => promise, OpeninaryVideoError);
  return error.code;
}

Deno.test("variantUrl encodes each path segment and keeps the transformation segment readable", () => {
  assertEquals(variantUrl(config, SEGMENT, PATH), `https://cdn.example.test/t/${SEGMENT}/postora.cloud/media/u%20a/2026-10-30/clip%20one.mp4`);
});

Deno.test("an already cached rendition is returned on the first request, unread", async () => {
  const net = scripted(new Response("video-bytes", { status: 200, headers: { "content-length": "11", "content-type": "video/mp4" } }));
  const response = await fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl });
  assertEquals(net.urls, [variantUrl(config, SEGMENT, PATH)]);
  assertEquals(response.bodyUsed, false);
  assertEquals(declaredBytes(response), 11);
  await response.body?.cancel();
});

Deno.test("a 200 that is not a video is not treated as a rendition", async () => {
  const net = scripted(new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl })), "TRANSFORM_FAILED");
});

Deno.test("202 then completed: polls the status URL, then asks for the rendition again", async () => {
  const net = scripted(
    json({ status: "processing", statusUrl: "/video-status/x/y.mp4" }, 202),
    json({ status: "processing", progress: 40 }),
    json({ status: "completed", progress: 100 }),
    new Response("ok", { status: 200, headers: { "content-type": "video/mp4" } }),
  );
  let slept = 0;
  const response = await fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl, sleep: () => { slept++; return Promise.resolve(); } });
  assertEquals(response.status, 200);
  assertEquals(net.urls, [
    variantUrl(config, SEGMENT, PATH),
    "https://cdn.example.test/video-status/x/y.mp4",
    "https://cdn.example.test/video-status/x/y.mp4",
    variantUrl(config, SEGMENT, PATH),
  ]);
  assertEquals(slept, 1);
  await response.body?.cancel();
});

Deno.test("a statusUrl that points off the Openinary server is never fetched", async () => {
  const net = scripted(
    json({ statusUrl: "https://169.254.169.254/latest/meta-data" }, 202),
    json({ status: "completed" }),
    new Response("ok", { status: 200, headers: { "content-type": "video/mp4" } }),
  );
  const response = await fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl, sleep: () => Promise.resolve() });
  assert(net.urls.every((url) => url.startsWith("https://cdn.example.test/")));
  assertEquals(net.urls[1], `https://cdn.example.test/video-status/${SEGMENT}/postora.cloud/media/u%20a/2026-10-30/clip%20one.mp4`);
  await response.body?.cancel();
});

Deno.test("an encode error reported by Openinary is a failed transform", async () => {
  const net = scripted(json({ statusUrl: "/video-status/x" }, 202), json({ status: "error", error: "ffmpeg exited 1 at /tmp/video-abc" }));
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl })), "TRANSFORM_FAILED");
});

Deno.test("an encode that outlasts the deadline is the retryable still-processing refusal", async () => {
  let clock = 0;
  const net = scripted(
    json({ statusUrl: "/video-status/x" }, 202),
    json({ status: "processing" }),
    json({ status: "processing" }),
    json({ status: "processing" }),
  );
  const error = await assertRejects(
    () => fetchVideoVariant(config, SEGMENT, PATH, {
      fetchImpl: net.fetchImpl,
      deadlineMs: 3_000,
      now: () => clock,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
    }),
    OpeninaryVideoError,
  );
  assertEquals(error.code, "TRANSFORM_STILL_PROCESSING");
  assertEquals(error.status, 503);
});

Deno.test("a 202 that never resolves into a 200 stops after a bounded number of rounds", async () => {
  const answers: Response[] = [];
  for (let i = 0; i < 12; i++) answers.push(json({ statusUrl: "/video-status/x" }, 202), json({ status: "completed" }));
  const net = scripted(...answers);
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl, sleep: () => Promise.resolve() })), "TRANSFORM_STILL_PROCESSING");
  assert(net.urls.length <= 10);
});

Deno.test("404 means the original is gone; other statuses are a failed transform with a safe message", async () => {
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: scripted(new Response("nope", { status: 404 })).fetchImpl })), "SOURCE_NOT_AVAILABLE");
  const error = await assertRejects(
    () => fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: scripted(new Response("Error: /srv/private/path", { status: 500 })).fetchImpl }),
    OpeninaryVideoError,
  );
  assertEquals(error.code, "TRANSFORM_FAILED");
  assert(!error.message.includes("/srv"));
});


/* ── ingest against a real local multipart server ─────────────────────────────── */

interface Received { folder: string | null; fileName: string | null; bytes: Uint8Array; contentLength: string | null; auth: string | null }

async function withUploadServer<T>(
  respond: (received: Received) => Response,
  run: (cfg: OpeninaryConfig, received: Received[], deletes: string[]) => Promise<T>,
  deleteStatus = 200,
): Promise<T> {
  const received: Received[] = [];
  const deletes: string[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "DELETE") { deletes.push(decodeURIComponent(url.pathname)); return new Response(null, { status: deleteStatus }); }
    // The buffered path lists the folder first; an empty folder answers 404.
    if (req.method === "GET") return new Response(null, { status: 404 });
    const form = await req.formData();
    const file = form.get("files") as File;
    const entry: Received = {
      folder: form.get("folder") as string | null,
      fileName: file?.name ?? null,
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentLength: req.headers.get("content-length"),
      auth: req.headers.get("authorization"),
    };
    received.push(entry);
    return respond(entry);
  });
  try {
    return await run({ serverUrl: `http://127.0.0.1:${server.addr.port}`, apiKey: "test-key", folderPrefix: "postora.cloud" }, received, deletes);
  } finally {
    await server.shutdown();
  }
}

function chunked(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (i < chunks.length) controller.enqueue(chunks[i++]); else controller.close(); },
  });
  return new Response(body, { status: 200, headers });
}

function patterned(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  return data;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

const answer = (path: (r: Received) => string, size: (r: Received) => number = (r) => r.bytes.length) =>
  (r: Received) => new Response(JSON.stringify({ success: true, files: [{ path: path(r), size: size(r) }] }), { status: 200, headers: { "content-type": "application/json" } });
const echo = answer((r) => `${r.folder}/${r.fileName}`);

// The shared helpers deleteFromOpeninary and listOpeninaryFolder (unchanged) do not read replies they ignore (a DELETE, an empty-folder 404); Deno's resource
// sanitizer would flag those bodies in the tests that go through them.
const cleanupTest = { sanitizeResources: false };

Deno.test({
  name: "a rendition of a known, modest size takes the production upload path with its length declared",
  ...cleanupTest,
  fn: async () => {
  const data = patterned(300_000);
  await withUploadServer(echo, async (cfg, received) => {
    const source = chunked([data.slice(0, 100_000), data.slice(100_000, 250_000), data.slice(250_000)], { "content-length": String(data.length) });
    const result = await ingestVariant(cfg, source, "postora.cloud/media/u/2026-10-30", "postora_crop_1_abc.mp4");
    assertEquals(result.path, "postora.cloud/media/u/2026-10-30/postora_crop_1_abc.mp4");
    assertEquals(result.url, `${cfg.serverUrl}/t/postora.cloud/media/u/2026-10-30/postora_crop_1_abc.mp4`);
    assertEquals(result.bytes, data.length);
    assertEquals(received.length, 1);
    assertEquals(received[0].folder, "postora.cloud/media/u/2026-10-30");
    assertEquals(received[0].fileName, "postora_crop_1_abc.mp4");
    assertEquals(received[0].auth, "Bearer test-key");
    assert(sameBytes(received[0].bytes, data), "uploaded bytes differ from the rendition");
    assert(received[0].contentLength !== null);
  });
  },
});

Deno.test({
  name: "a rendition above the buffering threshold is streamed with the exact bytes",
  ...cleanupTest,
  fn: async () => {
  const size = BUFFERED_UPLOAD_MAX_BYTES + 1_000_000;
  const data = patterned(size);
  const slices: Uint8Array[] = [];
  for (let at = 0; at < size; at += 1_000_000) slices.push(data.slice(at, at + 1_000_000));
  await withUploadServer(echo, async (cfg, received) => {
    const result = await ingestVariant(cfg, chunked(slices, { "content-length": String(size) }), "f", "v.mp4");
    assertEquals(result.bytes, size);
    assertEquals(received.length, 1);
    assertEquals(received[0].folder, "f");
    assertEquals(received[0].fileName, "v.mp4");
    assertEquals(received[0].auth, "Bearer test-key");
    assert(sameBytes(received[0].bytes, data), "streamed bytes differ from the rendition");
  });
  },
});

Deno.test({
  name: "a rendition that streams without a length is streamed too",
  ...cleanupTest,
  fn: async () => {
  const data = patterned(120_000);
  await withUploadServer(echo, async (cfg, received) => {
    const result = await ingestVariant(cfg, chunked([data.slice(0, 60_000), data.slice(60_000)]), "f", "v.mp4");
    assertEquals(result.bytes, data.length);
    assert(sameBytes(received[0].bytes, data));
  });
  },
});

const collision = answer((r) => `${r.folder}/${r.fileName!.replace(".mp4", " (1).mp4")}`);

Deno.test({
  name: "a collision rename is a failure and the renamed object is removed (modest size)",
  ...cleanupTest,
  fn: async () => {
    await withUploadServer(collision, async (cfg, _received, deletes) => {
      const source = chunked([patterned(1000)], { "content-length": "1000" });
      assertEquals(await code(ingestVariant(cfg, source, "f", "v.mp4")), "STORE_FAILED");
      assertEquals(deletes, ["/api/storage/f/v (1).mp4"]);
    });
  },
});

Deno.test({
  name: "a collision rename is a failure and the renamed object is removed (streamed)",
  ...cleanupTest,
  fn: async () => {
    await withUploadServer(collision, async (cfg, _received, deletes) => {
      assertEquals(await code(ingestVariant(cfg, chunked([patterned(1000)]), "f", "v.mp4")), "STORE_FAILED");
      assertEquals(deletes, ["/api/storage/f/v (1).mp4"]);
    });
  },
});

Deno.test({
  name: "a streamed upload whose stored size differs from the bytes sent fails and removes the object",
  ...cleanupTest,
  fn: async () => {
    await withUploadServer(answer((r) => `${r.folder}/${r.fileName}`, () => 5), async (cfg, _received, deletes) => {
      assertEquals(await code(ingestVariant(cfg, chunked([patterned(1000)]), "f", "v.mp4")), "STORE_FAILED");
      assertEquals(deletes, ["/api/storage/f/v.mp4"]);
    });
  },
});

Deno.test({
  name: "an upload Openinary refuses is a store failure with a generic message",
  ...cleanupTest,
  fn: async () => {
  await withUploadServer(() => new Response(JSON.stringify({ success: false, error: "File too large: /srv/data" }), { status: 400 }), async (cfg) => {
    for (const source of [chunked([patterned(1000)], { "content-length": "1000" }), chunked([patterned(1000)])]) {
      const error = await assertRejects(() => ingestVariant(cfg, source, "f", "v.mp4"), OpeninaryVideoError);
      assertEquals(error.code, "STORE_FAILED");
      assert(!error.message.includes("/srv"));
    }
  });
  },
});

Deno.test({
  name: "a rendition declared larger than the storage limit is refused before any upload",
  ...cleanupTest,
  fn: async () => {
  await withUploadServer(echo, async (cfg, received) => {
    const source = chunked([patterned(10)], { "content-length": String(MAX_DERIVED_BYTES + 1) });
    assertEquals(await code(ingestVariant(cfg, source, "f", "v.mp4")), "RESULT_TOO_LARGE");
    assertEquals(received.length, 0);
  });
  },
});

Deno.test({
  name: "a rendition without a length that grows past the limit is cut off mid-stream",
  ...cleanupTest,
  fn: async () => {
  const mb = new Uint8Array(1024 * 1024);
  const chunks = Array.from({ length: 52 }, () => mb);
  await withUploadServer(echo, async (cfg, received) => {
    assertEquals(await code(ingestVariant(cfg, chunked(chunks), "f", "v.mp4")), "RESULT_TOO_LARGE");
    assertEquals(received.length, 0);
  });
  },
});

Deno.test({
  name: "a rendition that ends before its declared length is not stored",
  ...cleanupTest,
  fn: async () => {
  await withUploadServer(echo, async (cfg, received) => {
    const source = chunked([patterned(500)], { "content-length": "1000" });
    await assertRejects(() => ingestVariant(cfg, source, "f", "v.mp4"));
    assertEquals(received.length, 0);
  });
  },
});

Deno.test({
  name: "a folder or name that could break the multipart framing is refused",
  ...cleanupTest,
  fn: async () => {
  await withUploadServer(echo, async (cfg, received) => {
    assertEquals(await code(ingestVariant(cfg, chunked([patterned(10)]), "f", 'v"\r\nx.mp4')), "STORE_FAILED");
    assertEquals(await code(ingestVariant(cfg, chunked([patterned(10)]), "f\r\nInjected: 1", "v.mp4")), "STORE_FAILED");
    assertEquals(received.length, 0);
  });
  },
});

/* ── deadline and network failures ───────────────────────────────────────────── */

Deno.test("a request never outlasts the transform deadline, even with a 30 s request timeout", async () => {
  const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })) as typeof fetch;
  const started = Date.now();
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: hanging, deadlineMs: 800 })), "TRANSFORM_STILL_PROCESSING");
  assert(Date.now() - started < 5_000, "the request was allowed to run past the deadline");
});

Deno.test("with too little of the deadline left no request is made at all", async () => {
  const net = scripted();
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: net.fetchImpl, deadlineMs: 100 })), "TRANSFORM_STILL_PROCESSING");
  assertEquals(net.urls.length, 0);
});

Deno.test("polling sleeps are capped at the time left", async () => {
  let clock = 0;
  const sleeps: number[] = [];
  const net = scripted(json({ statusUrl: "/video-status/x" }, 202), json({ status: "processing" }), json({ status: "processing" }));
  await assertRejects(
    () => fetchVideoVariant(config, SEGMENT, PATH, {
      fetchImpl: net.fetchImpl,
      deadlineMs: 2_000,
      now: () => clock,
      sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    }),
    OpeninaryVideoError,
  );
  assertEquals(sleeps, [1_500, 500]);
});

Deno.test("a rejected rendition request is a provider problem, not an unexpected error", async () => {
  const refused = (() => Promise.reject(new TypeError("error sending request: connection refused"))) as typeof fetch;
  const error = await assertRejects(() => fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: refused }), OpeninaryVideoError);
  assertEquals(error.code, "PROVIDER_UNAVAILABLE");
  assertEquals(error.status, 503);
  assert(!error.message.includes("connection refused"));
});

Deno.test("a header timeout on the rendition request is still-processing, not a 500", async () => {
  const timedOut = (() => Promise.reject(new DOMException("The signal has been aborted", "AbortError"))) as typeof fetch;
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl: timedOut })), "TRANSFORM_STILL_PROCESSING");
});

Deno.test("a network failure while polling the status is a provider problem", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return calls === 1 ? Promise.resolve(json({ statusUrl: "/video-status/x" }, 202)) : Promise.reject(new TypeError("socket closed"));
  }) as typeof fetch;
  assertEquals(await code(fetchVideoVariant(config, SEGMENT, PATH, { fetchImpl, sleep: () => Promise.resolve() })), "PROVIDER_UNAVAILABLE");
});

Deno.test({
  name: "a streamed rendition that ends short of its declared length is not accepted when Openinary omits the stored size",
  ...cleanupTest,
  fn: async () => {
    const noSize = (r: Received) => new Response(JSON.stringify({ success: true, files: [{ path: `${r.folder}/${r.fileName}` }] }), { status: 200 });
    await withUploadServer(noSize, async (cfg, _received, deletes) => {
      const declared = BUFFERED_UPLOAD_MAX_BYTES + 1_000_000;
      const source = chunked([patterned(1_000_000)], { "content-length": String(declared) });
      assertEquals(await code(ingestVariant(cfg, source, "f", "v.mp4")), "STORE_FAILED");
      assertEquals(deletes, ["/api/storage/f/v.mp4"]);
    });
  },
});

Deno.test({
  name: "a renamed object that cannot be removed rides on the error with its key; a removed one does not",
  ...cleanupTest,
  fn: async () => {
    const unremoved = await withUploadServer(collision, async (cfg) => {
      const error = await assertRejects(() => ingestVariant(cfg, chunked([patterned(1000)]), "f", "v.mp4"), OpeninaryVideoError);
      return error.unremovedObject;
    }, 500);
    assertEquals(unremoved?.key, "f/v (1).mp4");
    const removed = await withUploadServer(collision, async (cfg) => {
      const error = await assertRejects(() => ingestVariant(cfg, chunked([patterned(1000)]), "f", "v.mp4"), OpeninaryVideoError);
      return error.unremovedObject;
    });
    assertEquals(removed, undefined);
  },
});
