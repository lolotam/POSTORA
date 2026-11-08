import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("a warm worker still claims jobs on a later authenticated request", async () => {
  const originalServe = Deno.serve;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const keys = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"];
  const previous = keys.map((key) => Deno.env.get(key));
  let handler: ((req: Request) => Promise<Response>) | undefined;
  let clock = 1000; let claims = 0;
  try {
    Deno.env.set("SUPABASE_URL", "https://worker-fixture.invalid");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-worker-fixture");
    Deno.env.set("CRON_SECRET", "synthetic-cron-fixture");
    Date.now = () => clock;
    Deno.serve = ((fn: (req: Request) => Promise<Response>) => { handler = fn; return {} as Deno.HttpServer; }) as typeof Deno.serve;
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init);
      assertEquals(new URL(req.url).pathname, "/rest/v1/rpc/claim_background_job");
      const body = await req.json();
      assertEquals(body.p_kinds.includes("instagram_story"), true);
      claims++;
      return Response.json([]);
    };
    await import("./index.ts");
    if (!handler) throw new Error("worker route was not registered");
    const request = () => new Request("https://worker-fixture.invalid/worker", { method: "POST", headers: { "x-cron-secret": "synthetic-cron-fixture" } });
    assertEquals((await handler(request())).status, 202);
    clock += 200_000;
    assertEquals((await handler(request())).status, 202);
    assertEquals(claims, 2);
  } finally {
    Deno.serve = originalServe; globalThis.fetch = originalFetch; Date.now = originalNow;
    keys.forEach((key, index) => { if (previous[index] === undefined) Deno.env.delete(key); else Deno.env.set(key, previous[index]!); });
  }
});
