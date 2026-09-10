// deno-lint-ignore-file no-import-prefix
// Regression cover for GET /v1/conversations/{id}/messages, which had none.
//
// `loadBoundConversation` selected CONVERSATION_COLUMNS, which does not include
// `conversation_id`, while this route filters on `loaded.row.conversation_id`.
// supabase-js serializes an undefined filter value literally, so the request
// went out as `conversation_id=eq.undefined` and the route answered an empty
// list for every conversation. Tenancy was never at risk -- the comment beside
// that filter is right that `social_account_id` is the predicate carrying it --
// but the route returned nothing it was asked for, and no test noticed.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { ACCOUNT_ID, agentFixture } from "../../_shared/agentConfigTestSupport.ts";

const CONV = "44444444-4444-4444-8444-444444444444";
const KEY = "wa_1555000_96512345678";

function fixture() {
  const f = agentFixture();
  // This route is outside the automation scopes the shared fixture grants.
  f.rows.partner_api_keys[0].scopes = ["messages:read"];
  f.rows.messaging_cache.push({
    id: CONV, user_id: "cache-owner", workspace_id: "ws", social_account_id: ACCOUNT_ID,
    platform: "whatsapp", conversation_id: KEY, last_message_at: "2026-09-10T00:00:00Z",
  });
  return f;
}

function request(path: string) {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/${path}`, {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
}

Deno.test("conversation messages read the real text key, never the string 'undefined'", async () => {
  const f = fixture();
  const response = await handleRequest(request(`conversations/conv_${CONV}/messages`), () => f.admin);
  assertEquals(response.status, 200);

  const read = f.reads.find((url) => url.pathname.endsWith("/whatsapp_messages"));
  assert(read, "the messages table was never read");
  assertEquals(read.searchParams.get("conversation_id"), `eq.${KEY}`);
  // Both predicates, per the comment at the call site: the text key is not
  // unique across owners, so the bound account id is what carries tenancy.
  assertEquals(read.searchParams.get("social_account_id"), `eq.${ACCOUNT_ID}`);
});

Deno.test("conversation messages never publish the text key or its owner", async () => {
  const f = fixture();
  const response = await handleRequest(request(`conversations/conv_${CONV}/messages`), () => f.admin);
  const text = await response.text();
  assert(!/wa_|"conversation_id"|"user_id"/.test(text), text);
});
