// Tool definitions and executors for the AI agent chat loop.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pickEscalationAgent, waRecipient } from "./logic.ts";

export interface ToolContext {
  admin: any;
  userId: string;
  platform: string;
  conversationId: string;
  customerName: string;
  adminPhoneNumbers: string[];
  // Test-sandbox runs: read-only tools work normally, but nothing is sent,
  // assigned, or written outside the test conversation.
  dryRun: boolean;
  embed: (texts: string[]) => Promise<number[][]>;
  sendWhatsAppText: (recipientPhone: string, text: string) => Promise<void>;
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
  {
    type: "function",
    function: {
      name: "notify_admin",
      description:
        "Send a short WhatsApp notification to the business admin. Use for urgent matters the admin should see immediately (complaints, large orders, repeated failures). Do not use for routine questions.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Short notification text for the admin" },
        },
        required: ["message"],
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

async function notifyAdmins(context: ToolContext, text: string): Promise<number> {
  let delivered = 0;
  for (const phone of context.adminPhoneNumbers) {
    try {
      await context.sendWhatsAppText(waRecipient(phone), text);
      delivered++;
    } catch (error) {
      console.error(
        `[ai-agent-reply] Admin notification to ${phone} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return delivered;
}

async function escalateToHuman(context: ToolContext, reason: string): Promise<ToolResult> {
  if (context.dryRun) {
    return {
      output:
        "(test mode — no side effects) Escalation would be recorded, an online agent assigned, and admins notified. Tell the customer a team member will follow up.",
      escalated: true,
    };
  }

  // The AI goes silent for this conversation from the next message on.
  const { error: modeError } = await context.admin
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
  if (modeError) throw modeError;

  // Auto-assign an online human agent, mirroring the manual flow in
  // src/hooks/useWhatsAppAgents.ts (close active assignment, log history,
  // insert the new one).
  const { data: agents } = await context.admin
    .from("whatsapp_agents")
    .select("id, user_id, status, current_conversations");
  const agent = pickEscalationAgent(agents || [], context.userId);
  let assignmentNote = "No human agent is online right now; the conversation is queued for the team.";

  if (agent) {
    const { data: existing } = await context.admin
      .from("whatsapp_conversation_assignments")
      .select("id, agent_id")
      .eq("conversation_id", context.conversationId)
      .is("unassigned_at", null)
      .maybeSingle();

    if (existing) {
      await context.admin
        .from("whatsapp_conversation_assignments")
        .update({ unassigned_at: new Date().toISOString() })
        .eq("id", existing.id);
    }

    const { error: assignError } = await context.admin
      .from("whatsapp_conversation_assignments")
      .insert({
        conversation_id: context.conversationId,
        agent_id: agent.id,
        assigned_by: context.userId,
        notes: `AI escalation: ${reason}`.slice(0, 500),
      });
    if (assignError) throw assignError;

    await context.admin.from("whatsapp_assignment_history").insert({
      conversation_id: context.conversationId,
      action: existing ? "transferred" : "assigned",
      from_agent_id: existing?.agent_id || null,
      to_agent_id: agent.id,
      performed_by: context.userId,
      reason: `AI escalation: ${reason}`.slice(0, 500),
    });
    assignmentNote = "An online team member has been assigned to this conversation.";
  }

  const delivered = await notifyAdmins(
    context,
    `🤖 AI agent escalation\nCustomer: ${context.customerName}\nReason: ${reason}\n${assignmentNote}`,
  );
  console.log(
    `[ai-agent-reply] Escalated conversation (agent: ${agent?.id || "none"}, admins notified: ${delivered})`,
  );

  return {
    output:
      `Escalation recorded. ${assignmentNote} Tell the customer briefly that a team member will follow up.`,
    escalated: true,
  };
}

async function notifyAdmin(context: ToolContext, messageText: string): Promise<ToolResult> {
  if (!context.adminPhoneNumbers.length) {
    return { output: "No admin phone numbers are configured; the admin could not be notified." };
  }
  if (context.dryRun) {
    return { output: `(test mode — nothing sent) Admin would be notified: ${messageText.slice(0, 200)}` };
  }
  const delivered = await notifyAdmins(
    context,
    `🤖 AI agent notification\nCustomer: ${context.customerName}\n${messageText}`,
  );
  return {
    output: delivered > 0
      ? `Admin notified (${delivered} recipient${delivered === 1 ? "" : "s"}).`
      : "Admin notification failed to send.",
  };
}

export async function executeTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === "search_knowledge") return searchKnowledge(context, String(args.query || ""));
  if (name === "escalate_to_human") return escalateToHuman(context, String(args.reason || ""));
  if (name === "notify_admin") return notifyAdmin(context, String(args.message || ""));
  return { output: `Unknown tool: ${name}` };
}
