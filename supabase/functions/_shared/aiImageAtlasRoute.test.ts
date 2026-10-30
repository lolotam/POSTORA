import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ATLAS_JOBS_PER_HOUR,
  invalidInput,
  providerUnavailable,
  resumeAtlasRoute,
  startAtlasRoute,
  type AtlasRoute,
  type RouteCaller,
  type RouteEnv,
} from "./aiImageAtlasRoute.ts";
import type { AtlasJobDeps } from "./aiImageJob.ts";
import { signJobToken, type JobTokenPayload } from "./aiImageToken.ts";
import type { AtlasCheckResult } from "./atlasCloudImage.ts";
import type { FetchedImage } from "./aiImageIo.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
const env: RouteEnv = { atlasApiKey: "test-key", secret: "test-signing-key" };
const T0 = 7_000_000;

const route: AtlasRoute = {
  source: "remove-background",
  operation: "background_removal",
  area: "processed",
  failureCode: "JOB_FAILED",
  messages: { unavailable: "UNAVAILABLE", busy: "BUSY", timeout: "TIMEOUT", failed: "FAILED" },
  completedBody: (job) => ({ success: true, processed_url: job.resultUrl, original_url: job.meta.original_url ?? null }),
};

interface LogRow {
  level: string;
  source: string;
  message: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
}

/** A database that answers the rate-limit RPC and records every `system_logs` insert. */
function fakeDb(rateAllowed = true) {
  const rows: LogRow[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({
        data: rateAllowed ? { allowed: true, count: 1, remaining: 29, retryAfter: 0 } : { allowed: false, count: 31, remaining: 0, retryAfter: 100 },
        error: null,
      });
    },
    from: (table: string) => {
      if (table === "system_logs") {
        return { insert: (row: LogRow) => { rows.push(row); return Promise.resolve({ error: null }); } };
      }
      const query = { select: () => query, eq: () => query, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
      return query;
    },
  };
  return { db: db as unknown as SupabaseClient, rows, rpcCalls };
}

const caller = (db: SupabaseClient, userId = "user-a"): RouteCaller => ({ db, userId, startedAt: T0 });

const done: AtlasCheckResult = { ok: true, state: "done", outputUrl: "https://atlas.example/out.png" };
const pending: AtlasCheckResult = { ok: true, state: "pending" };
const fetchedPng: FetchedImage = { ok: true, bytes: PNG, extension: "png", mime: "image/png" };
function deps(over: { poll?: AtlasCheckResult; check?: AtlasCheckResult } = {}): AtlasJobDeps {
  return {
    submit: () => Promise.resolve({ ok: true, predictionId: "pred-1" }),
    poll: () => Promise.resolve(over.poll ?? done),
    check: () => Promise.resolve(over.check ?? done),
    fetchOutput: () => Promise.resolve(fetchedPng),
    now: () => T0 + 1000,
  };
}

const request = { input: { kind: "url", url: "https://x.example/in.png" } as const, buildBody: (image: string) => ({ image }), meta: { original_url: "https://x.example/in.png" } };

