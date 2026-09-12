// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { deleteHumanAgent, HumanAgentOpError } from "./humanAgentOps.ts";
import { encodeId } from "../partner-api/v1/ids.ts";

const ID = "22222222-2222-4222-8222-222222222222";
function fixture(opts: { deleteCode?: string; ended?: boolean } = {}) {
  const calls: Array<{ url: URL; method: string }> = [];
  const admin = createClient("https://database.example", "test", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") {
        assertEquals(url.searchParams.get("workspace_id"), "eq.ws");
        assertEquals(url.searchParams.get("id"), `eq.${ID}`);
        return Promise.resolve(opts.deleteCode
          ? Response.json({ code: opts.deleteCode, message: "private database detail" }, { status: 409 })
          : Response.json([{ id: ID }]));
      }
      if (url.pathname.endsWith("/whatsapp_conversation_assignments")) {
        assertEquals(url.searchParams.get("agent_id"), `eq.${ID}`);
        return Promise.resolve(Response.json(opts.ended && !url.searchParams.has("unassigned_at") ? [{ id: "ended" }] : []));
      }
      assertEquals(url.searchParams.get("workspace_id"), "eq.ws");
      return Promise.resolve(Response.json([{ id: ID, display_name: "Support" }]));
    } },
  });
  return { ctx: { admin, workspaceId: "ws", requestId: "req" }, calls };
}

Deno.test("a delete rejected by the FK answers 409", async () => {
  const db = fixture({ deleteCode: "23503" });
  const error = await assertRejects(() => deleteHumanAgent(db.ctx, encodeId("agent", ID)), HumanAgentOpError);
  assertEquals(error.status, 409);
  assertEquals(error.code, "invalid_request");
  assertEquals(error.message, "Agent has retained conversation assignments and cannot be deleted");
});

Deno.test("an ended assignment still blocks deletion", async () => {
  const db = fixture({ ended: true });
  const error = await assertRejects(() => deleteHumanAgent(db.ctx, encodeId("agent", ID)), HumanAgentOpError);
  assertEquals(error.status, 409);
  assertEquals(db.calls.some((call) => call.method === "DELETE"), false);
});

Deno.test("other delete failures retain an unknown outcome", async () => {
  const db = fixture({ deleteCode: "08006" });
  await assertRejects(() => deleteHumanAgent(db.ctx, encodeId("agent", ID)), Error, "Agent deletion outcome unknown");
});
