import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const directory = new URL("./", import.meta.url);

async function source(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, directory));
}

Deno.test("contracts stay runtime-neutral for the frontend consumer", async () => {
  const contracts = await source("contracts.ts");
  assertEquals(contracts.includes("Deno."), false);
  assertEquals(contracts.includes("esm.sh"), false);
  assertEquals(contracts.includes("npm:"), false);
});

Deno.test("composition uses health-neutral refresh and never imports dropGrantedScope", async () => {
  const index = await source("index.ts");
  assert(index.includes("createYouTubeAnalyticsHandler(ports)"));
  assert(index.includes("healthNeutral: true"));
  assert(index.includes("recordTransientFailure: false"));
  assert(index.includes("createBoundYouTubeAnalyticsRefreshStore"));
  for (const name of ["index.ts", "handler.ts", "credentials.ts", "analyticsReadClient.ts"]) {
    assertEquals((await source(name)).includes("dropGrantedScope"), false);
  }
});

Deno.test("all Google sends follow a debit and bound decision, and success audit is not awaited", async () => {
  const handler = await source("handler.ts");
  const debitIdx = handler.indexOf("ports.limits.debit");
  const decideIdx = handler.indexOf("ports.decide");
  const sendIdx = handler.indexOf("const result = await send");
  assert(debitIdx >= 0 && debitIdx < sendIdx);
  assert(decideIdx >= 0 && decideIdx < sendIdx);
  assert(handler.includes("scheduleBackground("));
  assert(handler.includes("const finalDecision = await ports.decide"));
  for (const op of ["traffic_sources", "geography", "devices", "retention"]) {
    assert(handler.includes(`z.literal("${op}")`));
  }
  assert(handler.includes("ports.reader.readBreakdown("));
  assert(handler.includes("ports.reader.readRetention("));
});
