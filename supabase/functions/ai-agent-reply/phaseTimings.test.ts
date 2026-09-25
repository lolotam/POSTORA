import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { phaseTimings } from "./logic.ts";

Deno.test("phaseTimings records a milestone as a number and repeated spans as arrays", async () => {
  let clock = 0;
  const timings = phaseTimings(() => clock);

  clock += 300;
  timings.mark("triage");

  await timings.span("model_round", async () => { clock += 1200; });
  await timings.span("model_round", async () => { clock += 900; });

  await timings.span("tool:woocommerce_store", async () => { clock += 150; });
  await timings.span("tool:woocommerce_store", async () => { clock += 90; });

  assertEquals(timings.toJSON(), {
    triage: 300,
    model_round: [1200, 900],
    "tool:woocommerce_store": [150, 90],
  });
});

Deno.test("phaseTimings keeps a failed span's duration and returns its error", async () => {
  let clock = 1000;
  const timings = phaseTimings(() => clock);
  let rejected: unknown = null;
  try {
    await timings.span("model_round", async () => {
      clock += 2000;
      throw new Error("provider down");
    });
  } catch (error) {
    rejected = error;
  }
  assertEquals(rejected instanceof Error, true);
  // A failed round costs the customer the same latency; the timing must survive.
  assertEquals(timings.toJSON(), { model_round: [2000] });
});

Deno.test("phaseTimings attributes each mark to the phase since the previous one", () => {
  let clock = 0;
  const timings = phaseTimings(() => clock);
  clock += 300;
  timings.mark("triage");
  clock += 1200;
  timings.mark("knowledge");
  assertEquals(timings.toJSON(), { triage: 300, knowledge: 1200 });
});

Deno.test("phaseTimings accumulates notes, and a setup mark precedes triage", () => {
  let clock = 0;
  const timings = phaseTimings(() => clock);
  clock += 1000;
  timings.mark("setup");
  clock += 400;
  timings.mark("triage");
  timings.note("prompt_tokens_per_round", 120);
  timings.note("prompt_tokens_per_round", 40);
  timings.note("completion_tokens_per_round", 15);

  const json = timings.toJSON();
  assertEquals(json, {
    setup: 1000,
    triage: 400,
    prompt_tokens_per_round: [120, 40],
    completion_tokens_per_round: [15],
  });
  const keys = Object.keys(json);
  assertEquals(keys.indexOf("setup") < keys.indexOf("triage"), true);
});
