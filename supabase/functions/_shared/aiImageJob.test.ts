import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FINISH_BUDGET_MS,
  POLL_BUDGET_MS,
  abandonAtlasImageJob,
  resumeAtlasImageJob,
  startAtlasImageJob,
  type AtlasJobBase,
  type AtlasJobDeps,
  type StartSpec,
} from "./aiImageJob.ts";
import type { AtlasCheckResult, AtlasSubmitResult } from "./atlasCloudImage.ts";
import { resultNameFor, type FetchedImage, type ImageInput } from "./aiImageIo.ts";
import type { JobTokenPayload } from "./aiImageToken.ts";
import type { OpeninaryConfig } from "./openinary.ts";

const openinary: OpeninaryConfig = { serverUrl: "https://o.example", apiKey: "fixture-value-1", folderPrefix: "postora.cloud" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
const urlInput: ImageInput = { kind: "url", url: "https://x.example/in.png" };
const bytesInput: ImageInput = { kind: "bytes", bytes: PNG, extension: "png", mime: "image/png" };
const T0 = 5_000_000;

const messages = { unavailable: "UNAVAILABLE", busy: "BUSY", timeout: "TIMEOUT", failed: "FAILED" };
const base = (over: Partial<AtlasJobBase> = {}): AtlasJobBase => ({
  operation: "background_removal",
  userId: "user-1",
  openinary,
  atlasApiKey: "fixture-value-1",
  area: "processed",
  startedAt: T0,
  sign: (payload) => Promise.resolve(`signed:${payload.prediction}:${payload.staged ?? "none"}`),
  messages,
  failureCode: "JOB_FAILED",
  meta: { original_url: "https://x.example/in.png" },
  ...over,
});
const start = (over: Partial<StartSpec> = {}): StartSpec => ({ ...base(), input: urlInput, buildBody: (image) => ({ model: "m", image }), ...over });

const done: AtlasCheckResult = { ok: true, state: "done", outputUrl: "https://atlas.example/out.png" };
const pending: AtlasCheckResult = { ok: true, state: "pending" };
const fetchedPng: FetchedImage = { ok: true, bytes: PNG, extension: "png", mime: "image/png" };

interface Seen {
  submitted: unknown[];
  polls: Array<{ deadline: number }>;
  checks: string[];
  outputFetches: Array<{ url: string; timeoutMs?: number }>;
}
function deps(over: {
  submit?: AtlasSubmitResult;
  poll?: AtlasCheckResult;
  check?: AtlasCheckResult;
  output?: FetchedImage;
  now?: () => number;
  /** Runs when the submit call is made, to move a fake clock. */
  onSubmit?: () => void;
  /** Runs when polling starts: the job "finishes" only after this much has happened. */
  onPoll?: () => void;
} = {}) {
  const seen: Seen = { submitted: [], polls: [], checks: [], outputFetches: [] };
  const d: AtlasJobDeps = {
    submit: (options) => {
      seen.submitted.push(options.body);
      over.onSubmit?.();
      return Promise.resolve(over.submit ?? { ok: true, predictionId: "pred-9" });
    },
    poll: (options) => {
      seen.polls.push({ deadline: options.deadline });
      over.onPoll?.();
      return Promise.resolve(over.poll ?? done);
    },
    check: (options) => {
      seen.checks.push(options.predictionId);
      return Promise.resolve(over.check ?? done);
    },
    fetchOutput: (url, options) => {
      seen.outputFetches.push({ url, timeoutMs: options?.timeoutMs });
      return Promise.resolve(over.output ?? fetchedPng);
    },
    now: over.now ?? (() => T0 + 1000),
  };
  return { deps: d, seen };
}

type Call = { method: string; url: string };
/** Stands in for Openinary: stores uploads at folder/name, accepts deletes; `failUpload` refuses writes. */
async function withOpeninary(
  failUpload: boolean,
  run: (calls: Call[]) => Promise<void>,
  /** Called when an upload arrives; may return a promise that holds the answer back. */
  onUpload?: () => void | Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.includes("/api/storage?")) return Promise.resolve(new Response(JSON.stringify({ files: [] })));
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 200 }));
    if (url.endsWith("/api/upload")) {
      const answer = () => {
        if (failUpload) return new Response(JSON.stringify({ success: false, error: "disk full" }), { status: 500 });
        const form = init?.body as FormData;
        return new Response(JSON.stringify({ success: true, files: [{ path: `${form.get("folder")}/${(form.get("files") as File).name}` }] }));
      };
      const held = onUpload?.();
      return held ? held.then(answer) : Promise.resolve(answer());
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}
const deletes = (calls: Call[]) => calls.filter((c) => c.method === "DELETE");

