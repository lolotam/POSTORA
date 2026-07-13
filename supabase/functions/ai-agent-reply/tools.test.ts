import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { KnowledgeChunkMatch } from "../_shared/knowledgeEmbeddings.ts";
import { executeTool, type ToolContext } from "./tools.ts";

function context(overrides: Partial<ToolContext>): ToolContext {
  return {
    admin: {},
    userId: "00000000-0000-0000-0000-000000000001",
    platform: "whatsapp",
    conversationId: "test-conversation",
    customerName: "Test customer",
    adminPhoneNumbers: [],
    dryRun: true,
    retrieveKnowledge: () => Promise.resolve([]),
    sendWhatsAppText: () => Promise.resolve(),
    ...overrides,
  } as ToolContext;
}

Deno.test("search_knowledge returns only chunks above the similarity floor", async () => {
  const matches: KnowledgeChunkMatch[] = [
    { id: "relevant", content: "prices are listed here", similarity: 0.9 },
    { id: "noise", content: "unrelated chatter", similarity: 0.05 },
  ];
  const result = await executeTool(
    context({ retrieveKnowledge: () => Promise.resolve(matches) }),
    "search_knowledge",
    { query: "pricing" },
  );

  assertEquals(result.retrievedChunkIds, ["relevant"]);
  assertEquals(result.output.includes("prices are listed here"), true);
  assertEquals(result.output.includes("unrelated chatter"), false);
});

Deno.test("search_knowledge degrades to a safe message when every provider fails", async () => {
  const result = await executeTool(
    context({
      retrieveKnowledge: () => Promise.reject(new Error("all embedding providers down")),
    }),
    "search_knowledge",
    { query: "pricing" },
  );

  assertEquals(result.retrievedChunkIds, []);
  assertEquals(result.output, "Knowledge search is temporarily unavailable.");
});
