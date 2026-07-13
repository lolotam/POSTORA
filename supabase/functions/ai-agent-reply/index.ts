// Internal AI agent reply engine. Called service-to-service by platform
// webhooks (whatsapp-webhook) after auto-reply rules found no match.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse, badRequestResponse } from "../_shared/cors.ts";
import {
  buildSystemPrompt,
  detectReplyLanguage,
  formatRelatedFacts,
  formatModelRef,
  type GraphRelationFact,
  parseModelRef,
  resolveEngagementMode,
  SIMILARITY_FLOOR,
  shouldAiReply,
  waRecipient,
} from "./logic.ts";
import {
  customToolDefinitions,
  executeCustomTool,
  executeTool,
  toolDefinitions,
  type CustomTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";
import { adminToolDefinitions, executeAdminTool } from "./admin-tools.ts";
import { getSendCredentials } from "../_shared/messengerCredentials.ts";
import {
  embedKnowledge,
  resolveEmbeddingConfig,
  retrievalRpcName,
} from "../_shared/knowledgeEmbeddings.ts";

const GRAPH_API = "https://graph.facebook.com/v21.0";
const OPENAI_API = "https://api.openai.com/v1";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Only the last 4 stored turns are replayed to the model on each reply, to keep
// the prompt (and token cost) small; older context lives in ai_thread_messages.
const HISTORY_LIMIT = 4;

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

// Per-call ceilings keep one slow provider from burning the isolate's wall
// clock (which kills the request with an opaque 500 and no log row) and let
// the fallback chain actually get its turn.
const CHAT_TIMEOUT_MS = 25_000;

// OpenAI-compatible chat-completion endpoints per provider. Providers here
// must stay in sync with the choices offered in AdminAiAgentSection.tsx.
const GOOGLE_ENDPOINT = { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GOOGLE_AI_STUDIO_KEY" };
const PROVIDER_ENDPOINTS: Record<string, { url: string; keyEnv: string }> = {
  openai: { url: `${OPENAI_API}/chat/completions`, keyEnv: "OPENAI_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY" },
  // The admin model catalog (ai_providers) codes Google as "gemini"; accept both.
  google: GOOGLE_ENDPOINT,
  gemini: GOOGLE_ENDPOINT,
};

async function chatCompletion(provider: string, payload: Record<string, unknown>): Promise<any> {
  const endpoint = PROVIDER_ENDPOINTS[provider] ?? PROVIDER_ENDPOINTS.openai;
  const key = Deno.env.get(endpoint.keyEnv);
  if (!key) throw new Error(`${endpoint.keyEnv} is not configured`);
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${provider}/${payload.model} timed out after ${CHAT_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }
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

// Every outcome is written twice: to ai_agent_logs (user-facing Logs tab,
// RLS-scoped) and mirrored into system_logs so the /admin/logs page can
// track all AI agent chats and calls under the "ai" category.
async function logOutcome(
  admin: any,
  entry: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.from("ai_agent_logs").insert(entry);
  if (error) console.error("[ai-agent-reply] Failed to write log:", error.message);

  const status = String(entry.status || "unknown");
  const { error: systemLogError } = await admin.from("system_logs").insert({
    source: "ai-agent-reply",
    category: "ai",
    level: status === "error" ? "error" : "info",
    message: `AI agent reply ${status} (${entry.platform})${entry.error ? `: ${entry.error}` : ""}`,
    user_id: entry.user_id,
    metadata: {
      platform: entry.platform,
      conversation_id: entry.conversation_id,
      status,
      error: entry.error || null,
      prompt_tokens: entry.prompt_tokens ?? null,
      completion_tokens: entry.completion_tokens ?? null,
      latency_ms: entry.latency_ms ?? null,
      ...meta,
    },
  });
  if (systemLogError) console.error("[ai-agent-reply] Failed to write system log:", systemLogError.message);
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

  // Hoisted so the catch block can report which models were attempted.
  let usedModel: string | null = null;
  let usedFallbackLevel = 0;
  const modelErrors: Array<{ model: string; error: string }> = [];

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

    // Embeddings are OpenAI-only; a quota/outage there must not silence the
    // agent when the chat chain uses other providers. Degrade to replying
    // without knowledge and record the RAG failure in the logs.
    let relevantChunks: Array<{ id: string; content: string; similarity: number }> = [];
    let ragError: string | null = null;
    const embeddingConfig = resolveEmbeddingConfig();
    try {
      const [inboundEmbedding] = await embedKnowledge(
        [request.inbound_text],
        embeddingConfig,
      );
      const { data: matchedChunks, error: matchError } = await admin.rpc(retrievalRpcName(embeddingConfig), {
        query_embedding: inboundEmbedding,
        p_user_id: request.user_id,
        match_count: 6,
      });
      if (matchError) throw matchError;
      relevantChunks = (matchedChunks || []).filter(
        (chunk: { similarity: number }) => chunk.similarity > SIMILARITY_FLOOR,
      );
    } catch (error) {
      ragError = errorMessage(error).slice(0, 300);
      console.error("[ai-agent-reply] Knowledge lookup failed, replying without RAG:", ragError);
    }
    const retrievedChunkIds: string[] = relevantChunks.map((chunk: { id: string }) => chunk.id);
    let graphError: string | null = null;
    let relatedFacts = "";
    if (retrievedChunkIds.length) {
      try {
        const { data, error } = await admin.rpc("match_ai_knowledge_graph_relations", {
          p_user_id: request.user_id,
          p_source_chunk_ids: retrievedChunkIds,
          match_count: 12,
        });
        if (error) throw error;
        relatedFacts = formatRelatedFacts((data || []) as GraphRelationFact[]);
      } catch (error) {
        graphError = errorMessage(error).slice(0, 300);
        console.error("[ai-agent-reply] Knowledge graph lookup failed:", graphError);
      }
    }

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
      knowledgeBlocks: [
        ...relevantChunks.map((chunk: { content: string }) => chunk.content),
        relatedFacts,
      ].filter(Boolean),
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
      embed: (texts: string[]) => embedKnowledge(texts, embeddingConfig),
      retrievalRpcName: retrievalRpcName(embeddingConfig),
      sendWhatsAppText: async (recipientPhone: string, text: string) => {
        if (!adminNotifier) return;
        await adminNotifier(recipientPhone, text);
      },
    };

    // User-defined connector tools; admin_only ones stay hidden from customers.
    const { data: customToolRows } = await admin
      .from("ai_agent_tools")
      .select("name, description, url, secret, admin_only")
      .eq("user_id", request.user_id)
      .eq("is_enabled", true);
    const customTools: CustomTool[] = (customToolRows || []).filter(
      (tool: CustomTool) => isAdmin || !tool.admin_only,
    );
    const customToolByName = new Map(customTools.map((tool) => [tool.name, tool]));

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
    // Primary + fallback chain, each entry resolved to its provider endpoint.
    const rawChain = [config.model, config.fallback_model_1, config.fallback_model_2]
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    const modelChain = (rawChain.length ? rawChain : ["gpt-4o-mini"]).map(parseModelRef);
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let completion: any = null;
      let lastError: unknown = null;
      for (let mi = 0; mi < modelChain.length; mi++) {
        try {
          completion = await chatCompletion(modelChain[mi].provider, {
            model: modelChain[mi].model,
            temperature: config.temperature ?? 0.4,
            messages,
            tools: [
              ...toolDefinitions,
              ...(isAdmin ? adminToolDefinitions : []),
              ...customToolDefinitions(customTools),
            ],
            tool_choice: "auto",
          });
          usedModel = formatModelRef(modelChain[mi]);
          usedFallbackLevel = mi;
          break;
        } catch (err) {
          lastError = err;
          modelErrors.push({ model: formatModelRef(modelChain[mi]), error: errorMessage(err) });
        }
      }
      if (!completion) throw lastError instanceof Error ? lastError : new Error("All AI models failed");
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
        const customTool = customToolByName.get(toolCall.function.name);
        const result: ToolResult = customTool
          ? await executeCustomTool(toolContext, customTool, args)
          : (isAdmin ? await executeAdminTool(toolContext, toolCall.function.name, args) : null) ??
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

    // Fire-and-forget audit trail for AI agent calls (admin-visible logs).
    try {
      await admin.from("admin_audit_log").insert({
        admin_id: request.user_id,
        action: "ai_agent_reply",
        resource_type: "ai_agent",
        resource_id: request.conversation_id,
        details: {
          platform: request.platform,
          used_model: usedModel,
          fallback_level: usedFallbackLevel,
          model_chain: modelChain.map(formatModelRef),
          model_errors: modelErrors.length ? modelErrors : null,
          tool_calls: executedToolCalls.map((t) => t.name),
          escalated,
          dry_run: dryRun,
        },
      });
    } catch (e) {
      console.error("[ai-agent-reply] audit log insert failed:", errorMessage(e));
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
      }, {
        used_model: usedModel,
        fallback_level: usedFallbackLevel,
        model_errors: modelErrors.length ? modelErrors : null,
        rag_error: ragError,
        graph_error: graphError,
        dry_run: dryRun,
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
    }, {
      used_model: usedModel,
      fallback_level: usedFallbackLevel,
      model_errors: modelErrors.length ? modelErrors : null,
        rag_error: ragError,
        graph_error: graphError,
      tool_calls: executedToolCalls.length ? executedToolCalls.map((t) => t.name) : null,
      escalated,
      dry_run: dryRun,
    });

    return jsonResponse({ ok: true, reply: replyText, escalated, tool_calls: executedToolCalls, is_admin: isAdmin });
  } catch (error) {
    console.error("[ai-agent-reply] Failed:", errorMessage(error));
    await logOutcome(admin, {
      ...baseLog,
      status: "error",
      error: errorMessage(error).slice(0, 500),
      latency_ms: Date.now() - startedAt,
    }, {
      used_model: usedModel,
      fallback_level: usedFallbackLevel,
      model_errors: modelErrors.length ? modelErrors : null,
    });
    return jsonResponse({ ok: false, error: errorMessage(error) });
  }
});
