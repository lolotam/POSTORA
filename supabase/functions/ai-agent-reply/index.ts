// Internal AI agent reply engine. Called service-to-service by platform
// webhooks (whatsapp-webhook) after auto-reply rules found no match.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse, badRequestResponse } from "../_shared/cors.ts";
import {
  buildSystemPrompt,
  detectReplyLanguage,
  resolveEngagementMode,
  shouldAiReply,
  waRecipient,
} from "./logic.ts";
import { executeTool, toolDefinitions, type ToolContext, type ToolResult } from "./tools.ts";
import { adminToolDefinitions, executeAdminTool } from "./admin-tools.ts";
import { getSendCredentials } from "../_shared/messengerCredentials.ts";

const GRAPH_API = "https://graph.facebook.com/v21.0";
const OPENAI_API = "https://api.openai.com/v1";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;
const SIMILARITY_FLOOR = 0.15;

// For WhatsApp, recipient_phone is the customer's phone and phone_number_id
// the business number. For Facebook/Instagram, recipient_phone carries the
// sender PSID and phone_number_id is unused.
interface ReplyRequest {
  user_id: string;
  platform: string;
  social_account_id: string;
  conversation_id: string;
  phone_number_id?: string;
  recipient_phone: string;
  inbound_text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function embed(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`${OPENAI_API}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Embedding request failed");
  return data.data.map((item: { embedding: number[] }) => item.embedding);
}

async function chatCompletion(payload: Record<string, unknown>): Promise<any> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  const response = await fetch(`${OPENAI_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Chat completion failed");
  return data;
}

async function isHumanAssignedAndOnline(admin: any, conversationId: string): Promise<boolean> {
  // Only the active assignment counts — historical rows keep unassigned_at set
  // (see the partial unique index idx_active_assignment).
  const { data: assignment } = await admin
    .from("whatsapp_conversation_assignments")
    .select("agent_id")
    .eq("conversation_id", conversationId)
    .is("unassigned_at", null)
    .maybeSingle();
  if (!assignment?.agent_id) return false;
  const { data: agent } = await admin
    .from("whatsapp_agents")
    .select("status")
    .eq("id", assignment.agent_id)
    .maybeSingle();
  return agent?.status === "online";
}

async function isWithinServiceWindow(admin: any, userId: string, conversationId: string): Promise<boolean> {
  const { data: lastInbound } = await admin
    .from("whatsapp_messages")
    .select("timestamp")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lastInbound?.timestamp) return false;
  return Date.now() - new Date(lastInbound.timestamp).getTime() < SERVICE_WINDOW_MS;
}

async function isCooldownActive(admin: any, threadId: string, cooldownSeconds: number): Promise<boolean> {
  if (cooldownSeconds <= 0) return false;
  const { data: lastAssistant } = await admin
    .from("ai_thread_messages")
    .select("created_at")
    .eq("thread_id", threadId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!lastAssistant?.created_at) return false;
  return Date.now() - new Date(lastAssistant.created_at).getTime() < cooldownSeconds * 1000;
}

async function isDailyCapReached(admin: any, userId: string, conversationId: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("ai_agent_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .eq("status", "sent")
    .gte("created_at", midnightUtc.toISOString());
  return (count || 0) >= cap;
}

async function logOutcome(admin: any, entry: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from("ai_agent_logs").insert(entry);
  if (error) console.error("[ai-agent-reply] Failed to write log:", error.message);
}

async function resolveWhatsAppToken(admin: any, request: ReplyRequest): Promise<string> {
  const { data: account } = await admin
    .from("social_accounts")
    .select("access_token")
    .eq("id", request.social_account_id)
    .eq("user_id", request.user_id)
    .maybeSingle();
  const accessToken = account?.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!accessToken) throw new Error("No WhatsApp access token available for this account");
  return accessToken;
}

async function sendWhatsAppText(
  accessToken: string,
  phoneNumberId: string,
  recipientPhone: string,
  text: string,
): Promise<string> {
  const response = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipientPhone,
      type: "text",
      text: { body: text },
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "WhatsApp send failed");
  return data?.messages?.[0]?.id || `ai_${Date.now()}`;
}

type TextSender = (recipientId: string, text: string) => Promise<string>;

