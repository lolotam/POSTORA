// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleGenerateImageRequest, type GenerateImageHandlerDeps } from "./handler.ts";

type Calls = { inserts: Array<[string, unknown]>; rpcs: Array<[string, unknown]>; fetches: string[] };
function fakeClient(opts: { admin?: boolean; calls: Calls }) {
  const tableData: Record<string, unknown> = { user_roles: opts.admin ? { role: "admin" } : null };
  const builder = (table: string) => {
    const result = { data: tableData[table] ?? null, error: null, count: 0 };
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => void) => res(result);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(result);
        if (prop === "insert") return (row: unknown) => { opts.calls.inserts.push([table, row]); return b; };
        return () => b;
      },
    });
    return b;
  };
  return {
    from: builder,
    rpc: (name: string, args: unknown) => { opts.calls.rpcs.push([name, args]); return Promise.resolve({ data: name === "enqueue_ai_image_job" ? "job-1" : null, error: null }); },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } }, error: null }) },
    storage: { from: () => ({ remove: () => Promise.resolve({ error: null }) }) },
  };
}
function run(body: unknown, opts: { admin?: boolean; googleOk?: boolean } = {}) {
  const calls: Calls = { inserts: [], rpcs: [], fetches: [] };
  // This fake implements only the SDK operations exercised by the HTTP boundary.
  const client = fakeClient({ admin: opts.admin ?? true, calls }) as unknown as GenerateImageHandlerDeps["admin"];
  const originalKey = Deno.env.get("GOOGLE_AI_STUDIO_KEY");
  Deno.env.set("GOOGLE_AI_STUDIO_KEY", "test-key");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.fetches.push(url);
    if (url.endsWith("/functions/v1/ai-image-worker")) return new Response("{}", { status: 202 });
    if (!url.includes(":generateContent")) throw new Error(`unexpected fetch ${url}`);
    return opts.googleOk === false
      ? new Response("boom", { status: 500 })
      : Response.json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "AAAA" } }, { text: "a cat" }] } }] });
  }) as typeof fetch;
  const req = new Request("http://local/generate-image", {
    method: "POST", headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return handleGenerateImageRequest(req, { admin: client, userClient: () => client, serviceRoleCallerUserId: async () => null })
    .then(async (res) => ({ res, json: await res.json(), calls }))
    .finally(() => {
      globalThis.fetch = realFetch;
      if (originalKey === undefined) Deno.env.delete("GOOGLE_AI_STUDIO_KEY");
      else Deno.env.set("GOOGLE_AI_STUDIO_KEY", originalKey);
    });
}

Deno.test("sync success: 200 { imageUrl, description } with rate-limit headers, nothing queued", async () => {
  const { res, json, calls } = await run({ prompt: "a cat" });
  assertEquals(res.status, 200);
  assertEquals(json, { imageUrl: "data:image/png;base64,AAAA", description: "a cat" });
  for (const h of ["X-RateLimit-Limit-Hour", "X-RateLimit-Limit-Day", "X-RateLimit-Remaining-Hour", "X-RateLimit-Remaining-Day"]) {
    assert(/^\d+$/.test(res.headers.get(h) ?? ""), `${h} present`);
  }
  assertEquals(calls.rpcs.filter(([n]) => n === "enqueue_ai_image_job").length, 0);
  assertEquals(calls.inserts.filter(([t]) => t === "ai_image_job_payloads").length, 0);
});
Deno.test("sync provider failure: 200 { success:false, error_code, message }", async () => {
  const { res, json } = await run({ prompt: "a cat" }, { googleOk: false });
  assertEquals(res.status, 200);
  assertEquals(json.success, false);
  assertEquals(json.error_code, "ai_not_configured");
  assert(String(json.message).includes("All image providers failed"));
});
Deno.test("no AI access: 403", async () => {
  const { res } = await run({ prompt: "a cat" }, { admin: false });
  assertEquals(res.status, 403);
});
Deno.test("invalid body: 400 before any provider call", async () => {
  const { res } = await run({ prompt: "" });
  assertEquals(res.status, 400);
});

Deno.test("async: queues exactly once, answers 202, and never calls the provider", async () => {
  const { res, json, calls } = await run({ prompt: "a cat", async: true });
  assertEquals(res.status, 202);
  assertEquals(json, { success: true, jobId: "job-1", status: "queued" });
  assertEquals(calls.rpcs.filter(([name]) => name === "enqueue_ai_image_job").length, 1);
  assertEquals(calls.fetches.filter((url) => url.includes(":generateContent")).length, 0);
});
