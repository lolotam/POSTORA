import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runAtlasImageJob, type AtlasJobDeps, type AtlasJobSpec } from "./aiImageJob.ts";
import type { AtlasResult } from "./atlasCloudImage.ts";
import type { FetchedImage, ImageInput } from "./aiImageIo.ts";
import type { OpeninaryConfig } from "./openinary.ts";

const openinary: OpeninaryConfig = { serverUrl: "https://o.example", apiKey: "openinary-secret", folderPrefix: "postora.cloud" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
const urlInput: ImageInput = { kind: "url", url: "https://x.example/in.png" };
const bytesInput: ImageInput = { kind: "bytes", bytes: PNG, extension: "png", mime: "image/png" };

const messages = { unavailable: "UNAVAILABLE", busy: "BUSY", timeout: "TIMEOUT", failed: "FAILED" };
const spec = (over: Partial<AtlasJobSpec> = {}): AtlasJobSpec => ({
  operation: "background_removal",
  userId: "user-1",
  input: urlInput,
  openinary,
  atlasApiKey: "atlas-secret",
  buildBody: (image) => ({ model: "m", image }),
  area: "processed",
  messages,
  failureCode: "JOB_FAILED",
  ...over,
});

const atlasOk: AtlasResult = { ok: true, outputUrl: "https://atlas.example/out.png", predictionId: "pred-9" };
const fetchedPng: FetchedImage = { ok: true, bytes: PNG, extension: "png", mime: "image/png" };

type Seen = { atlasBodies: unknown[]; outputFetches: string[] };
function deps(atlas: AtlasResult, output: FetchedImage = fetchedPng): { deps: AtlasJobDeps; seen: Seen } {
  const seen: Seen = { atlasBodies: [], outputFetches: [] };
  return {
    seen,
    deps: {
      runAtlas: (options) => {
        seen.atlasBodies.push(options.body);
        return Promise.resolve(atlas);
      },
      fetchOutput: (url) => {
        seen.outputFetches.push(url);
        return Promise.resolve(output);
      },
    },
  };
}

type Call = { method: string; url: string };
/** Stands in for Openinary: stores uploads at folder/name, accepts deletes; `failUpload` refuses writes. */
async function withOpeninary(failUpload: boolean, run: (calls: Call[]) => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.includes("/api/storage?")) return Promise.resolve(new Response(JSON.stringify({ files: [] })));
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.endsWith("/api/upload")) {
      if (failUpload) return Promise.resolve(new Response(JSON.stringify({ success: false, error: "disk full" }), { status: 500 }));
      const form = init?.body as FormData;
      return Promise.resolve(new Response(JSON.stringify({ success: true, files: [{ path: `${form.get("folder")}/${(form.get("files") as File).name}` }] })));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("a URL input goes straight to the model and the result is copied into Openinary", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps(atlasOk);
    const result = await runAtlasImageJob(spec(), d);
    assertEquals(seen.atlasBodies, [{ model: "m", image: "https://x.example/in.png" }]);
    assertEquals(seen.outputFetches, ["https://atlas.example/out.png"]);
    assertEquals(result.ok, true);
    if (!result.ok) return;
    assertEquals(result.storedIn, "openinary");
    assertEquals(result.predictionId, "pred-9");
    assertEquals(result.resultUrl.startsWith("https://o.example/t/postora.cloud/postora/user-1/processed/"), true);
    assertEquals(result.storedPath === null, false);
    assertEquals(calls.some((c) => c.method === "DELETE"), false); // nothing was staged
  });
});

Deno.test("an uploaded input is staged for the model and the staged copy is removed afterwards", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps(atlasOk);
    const result = await runAtlasImageJob(spec({ input: bytesInput }), d);
    assertEquals(result.ok, true);
    const body = seen.atlasBodies[0] as { image: string };
    assertEquals(body.image.startsWith("https://o.example/t/postora.cloud/postora/user-1/ai-tmp/"), true);
    const deletes = calls.filter((c) => c.method === "DELETE");
    assertEquals(deletes.length, 1);
    assertEquals(deletes[0].url.includes("/ai-tmp/"), true);
  });
});