Deno.test("a URL input goes straight to the model; the result is copied into Openinary under a name derived from the prediction", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps();
    const result = await startAtlasImageJob(start(), d);
    assertEquals(seen.submitted, [{ model: "m", image: "https://x.example/in.png" }]);
    assertEquals(seen.outputFetches.map((f) => f.url), ["https://atlas.example/out.png"]);
    assertEquals(result.ok && result.status, "completed");
    if (!result.ok || result.status !== "completed") return;
    assertEquals(result.storedIn, "openinary");
    assertEquals(result.predictionId, "pred-9");
    assertEquals(result.storedPath, `postora.cloud/postora/user-1/processed/${await resultNameFor("pred-9")}.png`);
    assertEquals(result.resultUrl, `https://o.example/t/${result.storedPath}`);
    assertEquals(result.meta, { original_url: "https://x.example/in.png" });
    assertEquals(deletes(calls).length, 0); // nothing was staged
  });
});

Deno.test("polling stops at the poll budget, measured from the start of the request", async () => {
  const { deps: d, seen } = deps();
  await withOpeninary(false, async () => {
    await startAtlasImageJob(start(), d);
  });
  assertEquals(seen.polls, [{ deadline: T0 + POLL_BUDGET_MS }]);
  assertEquals(POLL_BUDGET_MS < FINISH_BUDGET_MS && FINISH_BUDGET_MS <= 45_000, true);
});

Deno.test("an uploaded input is staged for the model and the staged copy is removed once the job is done", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps();
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(result.ok && result.status, "completed");
    const body = seen.submitted[0] as { image: string };
    assertEquals(body.image.startsWith("https://o.example/t/postora.cloud/postora/user-1/ai-tmp/"), true);
    assertEquals(deletes(calls).length, 1);
    assertEquals(deletes(calls)[0].url.includes("/ai-tmp/"), true);
  });
});

Deno.test("a job still running at the budget answers 'processing' with a token and keeps the staged input", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps({ poll: pending });
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(result.ok && result.status, "processing");
    if (!result.ok || result.status !== "processing") return;
    const staged = (seen.submitted[0] as { image: string }).image.replace("https://o.example/t/", "");
    assertEquals(result.token, `signed:pred-9:${staged}`); // the token remembers the staged path
    assertEquals(result.retryAfterSeconds > 0, true);
    assertEquals(deletes(calls).length, 0);
    assertEquals(seen.outputFetches, []);
  });
});

Deno.test("the token records the prediction, operation, result area and the values to report", async () => {
  let signed: JobTokenPayload | null = null;
  const { deps: d } = deps({ poll: pending });
  await startAtlasImageJob(start({ sign: (p) => { signed = p; return Promise.resolve("tok"); } }), d);
  assertEquals(signed, {
    prediction: "pred-9",
    staged: null,
    operation: "background_removal",
    area: "processed",
    issuedAt: T0,
    meta: { original_url: "https://x.example/in.png" },
  });
});

Deno.test("when staging fails, or the model cannot be submitted, the staged copy goes and the failure is mapped", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d } = deps({ submit: { ok: false, kind: "failed", httpStatus: 502, detail: "boom" } });
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(result.ok === false && [result.status, result.code, result.reason], [502, "JOB_FAILED", "failed"]);
    assertEquals(deletes(calls).length, 1);
  });
  await withOpeninary(true, async () => {
    const { deps: d, seen } = deps();
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(result.ok === false && [result.status, result.code, result.reason], [503, "PROVIDER_UNAVAILABLE", "stage_failed"]);
    assertEquals(seen.submitted, []);
  });
});

