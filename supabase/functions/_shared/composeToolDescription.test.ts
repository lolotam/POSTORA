import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TOOL_DESCRIPTION_BUDGET, composeToolDescription } from "./composeToolDescription.ts";

// What the model is told about a connector before it decides to call one.
//
// Today it gets `tool.description` -- whatever the user typed -- and one
// free-text `request` parameter, and nothing about WHEN to reach for the tool.
// This composes the registry's guide for the connector TYPE with the user's
// text about THEIR instance, which is the "skill file" reaching the model
// rather than sitting in docs/ where the runtime never reads it.

const guide = {
  whenToUse: "Live product, stock and order data for this store.",
  requestExamples: ["stock level for SKU ABC-12", "status of order 10432"],
  limits: "Reads only. Cannot place, refund or modify an order.",
};

Deno.test("the guide is sent before the user's own text", () => {
  // The guide says whether to call the tool at all; the user's text says which
  // shop it is. A model that reads the second first has to hold the whole
  // string before it can decide anything.
  const composed = composeToolDescription("Our Kuwait store, prices in KWD.", guide);
  assertEquals(composed.indexOf(guide.whenToUse) < composed.indexOf("Our Kuwait store"), true);
});

Deno.test("both the type's guide and the user's instance survive", () => {
  // Replacing the user's description with a generic guide would be a
  // regression for every connector already configured.
  const composed = composeToolDescription("Our Kuwait store, prices in KWD.", guide);
  assertEquals(composed.includes("stock level for SKU ABC-12"), true);
  assertEquals(composed.includes("Cannot place, refund or modify an order"), true);
  assertEquals(composed.includes("Our Kuwait store, prices in KWD."), true);
});

Deno.test("a connector type with no guide is byte-identical to today", () => {
  // custom_rest has no vendor semantics to describe. Every connector in
  // production today takes this path, so it must not throw, must not prepend an
  // empty section, and must not add so much as a space.
  assertEquals(composeToolDescription("Posts to our n8n webhook.", undefined), "Posts to our n8n webhook.");
  assertEquals(composeToolDescription("Posts to our n8n webhook.", null), "Posts to our n8n webhook.");
});

Deno.test("an empty user description still yields the guide alone, untrimmed of meaning", () => {
  const composed = composeToolDescription("   ", guide);
  assertEquals(composed.includes(guide.whenToUse), true);
  assertEquals(composed.endsWith(" "), false);
});

Deno.test("the composed description respects the budget", () => {
  // Every tool description is resent on every turn of every conversation, and
  // this worker is killed at 60s -- a limit this repo has already hit once with
  // a 65KB document. An unbounded description is a slow, invisible tax.
  const composed = composeToolDescription("x".repeat(4000), guide);
  assertEquals(composed.length <= TOOL_DESCRIPTION_BUDGET, true);
});

Deno.test("truncation lands on a sentence boundary, not mid-word", () => {
  // A description cut mid-sentence reads to the model as a different claim
  // than the one written -- "Cannot place, refund or mod" is not a limit.
  const longUserText = "First sentence here. " + "Second sentence padding. ".repeat(60);
  const composed = composeToolDescription(longUserText, guide);
  assertEquals(composed.length <= TOOL_DESCRIPTION_BUDGET, true);
  assertEquals(/[.!?]$/.test(composed.trim()), true);
});

Deno.test("a guide alone can never blow the budget", () => {
  // The user's text is what gets cut, so a registry entry that is itself over
  // budget would silently truncate the guide instead. Registry entries are
  // authored, not user input, so this is a contract on the registry.
  const oversized = {
    whenToUse: "w".repeat(900),
    requestExamples: ["e".repeat(200)],
    limits: "l".repeat(200),
  };
  const composed = composeToolDescription("user text", oversized);
  assertEquals(composed.length <= TOOL_DESCRIPTION_BUDGET, true);
});
