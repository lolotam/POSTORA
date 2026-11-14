import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sharedMetaBudgetFetch, type MetaBudgetRpc } from "./metaSharedBudget.ts";

Deno.test("bootstrap app pause stops collection and discovery across distinct credentials without provider calls", async () => {
  const meters = new Map<string, unknown>();
  let calls = 0;
  const rpc: MetaBudgetRpc = async (name, args) => {
    if (name === "read_meta_analytics_provider_throttle") return { error: null, data: meters.get(String(args.p_bucket_key)) ?? null };
    meters.set(String(args.p_bucket_key), { throttled_until: args.p_throttled_until, usage_percent: args.p_usage_percent });
    return { error: null, data: { bucket_key: args.p_bucket_key, throttled_until: args.p_throttled_until, usage_percent: args.p_usage_percent } };
  };
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ id: "100001" }, { headers: { "x-app-usage": '{"call_count":85}' } }); };
  const options = { rpc, apps: { facebook: "200001" }, fetcher };
  const collector = sharedMetaBudgetFetch(options);
  const first = await collector("https://graph.facebook.com/v25.0/me", { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
  await first.json();
  const discovery = sharedMetaBudgetFetch(options);
  const refused = await discovery("https://graph.facebook.com/v22.0/me", { headers: { Authorization: `Bearer ${crypto.randomUUID()}` } });
  await refused.json();
  assertEquals(refused.status, 429);
  assertEquals(calls, 1);
});
Deno.test("unreadable shared usage fails closed before network and uses caller cancellation", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  const rpc: MetaBudgetRpc = async () => ({ data: null, error: { message: crypto.randomUUID() } });
  await assertRejects(() => sharedMetaBudgetFetch({ rpc, apps: { facebook: "200001" }, fetcher })("https://graph.facebook.com/v22.0/me"));
  const hanging: MetaBudgetRpc = () => new Promise(() => {});
  await assertRejects(() => sharedMetaBudgetFetch({ rpc: hanging, apps: { facebook: "200001" }, fetcher })("https://graph.facebook.com/v22.0/me", { signal: AbortSignal.timeout(30) }));
  assertEquals(calls, 0);
});

Deno.test("Graph code throttles persist shared pauses without consuming the caller body", async () => {
  for (const code of [4, 17, 32, 613]) {
    const writes: Record<string, unknown>[] = [];
    const rpc: MetaBudgetRpc = async (name, args) => {
      if (name === "read_meta_analytics_provider_throttle") return { error: null, data: null };
      writes.push(args);
      return { error: null, data: { bucket_key: args.p_bucket_key, throttled_until: args.p_throttled_until } };
    };
    const transport = sharedMetaBudgetFetch({ rpc, apps: { facebook: "200001" },
      fetcher: () => Promise.resolve(Response.json({ error: { code } }, { status: 400, headers: { "retry-after": "259200" } })) });
    const response = await transport("https://graph.facebook.com/v22.0/me");
    assertEquals(await response.json(), { error: { code } });
    assertEquals(writes.length, 1);
    assertEquals(Date.parse(String(writes[0].p_throttled_until)) > Date.now() + 2 * 86_400_000, true);
  }
});

Deno.test("Graph throttle inspection refuses oversized or stalled bodies within the caller deadline", async () => {
  const rpc: MetaBudgetRpc = () => Promise.resolve({ error: null, data: null });
  for (const oversized of [true, false]) {
    const fetcher: typeof fetch = () => Promise.resolve(oversized ? new Response(" ".repeat(65_537), { status: 400 })
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); } }), { status: 400 }));
    const started = Date.now();
    await assertRejects(() => sharedMetaBudgetFetch({ rpc, apps: { facebook: "200001" }, fetcher })(
      "https://graph.facebook.com/v22.0/me", { signal: AbortSignal.timeout(40) }));
    assertEquals(Date.now() - started < 500, true);
  }
});
