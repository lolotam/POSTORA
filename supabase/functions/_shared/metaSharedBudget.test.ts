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

for (const status of [200, 400]) for (const code of [4, 17, 32, 613]) {
  Deno.test(`HTTP ${status} Graph code ${code} persists a shared pause without consuming the caller body`, async () => {
    let pause: unknown = null;
    let calls = 0;
    const rpc: MetaBudgetRpc = async (name, args) => {
      if (name === "read_meta_analytics_provider_throttle") return { error: null, data: pause };
      pause = { throttled_until: args.p_throttled_until };
      return { error: null, data: { bucket_key: args.p_bucket_key, throttled_until: args.p_throttled_until } };
    };
    const options = { rpc, apps: { facebook: "200001" }, fetcher: () => {
      calls++;
      return Promise.resolve(Response.json({ error: { code } }, { status, headers: { "retry-after": "259200" } }));
    } };
    const transport = sharedMetaBudgetFetch(options);
    const response = await transport("https://graph.facebook.com/v22.0/me");
    assertEquals(response.bodyUsed, false);
    assertEquals(await response.json(), { error: { code } });
    const otherWorker = sharedMetaBudgetFetch(options);
    const refused = await otherWorker("https://graph.facebook.com/v25.0/me", {
      headers: { Authorization: `Bearer ${crypto.randomUUID()}` },
    });
    await refused.json();
    assertEquals(refused.status, 429);
    assertEquals(Number(refused.headers.get("retry-after")) >= 259199, true);
    assertEquals(calls, 1);
  });
}

Deno.test("large successful collections remain readable without waiting for the uninspected stream tail", async () => {
  const prefix = '{"data":[{"caption":"' + "x".repeat(65_536);
  const tail = '"}]}';
  let finish: () => void = () => undefined;
  const tailReady = new Promise<void>((resolve) => { finish = resolve; });
  let writes = 0;
  const rpc: MetaBudgetRpc = async (name) => {
    if (name !== "read_meta_analytics_provider_throttle") writes++;
    return { error: null, data: null };
  };
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      await tailReady;
      controller.enqueue(new TextEncoder().encode(tail));
      controller.close();
    },
  });
  try {
    const response = await sharedMetaBudgetFetch({ rpc, apps: { facebook: "200001" },
      fetcher: () => Promise.resolve(new Response(source)),
    })("https://graph.facebook.com/v25.0/me", { signal: AbortSignal.timeout(1_000) });
    assertEquals(response.bodyUsed, false);
    finish();
    assertEquals(await response.text(), prefix + tail);
    assertEquals(writes, 0);
  } finally { finish(); }
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
