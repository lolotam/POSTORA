import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AgentBehaviorError, parseAgentBehavior } from "./agentBehavior.ts";

Deno.test("null, undefined and an empty object all parse to an empty behavior", () => {
  assertEquals(parseAgentBehavior(null), {});
  assertEquals(parseAgentBehavior(undefined), {});
  assertEquals(parseAgentBehavior({}), {});
});

Deno.test("a full behavior round-trips unchanged", () => {
  const input = {
    tone: "formal",
    response_length: "short",
    goals: ["capture_leads", "answer_pricing"],
    greeting: "Welcome to Xsellpoint.",
    instruction_blocks: [{ title: "Pricing", body: "Never quote without the connector." }],
  };
  assertEquals(parseAgentBehavior(input), input);
});

Deno.test("an unknown key is named in the error", () => {
  const error = assertThrows(() => parseAgentBehavior({ vibe: "cool" }), AgentBehaviorError);
  assertEquals(error.message, "Unknown agent_behavior key: vibe");
});

Deno.test("an unknown tone is rejected", () => {
  assertThrows(() => parseAgentBehavior({ tone: "sarcastic" }), AgentBehaviorError);
});

Deno.test("an unknown response length is rejected", () => {
  assertThrows(() => parseAgentBehavior({ response_length: "epic" }), AgentBehaviorError);
});

Deno.test("an unknown goal is rejected", () => {
  assertThrows(() => parseAgentBehavior({ goals: ["sell_kidneys"] }), AgentBehaviorError);
});

Deno.test("duplicate goals collapse, keeping first-seen order", () => {
  assertEquals(
    parseAgentBehavior({ goals: ["capture_leads", "answer_pricing", "capture_leads"] }),
    { goals: ["capture_leads", "answer_pricing"] },
  );
});

Deno.test("a greeting over 500 characters is rejected", () => {
  assertThrows(() => parseAgentBehavior({ greeting: "x".repeat(501) }), AgentBehaviorError);
});

Deno.test("more than ten instruction blocks is rejected", () => {
  const blocks = Array.from({ length: 11 }, (_, index) => ({ title: `t${index}`, body: "b" }));
  assertThrows(() => parseAgentBehavior({ instruction_blocks: blocks }), AgentBehaviorError);
});

Deno.test("an instruction block body over 2000 characters is rejected", () => {
  assertThrows(
    () => parseAgentBehavior({ instruction_blocks: [{ title: "t", body: "x".repeat(2001) }] }),
    AgentBehaviorError,
  );
});

Deno.test("an instruction block title over 120 characters is rejected", () => {
  assertThrows(
    () => parseAgentBehavior({ instruction_blocks: [{ title: "t".repeat(121), body: "b" }] }),
    AgentBehaviorError,
  );
});

Deno.test("an instruction block missing its body is rejected", () => {
  assertThrows(
    () => parseAgentBehavior({ instruction_blocks: [{ title: "t" }] }),
    AgentBehaviorError,
  );
});

Deno.test("a non-object is rejected", () => {
  assertThrows(() => parseAgentBehavior("formal"), AgentBehaviorError);
  assertThrows(() => parseAgentBehavior([{ tone: "formal" }]), AgentBehaviorError);
});

const validProcedures = {
  order_status: { enabled: true, prompts: { order_number: "Ask for the order number" }, closing: "" },
  product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "For whom?"] },
};

Deno.test("a valid procedures config is kept", () => {
  assertEquals(parseAgentBehavior({ procedures: validProcedures }).procedures, validProcedures);
});

Deno.test("an unknown procedure is rejected", () => {
  assertThrows(() => parseAgentBehavior({ procedures: { weather: {} } }), AgentBehaviorError);
});
