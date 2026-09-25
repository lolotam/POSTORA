import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { triageSystemHint } from "./logic.ts";

Deno.test("triage adds a system hint only for handoff and small talk", () => {
  const base = { skipKnowledge: true, smalltalk: false, handoff: false, connectors: [] as string[] };
  assertEquals(triageSystemHint(null), null);
  assertEquals(triageSystemHint(base), null);
  assertEquals(triageSystemHint({ ...base, handoff: true })?.includes("escalate_to_human"), true);
  assertEquals(triageSystemHint({ ...base, smalltalk: true })?.includes("short"), true);
});