// Resolves how to deliver the reply for the request's platform. WhatsApp uses
// the Cloud API messages endpoint; Facebook/Instagram use the page Send API
// (shared credential resolution with the fb-ig webhook).
async function buildReplySender(admin: any, request: ReplyRequest): Promise<TextSender> {
  if (request.platform === "whatsapp") {
    const accessToken = await resolveWhatsAppToken(admin, request);
    return (recipientId, text) =>
      sendWhatsAppText(accessToken, request.phone_number_id!, recipientId, text);
  }

  const { data: account, error } = await admin
    .from("social_accounts")
    .select("*")
    .eq("id", request.social_account_id)
    .eq("user_id", request.user_id)
    .maybeSingle();
  if (error || !account) throw new Error("Messaging account not found for AI reply");
  const { graphBase, pageId, pageToken } = await getSendCredentials(admin, account);
  return async (recipientId, text) => {
    const response = await fetch(
      `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      },
    );
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data?.error?.message || "Messenger send failed");
    }
    return data.message_id || `ai_${Date.now()}`;
  };
}

// Admin notifications always go out over WhatsApp, regardless of which
// platform the customer wrote on. On FB/IG we look up the user's connected
// WhatsApp account; without one, each notify attempt fails per-recipient
// (logged by the tool layer) instead of failing the whole reply.
async function buildAdminNotifier(admin: any, request: ReplyRequest): Promise<TextSender> {
  if (request.platform === "whatsapp") {
    const accessToken = await resolveWhatsAppToken(admin, request);
    return (recipientId, text) =>
      sendWhatsAppText(accessToken, request.phone_number_id!, recipientId, text);
  }

  const { data: waAccount } = await admin
    .from("social_accounts")
    .select("access_token, account_metadata")
    .eq("user_id", request.user_id)
    .eq("platform", "whatsapp")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const accessToken = waAccount?.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = waAccount?.account_metadata?.phone_number_id ||
    Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  return (recipientId, text) => {
    if (!accessToken || !phoneNumberId) {
      throw new Error("No WhatsApp account available for admin notifications");
    }
    return sendWhatsAppText(accessToken, phoneNumberId, recipientId, text);
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsOptions();

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!bearer) return unauthorizedResponse();

  const admin = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("Invalid JSON body");
  }

  // Two callers: platform webhooks (service-role bearer, full request body)
  // and the in-app Test sandbox (user JWT, dry run against a test thread).
  let request: ReplyRequest;
  let dryRun = false;
  let actAsAdmin = false;
  if (bearer === serviceKey) {
    request = body as unknown as ReplyRequest;
    const requiredFields: Array<keyof ReplyRequest> = [
      "user_id", "platform", "social_account_id", "conversation_id",
      "recipient_phone", "inbound_text",
    ];
    for (const field of requiredFields) {
      if (!request[field]) return badRequestResponse(`Missing field: ${field}`);
    }
    if (request.platform === "whatsapp" && !request.phone_number_id) {
      return badRequestResponse("Missing field: phone_number_id");
    }
  } else {
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
    const anon = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: { user } } = await anon.auth.getUser(bearer);
    if (!user) return unauthorizedResponse();
    if (!body.inbound_text || typeof body.inbound_text !== "string") {
      return badRequestResponse("Missing field: inbound_text");
    }
    const platform = typeof body.platform === "string" ? body.platform : "whatsapp";
    dryRun = true;
    actAsAdmin = body.act_as_admin === true;
    request = {
      user_id: user.id,
      platform,
      social_account_id: "test",
      conversation_id: `test_${platform}_${user.id}`,
      phone_number_id: "test",
      recipient_phone: "test",
      inbound_text: body.inbound_text,
    };
  }

  const baseLog = {
    user_id: request.user_id,
    platform: request.platform,
    conversation_id: request.conversation_id,
    inbound_text: request.inbound_text.slice(0, 2000),
  };

  try {
    const { data: config } = await admin
      .from("ai_agent_configs")
      .select("*")
      .eq("user_id", request.user_id)
      .eq("platform", request.platform)
      .maybeSingle();
    if (!config) return jsonResponse({ ok: true, skipped: "agent_not_configured" });
    // The Test sandbox works while the agent is still disabled, so users can
    // tune it before switching it on for real customers.
    if (!config.is_enabled && !dryRun) return jsonResponse({ ok: true, skipped: "agent_disabled" });

    const { data: modeOverride } = await admin
      .from("ai_conversation_modes")
      .select("mode")
      .eq("user_id", request.user_id)
      .eq("platform", request.platform)
      .eq("conversation_id", request.conversation_id)
      .maybeSingle();
    const mode = resolveEngagementMode(modeOverride?.mode, config.default_mode);

    const { data: thread, error: threadError } = await admin
      .from("ai_threads")
      .upsert(
        {
          user_id: request.user_id,
          platform: request.platform,
          conversation_id: request.conversation_id,
        },
        { onConflict: "user_id,platform,conversation_id" },
      )
      .select()
      .single();
    if (threadError) throw threadError;

    // Sandbox runs bypass the delivery gates — they test the agent's brain,
    // not the conversation's delivery state.
    if (!dryRun) {
      // FB/IG replies happen inside the live webhook turnaround, so the
      // messaging window is open by definition; only WhatsApp needs the
      // stored-history check.
      const withinServiceWindow = request.platform === "whatsapp"
        ? await isWithinServiceWindow(admin, request.user_id, request.conversation_id)
        : true;
      const gate = shouldAiReply({
        mode,
        humanAssignedAndOnline: await isHumanAssignedAndOnline(admin, request.conversation_id),
        withinServiceWindow,
        cooldownActive: await isCooldownActive(admin, thread.id, config.reply_cooldown_seconds),
        dailyCapReached: await isDailyCapReached(
          admin,
          request.user_id,
          request.conversation_id,
          config.daily_message_cap,
        ),
      });
      if (!gate.reply) {
        await logOutcome(admin, { ...baseLog, status: "skipped", error: gate.reason });
        return jsonResponse({ ok: true, skipped: gate.reason });
      }
    }

    const { data: historyRows } = await admin
      .from("ai_thread_messages")
      .select("role, content")
      .eq("thread_id", thread.id)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    const history = (historyRows || []).reverse().map((row: { role: string; content: string | null }) => ({
      role: row.role,
      content: row.content || "",
    }));

    const [inboundEmbedding] = await embed([request.inbound_text]);
    const { data: matchedChunks, error: matchError } = await admin.rpc("match_ai_knowledge_chunks", {
      query_embedding: inboundEmbedding,
      p_user_id: request.user_id,
      match_count: 6,
    });
    if (matchError) throw matchError;
    const relevantChunks = (matchedChunks || []).filter(
      (chunk: { similarity: number }) => chunk.similarity > SIMILARITY_FLOOR,
    );
    const retrievedChunkIds: string[] = relevantChunks.map((chunk: { id: string }) => chunk.id);

    // Operational tools unlock only for verified admin senders (or the
    // sandbox's explicit act-as-admin switch). Numbers are compared as bare
    // digits because webhook senders arrive without the leading plus. FB/IG
    // senders are PSIDs, not phone numbers, so they can never match.
    const adminNumbers: string[] = (config.admin_phone_numbers || []).map(waRecipient);
    const isAdmin = dryRun
      ? actAsAdmin
      : request.platform === "whatsapp" && adminNumbers.includes(waRecipient(request.recipient_phone));

    const language = detectReplyLanguage(request.inbound_text, config.language_mode);
    const systemPrompt = buildSystemPrompt({
      persona: config.persona_instructions,
      language,
      knowledgeBlocks: relevantChunks.map((chunk: { content: string }) => chunk.content),
      nowIso: new Date().toISOString(),
      isAdmin,
    });

    const replySender = dryRun ? null : await buildReplySender(admin, request);
    const adminNotifier = dryRun ? null : await buildAdminNotifier(admin, request);
    const { data: cachedConversation } = await admin
      .from("messaging_cache")
      .select("participant_name")
      .eq("user_id", request.user_id)
      .eq("conversation_id", request.conversation_id)
      .maybeSingle();

    const toolContext: ToolContext = {
      admin,
      userId: request.user_id,
      platform: request.platform,
      conversationId: request.conversation_id,
      customerName: cachedConversation?.participant_name || request.recipient_phone,
      adminPhoneNumbers: config.admin_phone_numbers || [],
      dryRun,
      embed,
      sendWhatsAppText: async (recipientPhone: string, text: string) => {
        if (!adminNotifier) return;
        await adminNotifier(recipientPhone, text);
      },
    };

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: request.inbound_text },
    ];
    const executedToolCalls: Array<{ name: string; arguments: unknown }> = [];
    let escalated = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let replyText = "";

    const maxIterations = Math.max(1, config.max_tool_iterations || 5);
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const completion = await chatCompletion({
        model: config.model || "gpt-4o-mini",
        temperature: config.temperature ?? 0.4,
        messages,
        tools: isAdmin ? [...toolDefinitions, ...adminToolDefinitions] : toolDefinitions,
        tool_choice: "auto",
      });
      promptTokens += completion.usage?.prompt_tokens || 0;
      completionTokens += completion.usage?.completion_tokens || 0;
      const choice = completion.choices?.[0]?.message;
      if (!choice) throw new Error("Chat completion returned no choices");

      if (!choice.tool_calls?.length) {
        replyText = (choice.content || "").trim();
        break;
      }

      messages.push(choice);
      for (const toolCall of choice.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // leave args empty; the executor handles missing fields
        }
        executedToolCalls.push({ name: toolCall.function.name, arguments: args });
        // Admin tools are only dispatched for verified admin senders; for
        // everyone else unknown names fall through to executeTool's rejection.
        const result: ToolResult =
          (isAdmin ? await executeAdminTool(toolContext, toolCall.function.name, args) : null) ??
          (await executeTool(toolContext, toolCall.function.name, args));
        if (result.escalated) escalated = true;
        if (result.retrievedChunkIds) retrievedChunkIds.push(...result.retrievedChunkIds);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.output,
        });
      }
    }

    if (!replyText) {
      await logOutcome(admin, {
        ...baseLog,
        status: "skipped",
        error: "no_reply_generated",
        tool_calls: executedToolCalls.length ? executedToolCalls : null,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        latency_ms: Date.now() - startedAt,
      });
      return jsonResponse({ ok: true, skipped: "no_reply_generated" });
    }

    if (!dryRun && replySender) {
      const outboundMessageId = await replySender(request.recipient_phone, replyText);

      // Local message storage exists only for WhatsApp; FB/IG conversations
      // are read live from the Graph API.
      if (request.platform === "whatsapp") {
        await admin.from("whatsapp_messages").insert({
          user_id: request.user_id,
          social_account_id: request.social_account_id,
          conversation_id: request.conversation_id,
          message_id: outboundMessageId,
          from_phone: request.phone_number_id,
          from_name: "AI Agent",
          to_phone: request.recipient_phone,
          message_text: replyText,
          message_type: "text",
          direction: "outbound",
          status: "sent",
          timestamp: new Date().toISOString(),
        });
      }
    }

    const { error: threadWriteError } = await admin.from("ai_thread_messages").insert([
      { thread_id: thread.id, user_id: request.user_id, role: "user", content: request.inbound_text },
      {
        thread_id: thread.id,
        user_id: request.user_id,
        role: "assistant",
        content: replyText,
        tool_calls: executedToolCalls.length ? executedToolCalls : null,
      },
    ]);
    if (threadWriteError) console.error("[ai-agent-reply] Thread write failed:", threadWriteError.message);

    await logOutcome(admin, {
      ...baseLog,
      reply_text: replyText.slice(0, 4000),
      retrieved_chunk_ids: retrievedChunkIds.length ? [...new Set(retrievedChunkIds)] : null,
      tool_calls: executedToolCalls.length ? executedToolCalls : null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: Date.now() - startedAt,
      status: dryRun ? "test" : "sent",
    });

    return jsonResponse({ ok: true, reply: replyText, escalated, tool_calls: executedToolCalls, is_admin: isAdmin });
  } catch (error) {
    console.error("[ai-agent-reply] Failed:", errorMessage(error));
    await logOutcome(admin, {
      ...baseLog,
      status: "error",
      error: errorMessage(error).slice(0, 500),
      latency_ms: Date.now() - startedAt,
    });
    return jsonResponse({ ok: false, error: errorMessage(error) });
  }
});