/** Runs with Openinary configured, then restores the environment. */
async function withOpeninaryEnv(run: (deleted: string[]) => Promise<void>): Promise<void> {
  const names = ["OPENINARY_SERVER_URL", "OPENINARY_API_KEY"];
  const before = names.map((n) => Deno.env.get(n));
  Deno.env.set("OPENINARY_SERVER_URL", "https://o.example");
  Deno.env.set("OPENINARY_API_KEY", "test-value");
  const deleted: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      deleted.push(url);
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (url.includes("/api/storage?")) return Promise.resolve(new Response(JSON.stringify({ files: [] })));
    if (url.endsWith("/api/upload")) {
      const form = init?.body as FormData;
      return Promise.resolve(new Response(JSON.stringify({ success: true, files: [{ path: `${form.get("folder")}/${(form.get("files") as File).name}` }] })));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof fetch;
  try {
    await run(deleted);
  } finally {
    globalThis.fetch = original;
    names.forEach((n, i) => {
      const value = before[i];
      if (value === undefined) Deno.env.delete(n);
      else Deno.env.set(n, value);
    });
  }
}

Deno.test("start: a job that finishes in time is a 200 with the result", async () => {
  await withOpeninaryEnv(async () => {
    const { db, rpcCalls } = fakeDb();
    const response = await startAtlasRoute(route, caller(db), env, request, deps());
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals([body.status, body.success, body.original_url], ["completed", true, "https://x.example/in.png"]);
    assertEquals(body.processed_url.startsWith("https://o.example/t/"), true);
    // each paid job is counted against the caller's hourly cap
    assertEquals(rpcCalls[0].args, { p_endpoint: "remove-background:atlascloud", p_identifier: "user:user-a", p_max_requests: ATLAS_JOBS_PER_HOUR, p_window_seconds: 3600 });
  });
});

Deno.test("start: a job still running is a 202 with an opaque prediction_id, not the provider's id", async () => {
  await withOpeninaryEnv(async () => {
    const { db } = fakeDb();
    const response = await startAtlasRoute(route, caller(db), env, request, deps({ poll: pending }));
    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals([body.success, body.status, body.platform, body.original_url], [true, "processing", "atlascloud", "https://x.example/in.png"]);
    assertEquals(typeof body.prediction_id === "string" && body.prediction_id.includes("."), true);
    assertEquals(String(body.prediction_id).includes("pred-1"), false); // the signed envelope is not a bare provider id
    assertEquals(body.retry_after_seconds > 0, true);
  });
});

Deno.test("start: the hourly cap refuses the 31st job with 429 RATE_LIMITED and leaves a log row", async () => {
  const { db, rows } = fakeDb(false);
  const response = await startAtlasRoute(route, caller(db), env, request, deps());
  assertEquals(response.status, 429);
  assertEquals((await response.json()).code, "RATE_LIMITED");
  assertEquals(rows.length, 1);
  assertEquals([rows[0].source, rows[0].level, rows[0].user_id], ["remove-background", "warn", "user-a"]);
  assertEquals(rows[0].metadata.code, "RATE_LIMITED");
  assertEquals(rows[0].metadata.reason, "rate_limited");
});

Deno.test("refusals write a system_logs row with the user, the operation and the code, and never the image URL", async () => {
  const { db, rows } = fakeDb();
  const invalid = await invalidInput(route, caller(db), 413, "Image is larger than 10 MB");
  assertEquals(invalid.status, 413);
  const unavailable = await providerUnavailable(route, caller(db), "UNAVAILABLE", "no_provider_usable");
  assertEquals([unavailable.status, (await unavailable.json()).code], [503, "PROVIDER_UNAVAILABLE"]);

  assertEquals(rows.map((r) => [r.level, r.metadata.code, r.metadata.reason, r.metadata.operation, r.user_id]), [
    ["warn", "INVALID_INPUT", "invalid_input", "background_removal", "user-a"],
    ["error", "PROVIDER_UNAVAILABLE", "no_provider_usable", "background_removal", "user-a"],
  ]);
  assertEquals(JSON.stringify(rows).includes("https://"), false);
});

Deno.test("start: without the provider key or the signing secret the answer is a logged 503 and no job starts", async () => {
  for (const broken of [{ ...env, atlasApiKey: "" }, { ...env, secret: "" }]) {
    const { db, rows, rpcCalls } = fakeDb();
    const response = await startAtlasRoute(route, caller(db), broken, request, deps());
    assertEquals(response.status, 503);
    assertEquals(rows.length, 1);
    assertEquals(rpcCalls.length, 0);
  }
});

async function tokenFor(userId: string, over: Partial<JobTokenPayload> = {}, issuedAt = Date.now() - 60_000): Promise<string> {
  return signJobToken(env.secret, userId, {
    prediction: "pred-1",
    staged: "postora.cloud/postora/user-a/ai-tmp/in.png",
    operation: "background_removal",
    area: "processed",
    issuedAt,
    meta: { original_url: "https://x.example/in.png" },
    ...over,
  });
}

Deno.test("resume: a finished job answers the normal success body, with the values carried by the token", async () => {
  await withOpeninaryEnv(async (deleted) => {
    const { db } = fakeDb();
    const response = await resumeAtlasRoute(route, caller(db), env, await tokenFor("user-a"), deps({ check: done }));
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals([body.status, body.original_url], ["completed", "https://x.example/in.png"]);
    assertEquals(deleted.length, 1); // the staged input is removed
  });
});

Deno.test("resume: a job that is still running is another 202 with the same token", async () => {
  await withOpeninaryEnv(async (deleted) => {
    const { db } = fakeDb();
    const token = await tokenFor("user-a");
    const response = await resumeAtlasRoute(route, caller(db), env, token, deps({ check: pending }));
    assertEquals(response.status, 202);
    assertEquals((await response.json()).prediction_id, token);
    assertEquals(deleted.length, 0);
  });
});

Deno.test("resume: another user's token, a forged one and a token for the other tool are all the same 400, logged", async () => {
  const { db, rows } = fakeDb();
  const others = [
    await tokenFor("user-b"), // issued to someone else
    `${(await tokenFor("user-a")).split(".")[0]}.AAAA`, // forged signature
    await tokenFor("user-a", { operation: "upscale", area: "upscaled" }), // the other function's job
    "not-a-token",
  ];
  for (const token of others) {
    const response = await resumeAtlasRoute(route, caller(db), env, token, deps());
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "INVALID_PREDICTION");
  }
  assertEquals(rows.map((r) => r.metadata.reason), ["token_forged", "token_forged", "token_wrong_operation", "token_malformed"]);
});

Deno.test("resume: an expired token is 410, and its staged input is still removed", async () => {
  await withOpeninaryEnv(async (deleted) => {
    const { db, rows } = fakeDb();
    const old = await tokenFor("user-a", {}, Date.now() - 2 * 60 * 60 * 1000);
    const response = await resumeAtlasRoute(route, caller(db), env, old, deps());
    assertEquals(response.status, 410);
    assertEquals((await response.json()).code, "PREDICTION_EXPIRED");
    assertEquals(deleted.length, 1);
    assertEquals(rows[0].metadata.reason, "token_expired");
  });
});

Deno.test("resume: a job the provider reports as failed is a mapped error, logged, and the staged input is removed", async () => {
  await withOpeninaryEnv(async (deleted) => {
    const { db, rows } = fakeDb();
    const response = await resumeAtlasRoute(
      route,
      caller(db),
      env,
      await tokenFor("user-a"),
      deps({ check: { ok: false, kind: "failed", httpStatus: 502, detail: "provider text" } }),
    );
    assertEquals(response.status, 502);
    assertEquals(JSON.stringify(await response.json()), JSON.stringify({ success: false, error: "FAILED", code: "JOB_FAILED" }));
    assertEquals(deleted.length, 1);
    assertEquals(rows[0].metadata.reason, "failed");
    assertEquals(JSON.stringify(rows).includes("provider text"), false);
  });
});
