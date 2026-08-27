// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { dispatchAgentReply, toAgentReplyBody } from "./agentReplyDispatch.ts";

Deno.test("the request body is the agent's contract, field for field", () => {
  // The names on the right are what ai-agent-reply's ReplyRequest reads. A rename on either
  // side fails here rather than as a 400 in production.
  assertEquals(
    toAgentReplyBody({
      userId: "u", platform: "whatsapp", socialAccountId: "a", conversationId: "c",
      recipientId: "+965", inboundText: "hi", phoneNumberId: "biz", languageHint: "ara",
      commentId: null, outboxId: "row-1",
    }),
    {
      user_id: "u", platform: "whatsapp", social_account_id: "a", conversation_id: "c",
      recipient_phone: "+965", inbound_text: "hi", phone_number_id: "biz", language_hint: "ara",
      outbox_id: "row-1",
    },
  );
});

Deno.test("optional fields are omitted, not sent as null", () => {
  // ai-agent-reply treats `comment_id` as "this is a public comment" by presence. A null
  // would be falsy today; omitting it is what the contract actually says.
  const body = toAgentReplyBody({
    userId: "u", platform: "facebook", socialAccountId: "a", conversationId: "c",
    recipientId: "psid", inboundText: "hi",
  });
  assertEquals(Object.keys(body).sort(), [
    "conversation_id", "inbound_text", "platform", "recipient_phone", "social_account_id", "user_id",
  ]);
});

Deno.test("the answer is read from the body, so a 200 {ok:false} is a failure", async () => {
  // Deno runs a file's tests in one process, so an env var set here is set for every other
  // suite too -- this exact leak broke whatsappMediaResolver.test.ts, which reads
  // SUPABASE_URL to build a storage URL. Restore whatever was there.
  const previous = {
    url: Deno.env.get("SUPABASE_URL"),
    key: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  };
  Deno.env.set("SUPABASE_URL", "http://edge");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk");
  try {
    const fetcher = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "provider timeout" }), { status: 200 }),
      )) as typeof fetch;
    const outcome = await dispatchAgentReply(
      { userId: "u", platform: "facebook", socialAccountId: "a", conversationId: "c", recipientId: "p", inboundText: "hi" },
      fetcher,
    );
    assertEquals(outcome, { kind: "retryable", detail: "provider timeout" });
  } finally {
    if (previous.url === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", previous.url);
    if (previous.key === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", previous.key);
  }
});