Deno.test("an uploaded input without Openinary is a 503 and the model is never called", async () => {
  const { deps: d, seen } = deps();
  const result = await startAtlasImageJob(start({ input: bytesInput, openinary: null }), d);
  assertEquals(result.ok === false && [result.status, result.code, result.message, result.reason], [503, "PROVIDER_UNAVAILABLE", "UNAVAILABLE", "openinary_not_configured"]);
  assertEquals(seen.submitted, []);
});

Deno.test("provider failures map to the caller-safe status, code, message and log reason", async () => {
  const cases: Array<[AtlasCheckResult, number, string, string, string]> = [
    [{ ok: false, kind: "provider_rejected", httpStatus: 503, detail: "key revoked" }, 503, "PROVIDER_UNAVAILABLE", "UNAVAILABLE", "provider_rejected"],
    [{ ok: false, kind: "rate_limited", httpStatus: 429, detail: "x" }, 429, "JOB_FAILED", "BUSY", "rate_limited"],
    [{ ok: false, kind: "timeout", httpStatus: 504, detail: "x" }, 504, "JOB_FAILED", "TIMEOUT", "timeout"],
    [{ ok: false, kind: "failed", httpStatus: 502, detail: "raw provider text" }, 502, "JOB_FAILED", "FAILED", "failed"],
    [{ ok: false, kind: "bad_response", httpStatus: 502, detail: "x" }, 502, "JOB_FAILED", "FAILED", "bad_response"],
  ];
  for (const [poll, status, code, message, reason] of cases) {
    const result = await startAtlasImageJob(start(), deps({ poll }).deps);
    assertEquals(result.ok === false && [result.status, result.code, result.message, result.reason], [status, code, message, reason]);
    assertEquals(result.ok === false && JSON.stringify(result).includes("raw provider text"), false);
  }
});

Deno.test("a result that cannot be copied is still returned, from the provider's URL (the job is paid for)", async () => {
  await withOpeninary(true, async () => {
    const result = await startAtlasImageJob(start(), deps().deps);
    assertEquals(result.ok && result.status === "completed" && [result.storedIn, result.resultUrl, result.storedPath], ["provider", "https://atlas.example/out.png", null]);
  });
  await withOpeninary(false, async () => {
    const result = await startAtlasImageJob(start(), deps({ output: { ok: false, error: "output fetch failed: HTTP 404" } }).deps);
    assertEquals(result.ok && result.status === "completed" && [result.storedIn, result.resultUrl, result.output], ["provider", "https://atlas.example/out.png", null]);
  });
});

Deno.test("without Openinary the output is only downloaded when the caller reports its details", async () => {
  const quiet = deps();
  const without = await startAtlasImageJob(start({ openinary: null }), quiet.deps);
  assertEquals(quiet.seen.outputFetches, []);
  assertEquals(without.ok && without.status === "completed" && [without.storedIn, without.output], ["provider", null]);

  const detailed = deps();
  const withDetails = await startAtlasImageJob(start({ openinary: null, wantOutputDetails: true }), detailed.deps);
  assertEquals(detailed.seen.outputFetches.length, 1);
  assertEquals(withDetails.ok && withDetails.status === "completed" && withDetails.output?.extension, "png");
});

Deno.test("a job that finishes near the end of the budget skips the copy and returns the provider URL", async () => {
  await withOpeninary(false, async () => {
    let clock = T0 + 1000;
    const late = deps({ now: () => clock, onPoll: () => { clock = T0 + FINISH_BUDGET_MS - 1000; } }); // done just before the end
    const result = await startAtlasImageJob(start(), late.deps);
    assertEquals(late.seen.outputFetches, []);
    assertEquals(result.ok && result.status === "completed" && [result.storedIn, result.resultUrl], ["provider", "https://atlas.example/out.png"]);
  });
});

