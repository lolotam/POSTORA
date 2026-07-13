import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { executeTool, type ToolContext } from "./tools.ts";

Deno.test("search_knowledge uses the configured bge-m3 retrieval RPC", async () => {
  const rpcCalls: string[] = [];
  const context = {
    admin: {
      rpc: async (name: string) => {
        rpcCalls.push(name);
        return { data: [], error: null };
      },
    },
    userId: "00000000-0000-0000-0000-000000000001",
    platform: "whatsapp",
    conversationId: "test-conversation",
    customerName: "Test customer",
    adminPhoneNumbers: [],
    dryRun: true,
    embed: async () => [[0.1]],
    sendWhatsAppText: async () => {},
    retrievalRpcName: "match_ai_knowledge_chunks_bge_m3",
  } as ToolContext;

  await executeTool(context, "search_knowledge", { query: "Arabic and English pricing" });

  assertEquals(rpcCalls, ["match_ai_knowledge_chunks_bge_m3"]);
});
