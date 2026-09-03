// Tool definitions and executors for the AI agent chat loop.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pickEscalationAgent, SIMILARITY_FLOOR, waRecipient } from "./logic.ts";
import type { KnowledgeChunkMatch } from "../_shared/knowledgeEmbeddings.ts";
import { composeToolDescription } from "../_shared/composeToolDescription.ts";
import {
  composioBinding,
  connectorCapabilities,
  type ConnectorCapabilityDefinition,
  type ConnectorParameterSchema,
  connectorUsageGuide,
} from "../_shared/connectorRegistry.ts";
import { composioToolParameters, type ComposioReadyTool } from "./composioTools.ts";

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
  /**
   * The conversation's account, when it names one (the sandbox's sentinel
   * "test" is normalized to null). Connector telemetry resolves the ledger
   * row's workspace from it, and Composio tenancy was checked against it at
   * prompt assembly.
   */
  socialAccountId: string | null;
  /** Joins connector_call_logs rows to this reply invocation's logs. */
  requestId: string;
  /**
   * Whether the conversation's sender is a verified admin. Gates mutating
   * Composio slugs (connector_write_not_allowed) the same way the prompt's
   * admin_only filter does.
   */
  isAdmin: boolean;
  // Retrieve knowledge chunks for a query, using the primary embedding provider
  // and failing over to the configured fallback provider when it is down.
  retrieveKnowledge: (query: string, matchCount: number) => Promise<KnowledgeChunkMatch[]>;
  sendWhatsAppText: (recipientPhone: string, text: string) => Promise<void>;
}