Deno.test("the output download never gets more than the time left in the budget", async () => {
  await withOpeninary(false, async () => {
    let clock = T0 + 1000;
    const { deps: d, seen } = deps({ now: () => clock, onPoll: () => { clock = T0 + FINISH_BUDGET_MS - 10_000; } });
    await startAtlasImageJob(start(), d);
    assertEquals(seen.outputFetches[0].timeoutMs, 5_000);
  });
});

const LONG_URL = `https://x.example/in.png?sig=${"a".repeat(600)}`;

Deno.test("a long source URL is reported in full by the request that finishes at once", async () => {
  await withOpeninary(false, async () => {
    const result = await startAtlasImageJob(start({ meta: { original_url: LONG_URL, scale: 4 } }), deps().deps);
    assertEquals(result.ok && result.status === "completed" && result.meta, { original_url: LONG_URL, scale: 4 });
  });
});

Deno.test("a long source URL is capped only inside the token; the 202 answer that carries the token still has it in full", async () => {
  let signed: JobTokenPayload | null = null;
  const { deps: d } = deps({ poll: pending });
  const result = await startAtlasImageJob(start({ meta: { original_url: LONG_URL, scale: 4 }, sign: (p) => { signed = p; return Promise.resolve("tok"); } }), d);
  assertEquals((signed as JobTokenPayload | null)?.meta, { original_url: null, scale: 4 });
  assertEquals(result.ok && result.status === "processing" && result.meta, { original_url: LONG_URL, scale: 4 });
});

const SUBMIT_WINDOW_MS = 10_000;
const refusal = (result: Awaited<ReturnType<typeof startAtlasImageJob>>) =>
  result.ok === false && [result.status, result.code, result.message, result.reason, result.level];

Deno.test("deadline: a job that cannot wait out the submit call is refused with a logged 504 and is never submitted", async () => {
  const late = deps({ now: () => T0 + FINISH_BUDGET_MS - SUBMIT_WINDOW_MS + 1 });
  const result = await startAtlasImageJob(start(), late.deps);
  assertEquals(refusal(result), [504, "JOB_FAILED", "TIMEOUT", "deadline_before_submit", "warn"]);
  assertEquals(late.seen.submitted, []);
  assertEquals(late.seen.polls, []);

  // exactly the submit window left is still enough
  const justEnough = deps({ now: () => T0 + FINISH_BUDGET_MS - SUBMIT_WINDOW_MS });
  const accepted = await startAtlasImageJob(start({ openinary: null }), justEnough.deps);
  assertEquals(justEnough.seen.submitted.length, 1);
  assertEquals(accepted.ok, true);
});

Deno.test("deadline: an upload is not staged at all when the stage and submit windows no longer fit", async () => {
  await withOpeninary(false, async (calls) => {
    const late = deps({ now: () => T0 + FINISH_BUDGET_MS - SUBMIT_WINDOW_MS - 2_999 });
    const result = await startAtlasImageJob(start({ input: bytesInput }), late.deps);
    assertEquals(refusal(result), [504, "JOB_FAILED", "TIMEOUT", "deadline_before_stage", "warn"]);
    assertEquals(calls, []); // nothing uploaded, nothing to clean up
    assertEquals(late.seen.submitted, []);
  });
});

Deno.test("deadline: a slow staging that leaves no submit window removes the staged copy and refuses", async () => {
  let clock = T0 + 1_000;
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps({ now: () => clock });
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(refusal(result), [504, "JOB_FAILED", "TIMEOUT", "deadline_before_submit", "warn"]);
    assertEquals(seen.submitted, []);
    assertEquals(deletes(calls).length, 1);
    assertEquals(deletes(calls)[0].url.includes("/ai-tmp/"), true);
  }, () => {
    clock = T0 + FINISH_BUDGET_MS - SUBMIT_WINDOW_MS + 500; // the upload took ~33 s
  });
});

