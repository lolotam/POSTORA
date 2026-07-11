// Tool definitions and executors for the AI agent chat loop.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ToolContext {
  admin: any;
  userId: string;
  platform: string;
  conversationId: string;
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface ToolResult {
  output: string;
  escalated?: boolean;
  retrievedChunkIds?: string[];
}

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Search the business knowledge base (products, prices, policies, FAQs) for details relevant to the customer's question. Use before claiming something is unknown or unavailable.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, in any language" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Hand this conversation to a human team member. Use when the customer asks for a person, or when the knowledge base cannot answer their question.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the conversation needs a human" },
        },
        required: ["reason"],
      },
    },
  },
];

async function searchKnowledge(context: ToolContext, query: string): Promise<ToolResult> {
  const [embedding] = await context.embed([query]);
  const { data, error } = await context.admin.rpc("match_ai_knowledge_chunks", {
    query_embedding: embedding,
    p_user_id: context.userId,
    match_count: 6,
  });
  if (error) throw error;
  const chunks = (data || []).filter((chunk: { similarity: number }) => chunk.similarity > 0.15);
  if (!chunks.length) return { output: "No matching business knowledge found.", retrievedChunkIds: [] };
  return {
    output: chunks
      .map((chunk: { content: string }, index: number) => `[${index + 1}] ${chunk.content}`)
      .join("\n\n"),
    retrievedChunkIds: chunks.map((chunk: { id: string }) => chunk.id),
  };
}

async function escalateToHuman(context: ToolContext, reason: string): Promise<ToolResult> {
  // TODO(Phase 4): auto-assign an online agent via whatsapp_conversation_assignments
  // and notify the admin. For now we flip the conversation to human_first so the
  // AI stays silent from the next message on.
  const { error } = await context.admin
    .from("ai_conversation_modes")
    .upsert(
      {
        user_id: context.userId,
        platform: context.platform,
        conversation_id: context.conversationId,
        mode: "human_first",
      },
      { onConflict: "user_id,platform,conversation_id" },
    );
  if (error) throw error;
  console.log(`[ai-agent-reply] Escalated conversation to human: ${reason}`);
  return {
    output:
      "Escalation recorded; a human team member will take over this conversation. Tell the customer briefly that someone from the team will follow up.",
    escalated: true,
  };
}

export async function executeTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === "search_knowledge") return searchKnowledge(context, String(args.query || ""));
  if (name === "escalate_to_human") return escalateToHuman(context, String(args.reason || ""));
  return { output: `Unknown tool: ${name}` };
}
