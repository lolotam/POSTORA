// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleGenerateImageRequest } from "./handler.ts";

type Calls = { inserts: Array<[string, unknown]>; rpcs: Array<[string, unknown]> };
function fakeClient(opts: { admin?: boolean; calls: Calls }) {
  const tableData: Record<string, unknown> = { user_roles: opts.admin ? { role: "admin" } : null };
  const builder = (table: string): any => {
    const result = { data: tableData[table] ?? null, error: null, count: 0 };
    const b: any = new Proxy({}, {
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
    rpc: (name: string, args: unknown) => { opts.calls.rpcs.push([name, args]); return Promise.resolve({ data: null, error: null }); },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } }, error: null }) },
    storage: { from: () => ({ remove: () => Promise.resolve({ error: null }) }) },
  };
}
function run(body: unknown, opts: { admin?: boolean; googleOk?: boolean } = {}) {
  const calls: Calls = { inserts: [], rpcs: [] };
  const client = fakeClient({ admin: opts.admin ?? true, calls });
  Deno.env.set("GOOGLE_AI_STUDIO_KEY", "test-key");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
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
    .finally(() => { globalThis.fetch = realFetch; });
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
