import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { triageSystemHint } from "./logic.ts";

Deno.test("triage adds a system hint only for handoff and small talk", () => {
  const base = { skipKnowledge: true, smalltalk: false, handoff: false, connectors: [] as string[] };
  assertEquals(triageSystemHint(null, "en"), null);
  assertEquals(triageSystemHint(base, "en"), null);
  assertEquals(triageSystemHint({ ...base, handoff: true }, "en")?.includes("escalate_to_human"), true);
  assertEquals(triageSystemHint({ ...base, smalltalk: true }, "en")?.includes("short"), true);
});

// "The customer's language" left the model to infer it from the thread, and an Arabic
// order message plus an Arabic persona outvoted a customer's "Thank you" (2026-10-01).
Deno.test("the small-talk hint names the detected language", () => {
  const smalltalk = { skipKnowledge: true, smalltalk: true, handoff: false, connectors: [] as string[] };
  assertEquals(triageSystemHint(smalltalk, "en")?.includes("in English"), true);
  assertEquals(triageSystemHint(smalltalk, "ar")?.includes("in Arabic"), true);
});