Deno.test("deadline: staging that outlasts its window is abandoned, nothing is submitted, and a late copy is removed", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  // 3 s is the shortest stage window the job accepts, so this waits about 3 s of real time
  const d = deps({ now: () => T0 + FINISH_BUDGET_MS - SUBMIT_WINDOW_MS - 3_000 });
  await withOpeninary(false, async (calls) => {
    const result = await startAtlasImageJob(start({ input: bytesInput }), d.deps);
    assertEquals(refusal(result), [504, "JOB_FAILED", "TIMEOUT", "deadline_before_stage", "warn"]);
    assertEquals(d.seen.submitted, []);
    assertEquals(deletes(calls).length, 0);
    release(); // the upload finally lands
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(deletes(calls).length, 1); // and is removed, since nothing will reference it
  }, () => held);
});

Deno.test("deadline: a submit that leaves no polling time answers 'processing' at once, without a single poll", async () => {
  let clock = T0 + 1_000;
  const submitTookLong = { onSubmit: () => { clock = T0 + POLL_BUDGET_MS + 1; } };
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps({ now: () => clock, poll: done, ...submitTookLong });
    const result = await startAtlasImageJob(start({ input: bytesInput }), d);
    assertEquals(result.ok && result.status, "processing");
    if (!result.ok || result.status !== "processing") return;
    assertEquals(seen.polls, []);
    assertEquals(seen.outputFetches, []);
    assertEquals(result.token.startsWith("signed:pred-9:postora.cloud/postora/user-1/ai-tmp/"), true); // staged input kept
    assertEquals(deletes(calls).length, 0);
  });
  // exactly at the poll budget there is no time left either
  clock = T0 + 1_000;
  const exact = deps({ now: () => clock, onSubmit: () => { clock = T0 + POLL_BUDGET_MS; } });
  const result = await startAtlasImageJob(start(), exact.deps);
  assertEquals(result.ok && result.status, "processing");
  assertEquals(exact.seen.polls, []);
});

const payload: JobTokenPayload = {
  prediction: "pred-9",
  staged: "postora.cloud/postora/user-1/ai-tmp/in.png",
  operation: "background_removal",
  area: "processed",
  issuedAt: T0 - 60_000,
  meta: { original_url: "https://x.example/in.png" },
};
const resumeSpec = () => ({ ...base({ meta: payload.meta }), token: "fixture-value-2", payload });

Deno.test("resume: still running answers 'processing' again with the same token and keeps the staged input", async () => {
  await withOpeninary(false, async (calls) => {
    const { deps: d, seen } = deps({ check: pending });
    const result = await resumeAtlasImageJob(resumeSpec(), d);
    assertEquals(result.ok && result.status === "processing" && result.token, "fixture-value-2");
    assertEquals(seen.checks, ["pred-9"]);
    assertEquals(deletes(calls).length, 0);
  });
});

Deno.test("resume: a finished job is copied into Openinary, the staged input is removed, and the stored name is the same every time", async () => {
  await withOpeninary(false, async (calls) => {
    const first = await resumeAtlasImageJob(resumeSpec(), deps({ check: done }).deps);
    const again = await resumeAtlasImageJob(resumeSpec(), deps({ check: done }).deps);
    assertEquals(first.ok && first.status === "completed" && first.storedIn, "openinary");
    assertEquals(
      first.ok && first.status === "completed" && first.storedPath,
      again.ok && again.status === "completed" && again.storedPath,
    );
    assertEquals(deletes(calls).length, 2);
    assertEquals(deletes(calls)[0].url.includes("/ai-tmp/in.png"), true);
  });
});

Deno.test("resume: a failed job removes the staged input and reports the failure", async () => {
  await withOpeninary(false, async (calls) => {
    const result = await resumeAtlasImageJob(resumeSpec(), deps({ check: { ok: false, kind: "failed", httpStatus: 502, detail: "x" } }).deps);
    assertEquals(result.ok === false && [result.status, result.code], [502, "JOB_FAILED"]);
    assertEquals(deletes(calls).length, 1);
  });
});

Deno.test("abandon removes the staged input of a token that can no longer be resumed", async () => {
  await withOpeninary(false, async (calls) => {
    await abandonAtlasImageJob(base(), payload, deps().deps);
    assertEquals(deletes(calls).length, 1);
    await abandonAtlasImageJob(base(), { ...payload, staged: null }, deps().deps);
    assertEquals(deletes(calls).length, 1);
  });
});
