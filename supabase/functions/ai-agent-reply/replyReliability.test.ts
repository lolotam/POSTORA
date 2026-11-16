import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { POST_TOOL_RESERVE_MS } from "../_shared/connectorBudgets.ts";
import {
  finalSynthesisInstruction,
  limitationText,
  modelCallBudget,
  replyRoundPolicy,
} from "./replyReliability.ts";

const policy = (overrides: Partial<Parameters<typeof replyRoundPolicy>[0]> = {}) => replyRoundPolicy({
  configuredLimit: 5,
  iteration: 0,
  procedureActive: false,
  procedureToolRanOnLastRound: false,
  remainingModelMs: 30_000,
  ...overrides,
});

Deno.test("ordinary five-round turns reserve the fifth for synthesis and never add a sixth", () => {
  for (let iteration = 0; iteration < 4; iteration++) {
    assertEquals(policy({ iteration }), { mode: "tools", synthesisReason: null });
  }
  assertEquals(policy({ iteration: 4 }), { mode: "text_only", synthesisReason: "round_reserved" });
  assertEquals(policy({ iteration: 5 }), { mode: "stop", synthesisReason: null });
});

Deno.test("a one-round turn is synthesis only", () => {
  assertEquals(policy({ configuredLimit: 1 }), { mode: "text_only", synthesisReason: "round_reserved" });
  assertEquals(policy({ configuredLimit: 1, iteration: 1 }), { mode: "stop", synthesisReason: null });
});

Deno.test("the existing time reserve triggers early synthesis and an exhausted deadline starts no call", () => {
  assertEquals(policy({ remainingModelMs: POST_TOOL_RESERVE_MS }), {
    mode: "text_only",
    synthesisReason: "time_reserve",
  });
  assertEquals(policy({ remainingModelMs: 0 }), { mode: "stop", synthesisReason: null });
  assertEquals(policy({ remainingModelMs: -1 }), { mode: "stop", synthesisReason: null });
});

Deno.test("procedure rounds retain their existing completion extension", () => {
  assertEquals(policy({ configuredLimit: 3, iteration: 2, procedureActive: true }).mode, "tools");
  assertEquals(policy({
    configuredLimit: 3,
    iteration: 3,
    procedureActive: true,
    procedureToolRanOnLastRound: true,
  }), { mode: "text_only", synthesisReason: "procedure_completion" });
  assertEquals(policy({
    configuredLimit: 3,
    iteration: 4,
    procedureActive: true,
    procedureToolRanOnLastRound: true,
  }).mode, "stop");
});

Deno.test("tool rounds reserve model time while synthesis uses only what remains", () => {
  assertEquals(POST_TOOL_RESERVE_MS, 8_000);
  assertEquals(modelCallBudget(20_000, "tools"), 12_000);
  assertEquals(modelCallBudget(POST_TOOL_RESERVE_MS, "tools"), 0);
  assertEquals(modelCallBudget(3_000, "text_only"), 3_000);
  assertEquals(modelCallBudget(3_000, "stop"), 0);
});

Deno.test("synthesis is evidence-bound and cannot request fresh verification", () => {
  const instruction = finalSynthesisInstruction();
  assertStringIncludes(instruction, "No tools are available");
  assertStringIncludes(instruction, "never infer current price, stock");
});

Deno.test("localized limitation text is exact, honest UTF-8 customer-facing copy", () => {
  assertEquals(limitationText("en"), "I couldn’t complete verification just now. Please try again shortly.");
  assertEquals(limitationText("ar"), "تعذّر إكمال التحقق الآن. يُرجى المحاولة مرة أخرى بعد قليل.");
  assertEquals(limitationText("ar").includes("تم"), false);
});