export interface ToolResult {
  output: string;
  escalated?: boolean;
  retrievedChunkIds?: string[];
  humanNotified?: boolean;
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
  // retrieveKnowledge already fails over to the fallback embedding provider; if
  // every provider is down, degrade to a "no results" tool answer instead of
  // throwing and killing the whole reply.
  let chunks: KnowledgeChunkMatch[];
  try {
    const matches = await context.retrieveKnowledge(query, 6);
    chunks = matches.filter((chunk) => chunk.similarity > SIMILARITY_FLOOR);
  } catch (error) {
    console.error(
      "[ai-agent-reply] search_knowledge retrieval failed:",
      error instanceof Error ? error.message : String(error),
    );
    return { output: "Knowledge search is temporarily unavailable.", retrievedChunkIds: [] };
  }
  if (!chunks.length) return { output: "No matching business knowledge found.", retrievedChunkIds: [] };
  return {
    output: chunks
      .map((chunk, index) => `[${index + 1}] ${chunk.content}`)
      .join("\n\n"),
    retrievedChunkIds: chunks.map((chunk) => chunk.id),
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

/**
 * Everything an escalation needs, with no dependency on a model having run.
 * ToolContext satisfies this structurally, so escalateToHuman passes itself.
 */
export interface EscalationTarget {
  admin: any;
  userId: string;
  platform: string;
  conversationId: string;
  customerName: string;
  adminPhoneNumbers: string[];
  sendWhatsAppText: (recipientPhone: string, text: string) => Promise<void>;
}

export interface EscalationOutcome {
  assigned: boolean;
  assignmentNote: string;
  adminsNotified: number;
}

/**
 * Hands a conversation to a human. Callable from the escalate_to_human tool and
 * from index.ts's model-outage floor, which has no working model to call a tool
 * with.
 *
 * The mode upsert comes first deliberately: it is platform-agnostic and it is
 * what silences the AI for this conversation from the next inbound message on.
 * The assignment tables below it are WhatsApp-shaped, so on other platforms the
 * mode flip plus the admin notification is the whole of the handoff.
 */
export async function escalateConversation(
  target: EscalationTarget,
  reason: string,
  deadlineAt?: number,
): Promise<EscalationOutcome> {
  const outOfTime = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
  const msLeft = () => (deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now()));

  const { error: modeError } = await target.admin
    .from("ai_conversation_modes")
    .upsert(
      {
        user_id: target.userId,
        platform: target.platform,
        conversation_id: target.conversationId,
        mode: "human_first",
      },
      { onConflict: "user_id,platform,conversation_id" },
    );
  if (modeError) throw modeError;

  // Past this point the conversation is muted, which is the part of the escalation
  // the outage floor depends on. So nothing below may throw: a post-mute failure
  // that propagated would tell the caller the escalation failed, suppressing the
  // customer's apology and leaving a permanently silent conversation -- the worst
  // of both outcomes. Assignment and notification are best-effort, and they yield
  // to the deadline so a slow database cannot starve the customer's message.
  let assigned = false;
  let assignmentNote = "No human agent is online right now; the conversation is queued for the team.";

  try {
    if (!outOfTime()) {
      // Checking the clock before the query is not enough: a query that hangs runs
      // past the deadline anyway and eats the reserve the customer's message needs.
      // Bind the read itself to what is left. The writes below are deliberately NOT
      // aborted -- cancelling between the assignment insert and its history row
      // would leave the pair inconsistent, and both are already clock-gated.
      const remaining = msLeft();
      const agentQuery = target.admin
        .from("whatsapp_agents")
        .select("id, user_id, status, current_conversations");
      const { data: agents } = remaining === undefined
        ? await agentQuery
        : await agentQuery.abortSignal(AbortSignal.timeout(remaining));
      const agent = pickEscalationAgent(agents || [], target.userId);

      // Re-checked after the lookup: it may itself have spent the remaining budget.
      if (agent && !outOfTime()) {
        const { data: existing } = await target.admin
          .from("whatsapp_conversation_assignments")
          .select("id, agent_id")
          .eq("conversation_id", target.conversationId)
          .is("unassigned_at", null)
          .maybeSingle();

        if (existing) {
          await target.admin
            .from("whatsapp_conversation_assignments")
            .update({ unassigned_at: new Date().toISOString() })
            .eq("id", existing.id);
        }

        const { error: assignError } = await target.admin
          .from("whatsapp_conversation_assignments")
          .insert({
            conversation_id: target.conversationId,
            agent_id: agent.id,
            assigned_by: target.userId,
            notes: `AI escalation: ${reason}`.slice(0, 500),
          });
        if (assignError) throw assignError;

        await target.admin.from("whatsapp_assignment_history").insert({
          conversation_id: target.conversationId,
          action: existing ? "transferred" : "assigned",
          from_agent_id: existing?.agent_id || null,
          to_agent_id: agent.id,
          performed_by: target.userId,
          reason: `AI escalation: ${reason}`.slice(0, 500),
        });
        assigned = true;
        assignmentNote = "An online team member has been assigned to this conversation.";
      }
    }
  } catch (assignmentError) {
    console.error(
      "[ai-agent-reply] Escalation assignment failed after the conversation was muted:",
      assignmentError instanceof Error ? assignmentError.message : String(assignmentError),
    );
  }

  let adminsNotified = 0;
  for (const phone of target.adminPhoneNumbers) {
    // These sends are sequential and admin_phone_numbers has no cap, so an
    // unreachable Graph API here could otherwise run past the caller's budget.
    if (outOfTime()) {
      console.warn("[ai-agent-reply] Escalation deadline reached; admin notifications truncated");
      break;
    }
    try {
      await target.sendWhatsAppText(
        waRecipient(phone),
        `🤖 AI agent escalation\nCustomer: ${target.customerName}\nReason: ${reason}\n${assignmentNote}`,
      );
      adminsNotified++;
    } catch (error) {
      console.error(
        `[ai-agent-reply] Admin notification to ${phone} failed:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(
    `[ai-agent-reply] Escalated conversation (assigned: ${assigned}, admins notified: ${adminsNotified})`,
  );

  return { assigned, assignmentNote, adminsNotified };
}

async function escalateToHuman(context: ToolContext, reason: string): Promise<ToolResult> {
  if (context.dryRun) {
    return {
      output:
        "(test mode — no side effects) Escalation would be recorded, an online agent assigned, and admins notified. Tell the customer a team member will follow up.",
      escalated: true,
    };
  }

  const outcome = await escalateConversation(context, reason);

  return {
    output:
      `Escalation recorded. ${outcome.assignmentNote} Tell the customer briefly that a team member will follow up.`,
    escalated: true,
    // Carried so the outage floor can tell a real handoff from a bare mute. This
    // returns true whenever the mode write succeeded, even with no online agent and
    // no admin numbers -- without this the floor would promise a notification that
    // never happened.
    humanNotified: outcome.assigned || outcome.adminsNotified > 0,
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

// User-defined connector tools (rows in ai_agent_tools). Each one maps to an
// external webhook — typically an n8n workflow holding the real credentials
// (Gmail, Calendar, CRM, ...) so Postora never stores them.
export interface CustomTool {
  id: string;
  name: string;
  description: string;
  url: string;
  secret: string | null;
  admin_only: boolean;
  // Optional so a row written before the registry existed still type-checks.
  // Absent behaves exactly like custom_rest: no guide, description unchanged.
  connector_type?: string | null;
  /**
   * The connector's own configuration. Read only to tell the model what this
   * instance may reach: the registry describes a TYPE, and "Allowed PostgREST
   * table to query" left the model guessing a name it could not know.
   */
  settings?: Record<string, unknown> | null;
  /**
   * How this tool authenticates (20260903120000). A composio_oauth tool also
   * carries `connection` once attachComposioTools has enriched it — the
   * connection is deliberately NOT part of this interface because un-enriched
   * Composio tools are never offered or executed.
   */
  auth_strategy?: "manual_credentials" | "composio_oauth";
  /** Set iff auth_strategy is composio_oauth; the workspace-scoped connection. */
  connection_id?: string | null;
}

/**
 * The tables this connector instance may read, from its own settings. Stored as
 * a comma- or newline-separated string, exactly as the adapter's tableAllowList
 * parses it -- both sides must agree or the model is told one thing and refused
 * another.
 */
function allowedTables(settings: Record<string, unknown> | null | undefined): string[] {
  const raw = settings?.table_allow_list;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  return raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
}

/**
 * Replaces the registry's generic `table` wording with the names this connector
 * actually allows.
 *
 * A model that guesses a table name is refused by the adapter, and the refusal
 * used to name no alternative, so it could not recover inside its tool
 * iterations either -- the customer got "I can't reach the system"
 * (2026-09-01). Left untouched when the connector declares no allow-list.
 */
function nameAllowedTables(
  properties: Record<string, unknown>,
  settings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const tables = allowedTables(settings);
  const table = properties.table;
  if (!tables.length || typeof table !== "object" || table === null) return properties;
  return {
    ...properties,
    table: {
      ...table,
      description: `The table to query. Must be exactly one of: ${
        tables.join(", ")
      }. Omit it to use ${tables[0]}.`,
    },
  };
}

/** "query (required), sku" — what one capability accepts, for the flat schema. */
function describeParameterKeys(parameters: ConnectorParameterSchema): string {
  const required = new Set(parameters.required ?? []);
  const keys = Object.keys(parameters.properties);
  if (keys.length === 0) return "no arguments";
  return keys
    .map((key) => (required.has(key) ? `${key} (required)` : key))
    .join(", ");
}

/**
 * Every capability's argument in one object, for providers that read only
 * `properties`. A key shared by two capabilities (woocommerce's `query`) keeps
 * the first definition — the descriptions agree, and the per-capability
 * contract is enforced by the adapter, which validates the arguments it was
 * actually given.
 */
function mergeCapabilityParameters(
  capabilities: readonly ConnectorCapabilityDefinition[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const capability of capabilities) {
    for (const [key, schema] of Object.entries(capability.parameters.properties)) {
      if (!(key in merged)) merged[key] = schema;
    }
  }
  return merged;
}

export function customToolDefinitions(tools: CustomTool[]) {
  return tools.map((tool) => {
    const capabilities = connectorCapabilities(tool.connector_type);
    // Spec §7.1: ONE branch, not a second builder. A composio_oauth tool has
    // no native adapter and no legacy webhook — its schema comes from the
    // registry allow-list plus the connection's cached Composio schemas, in
    // the same flat shape the adapter branch emits.
    const binding = tool.auth_strategy === "composio_oauth"
      ? composioBinding(tool.connector_type)
      : undefined;
    const composioParameters = binding
      ? composioToolParameters(tool as ComposioReadyTool, binding)
      : null;
    const legacyParameters = {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The request to send to this connector, in plain language with all needed details",
        },
      },
      required: ["input"],
    };
    const typedParameters = capabilities?.length
      ? {
        // One flat object, deliberately: a `capability` enum plus the merged
        // arguments, and NO schema-level polymorphism at the root.
        //
        // Two providers, two hard constraints, and only this shape satisfies
        // both. Google's OpenAI-compatible endpoint drops `oneOf` and reads
        // only `properties`, so a oneOf-only schema reached the model with no
        // argument fields at all and a live WooCommerce store went unqueried.
        // OpenAI refuses such a schema outright:
        //
        //   Invalid schema for function '...': schema must have type 'object'
        //   and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the
        //   top level.
        //
        // OpenAI is the LAST model in the agent chain, so keeping `oneOf` for
        // "providers that honour it" cost a real customer their answer: a
        // Gemini blip fell through to it, the schema was refused, the chain was
        // exhausted, and the outage message went out instead (2026-08-31 20:57
        // UTC). Per-capability precision now lives in the enum description
        // below, and is enforced by the adapter, which validates the arguments
        // it is actually given.
        type: "object",
        properties: {
          capability: {
            type: "string",
            enum: capabilities.map((capability) => capability.name),
            // Which argument each capability takes is said here because the
            // schema no longer binds them: this description is the only place
            // the model can learn that check_stock wants a sku.
            description: capabilities
              .map((capability) =>
                `${capability.name}: ${capability.description} Takes ${
                  describeParameterKeys(capability.parameters)
                }.`
              )
              .join(" "),
          },
          parameters: {
            type: "object",
            description: "Arguments for the chosen capability.",
            properties: nameAllowedTables(mergeCapabilityParameters(capabilities), tool.settings),
          },
        },
        required: ["capability", "parameters"],
      }
      : legacyParameters;

    return {
      type: "function",
      function: {
        name: tool.name,
        // The registry guide describes the connector TYPE (when to reach for it,
        // what it cannot do); tool.description describes the user's own instance.
        // Both are sent, guide first, inside a hard character budget -- these are
        // resent on every turn of every conversation.
        description: composeToolDescription(
          tool.description,
          connectorUsageGuide(tool.connector_type),
        ),
        // custom_rest and unknown historical types take the exact legacy branch.
        // Typed connectors derive this schema from the same registry metadata
        // that opts them into adapter routing; Composio connectors from the
        // allow-list plus cached schemas. Both are flat object schemas.
        parameters: composioParameters ?? typedParameters,
      },
    };
  });
}

const CUSTOM_TOOL_TIMEOUT_MS = 10_000;
const CUSTOM_TOOL_OUTPUT_LIMIT = 2000;

// SSRF guard: connector URLs are user-supplied and this function runs with
// service-role credentials inside the stack's Docker network. Resolve the
// hostname and refuse loopback/private/link-local targets before fetching.
// Known limit (same as the n8n node's safeFetch): DNS rebinding between this
// check and the fetch is not fully preventable at this layer.
function isPrivateIp(address: string): boolean {
  if (address === "0.0.0.0" || address === "::" || address === "::1") return true;
  const v4 = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

export async function assertPublicHttpsUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Connector URL must use https");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    throw new Error("Connector URL host is not allowed");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    if (isPrivateIp(host.replace(/^\[|\]$/g, ""))) throw new Error("Connector URL resolves to a private address");
    return url;
  }
  const records = await Promise.allSettled([
    Deno.resolveDns(host, "A"),
    Deno.resolveDns(host, "AAAA"),
  ]);
  const addresses = records.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (!addresses.length) throw new Error("Connector URL host does not resolve");
  if (addresses.some(isPrivateIp)) throw new Error("Connector URL resolves to a private address");
  return url;
}

export async function executeCustomTool(
  context: ToolContext,
  tool: CustomTool,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const input = String(args.input || "");
  if (context.dryRun) {
    return {
      output: `(test mode — connector not called) Would call "${tool.name}" with: ${input.slice(0, 200)}`,
    };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tool.secret) headers["X-Webhook-Secret"] = tool.secret;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CUSTOM_TOOL_TIMEOUT_MS);
  try {
    const url = await assertPublicHttpsUrl(tool.url);
    // redirect: "manual" so a 3xx can't bounce the request to an unvalidated
    // (e.g. internal) host; connectors must respond directly.
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: tool.name,
        input,
        conversation_id: context.conversationId,
        platform: context.platform,
        customer_name: context.customerName,
      }),
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      return { output: `Connector "${tool.name}" responded with a redirect, which is not allowed.` };
    }
    const text = (await response.text()).slice(0, CUSTOM_TOOL_OUTPUT_LIMIT);
    if (!response.ok) {
      return { output: `Connector "${tool.name}" failed (${response.status}): ${text || "no details"}` };
    }
    return { output: text || `Connector "${tool.name}" completed with no output.` };
  } catch (error) {
    const reason = error instanceof DOMException && error.name === "AbortError"
      ? "timed out"
      : error instanceof Error
        ? error.message
        : String(error);
    return { output: `Connector "${tool.name}" failed: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }
}
