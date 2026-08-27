// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseAgentReplyResult } from "./agentReplyResult.ts";

Deno.test("HTTP 200 carrying ok:false is a failure, not a send", () => {
  // jsonResponse defaults to 200 (_shared/cors.ts:45), so ai-agent-reply's error path
  // returns 200 {ok:false}. Classifying on HTTP status would mark every generation failure
  // as delivered.
  assertEquals(parseAgentReplyResult(200, { ok: false, error: "provider timeout" }).kind, "retryable");
});

Deno.test("a model outage that already apologised and escalated is terminal", () => {
  // The trap: this ALSO returns 200 {ok:false}. But deliverModelOutageFloor has already
  // escalated the conversation, notified a human and sent the customer an apology. Retrying
  // it sends a second apology to someone who has one, and escalates a conversation that is
  // already escalated.
  assertEquals(
    parseAgentReplyResult(200, { ok: false, error: "all models failed", escalated: true, apology_sent: true }).kind,
    "outage_handled",
  );
  // Escalated with no apology (a public comment gets none) is still handled: the human
  // assignment happened, and re-running would assign twice.
  assertEquals(
    parseAgentReplyResult(200, { ok: false, error: "all models failed", escalated: true }).kind,
    "outage_handled",
  );
});

Deno.test("a model outage that could NOT escalate is retryable", () => {
  // model_exhaustion_unhandled: every model failed AND the handoff failed, so nothing was
  // sent and nothing was assigned. There is no side effect to protect, and a retry after the
  // provider recovers is the right outcome.
  assertEquals(
    parseAgentReplyResult(200, { ok: false, error: "all models failed", escalated: false }).kind,
    "retryable",
  );
});

Deno.test("a skipped reply is not a sent reply", () => {
  // {ok:true, skipped:"no_reply_generated"} means the agent deliberately said nothing.
  // Recording that as 'sent' would claim a reply the customer never got.
  assertEquals(parseAgentReplyResult(200, { ok: true, skipped: "no_reply_generated" }).kind, "skipped");
  assertEquals(parseAgentReplyResult(200, { ok: true, skipped: "ai_disabled" }).kind, "skipped");
});

Deno.test("a genuine send, and a redelivery of stored text, are told apart", () => {
  assertEquals(parseAgentReplyResult(200, { ok: true, reply: "hi" }).kind, "sent");
  assertEquals(parseAgentReplyResult(200, { ok: true, redelivered: true }).kind, "redelivered");
});

Deno.test("a 4xx is permanent and a 5xx is retryable", () => {
  // A malformed row will be malformed on every attempt; retrying it buys nothing and delays
  // the rows queued behind it. A 5xx is the platform, not the row.
  assertEquals(parseAgentReplyResult(400, {}).kind, "permanent");
  assertEquals(parseAgentReplyResult(401, {}).kind, "permanent");
  assertEquals(parseAgentReplyResult(503, {}).kind, "retryable");
});

Deno.test("an unparseable body is retryable, never sent", () => {
  // Cloudflare can replace a body wholesale. Defaulting to 'sent' on something we cannot
  // read is the one classification that loses a customer's reply silently.
  assertEquals(parseAgentReplyResult(200, "<html>502</html>").kind, "retryable");
  assertEquals(parseAgentReplyResult(200, null).kind, "retryable");
  assertEquals(parseAgentReplyResult(200, { ok: "yes" }).kind, "retryable");
});