Deno.test("the staged copy is removed even when the model fails", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d } = deps({ ok: false, kind: "failed", httpStatus: 502, detail: "boom" });
    const result = await runAtlasImageJob(spec({ input: bytesInput }), d);
    assertEquals(result.ok, false);
    assertEquals(calls.filter((c) => c.method === "DELETE").length, 1);
  });
});

Deno.test("an uploaded input without Openinary is a logged 503, and the model is never called", async () => {
  const { deps: d, seen } = deps(atlasOk);
  const result = await runAtlasImageJob(spec({ input: bytesInput, openinary: null }), d);
  assertEquals(result, { ok: false, status: 503, code: "PROVIDER_UNAVAILABLE", message: "UNAVAILABLE" });
  assertEquals(seen.atlasBodies, []);
});

Deno.test("staging that fails is a 503 and the model is never called", async () => {
  await withOpeninary(true, async () => {
    const { deps: d, seen } = deps(atlasOk);
    const result = await runAtlasImageJob(spec({ input: bytesInput }), d);
    assertEquals(result.ok === false && [result.status, result.code], [503, "PROVIDER_UNAVAILABLE"]);
    assertEquals(seen.atlasBodies, []);
  });
});

Deno.test("provider failures map to the caller-safe status, code and message", async () => {
  const cases: Array<[AtlasResult, number, string, string]> = [
    [{ ok: false, kind: "provider_rejected", httpStatus: 503, detail: "key revoked" }, 503, "PROVIDER_UNAVAILABLE", "UNAVAILABLE"],
    [{ ok: false, kind: "rate_limited", httpStatus: 429, detail: "x" }, 429, "JOB_FAILED", "BUSY"],
    [{ ok: false, kind: "timeout", httpStatus: 504, detail: "x" }, 504, "JOB_FAILED", "TIMEOUT"],
    [{ ok: false, kind: "failed", httpStatus: 502, detail: "secret provider text" }, 502, "JOB_FAILED", "FAILED"],
    [{ ok: false, kind: "unreachable", httpStatus: 502, detail: "x" }, 502, "JOB_FAILED", "FAILED"],
  ];
  for (const [atlas, status, code, message] of cases) {
    const result = await runAtlasImageJob(spec(), deps(atlas).deps);
    assertEquals(result, { ok: false, status, code, message });
  }
});

Deno.test("a result that cannot be copied is still returned, from the provider's URL (the job is paid for)", async () => {
  await withOpeninary(true, async () => {
    const result = await runAtlasImageJob(spec(), deps(atlasOk).deps);
    assertEquals(result.ok && [result.storedIn, result.resultUrl, result.storedPath], ["provider", "https://atlas.example/out.png", null]);
  });
  await withOpeninary(false, async () => {
    const result = await runAtlasImageJob(spec(), deps(atlasOk, { ok: false, error: "output fetch failed: HTTP 404" }).deps);
    assertEquals(result.ok && [result.storedIn, result.resultUrl, result.output], ["provider", "https://atlas.example/out.png", null]);
  });
});

Deno.test("without Openinary the output is only downloaded when the caller reports its details", async () => {
  const quiet = deps(atlasOk);
  const withoutDetails = await runAtlasImageJob(spec({ openinary: null }), quiet.deps);
  assertEquals(quiet.seen.outputFetches, []);
  assertEquals(withoutDetails.ok && [withoutDetails.storedIn, withoutDetails.output], ["provider", null]);

  const detailed = deps(atlasOk);
  const withDetails = await runAtlasImageJob(spec({ openinary: null, wantOutputDetails: true }), detailed.deps);
  assertEquals(detailed.seen.outputFetches.length, 1);
  assertEquals(withDetails.ok && withDetails.output?.extension, "png");
});
