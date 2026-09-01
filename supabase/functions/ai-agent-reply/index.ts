// Internal AI agent reply engine. Called service-to-service by platform
// webhooks (whatsapp-webhook) after auto-reply rules found no match.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse, badRequestResponse } from "../_shared/cors.ts";
import {
  resolveToolsForAccount,
  type ResolvableTool,
  type ToolAccountLink,
} from "../_shared/toolResolution.ts";
import { loadAgentConfigForAccount } from "../_shared/agentConfigLookup.ts";
import {
  buildSystemPrompt,
  completionFailure,
  detectReplyLanguage,
  formatRelatedFacts,
  formatModelRef,
  type GraphRelationFact,
  ModelChainExhaustedError,
  modelBudgetRemaining,
  type ModelRef,
  parseModelRef,
  resolveEngagementMode,
  type ReplyLanguage,
  SIMILARITY_FLOOR,
  shouldAiReply,
  waRecipient,
} from "./logic.ts";
import { flattenChatLinks } from "./chatLinks.ts";
import {
  customToolDefinitions,
  type EscalationTarget,
  executeTool,
  toolDefinitions,
  type CustomTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";
import { executeRoutedCustomTool } from "./connectorExecution.ts";
import { deliverModelOutageFloor } from "./outage-floor.ts";
import { resolveAgentAccountId } from "./accountScope.ts";
import {
  cancelOutboxRow,
  deliverGeneratedReply,
  deliverStoredReply,
  releaseAfterError,
  takeOutboxRow,
} from "./outbox.ts";
import { adminToolDefinitions, executeAdminTool } from "./admin-tools.ts";
import { getSendCredentials } from "../_shared/messengerCredentials.ts";
import { replyToComment } from "../_shared/commentActions.ts";
import { commentConversationLikePrefix, isCommentConversationId } from "../_shared/commentConversation.ts";
import { resolveWhatsAppTransport } from "../_shared/whatsappTransport.ts";
import {
  resolveDualEmbeddingConfigFromDb,
  retrieveKnowledgeChunks,
} from "../_shared/knowledgeEmbeddings.ts";

const OPENAI_API = "https://api.openai.com/v1";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Only the last 4 stored turns are replayed to the model on each reply, to keep
// the prompt (and token cost) small; older context lives in ai_thread_messages.
const HISTORY_LIMIT = 4;

// For WhatsApp, recipient_phone is the customer's phone and phone_number_id
// the business number. For Facebook/Instagram, recipient_phone carries the
// sender PSID and phone_number_id is unused.
//
// comment_id turns the request into a reply to a public comment instead of a DM: the
// delivery path becomes the platform's comment API and recipient_phone carries the comment
// author's id (or handle on Threads) only so the request shape and log rows stay uniform.
interface ReplyRequest {
  user_id: string;
  platform: string;
  social_account_id: string;
  conversation_id: string;
  phone_number_id?: string;
  recipient_phone: string;
  inbound_text: string;
  comment_id?: string;
  /** Language the caller already detected (e.g. a transcript's "ara"). Beats counting. */
  language_hint?: string;
  /**
   * The pending_agent_replies row this request is working for, set by the webhooks and the
   * recovery job. Its state decides whether this call generates or only redelivers stored
   * text, and every step that precedes an external side effect is confirmed against it.
   * Absent from every caller that predates the outbox, and from the sandbox.
   */
  outbox_id?: string;
}

// Comment text is attacker-controlled free text on a public surface. The prompt sees the
// same bound the log row already applies, so a wall of text cannot push the persona and
// knowledge blocks out of the model's attention.
const MAX_INBOUND_CHARS = 2000;

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

async function chatCompletion(
  provider: string,
  payload: Record<string, unknown>,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<any> {
  const endpoint = PROVIDER_ENDPOINTS[provider] ?? PROVIDER_ENDPOINTS.openai;
  const key = Deno.env.get(endpoint.keyEnv);
  if (!key) throw new Error(`${endpoint.keyEnv} is not configured`);
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${provider}/${payload.model} timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Chat completion failed");
  // A 200 is not yet a completion -- see completionFailure. Throwing here is what puts
  // the failure inside the caller's per-model try, so the next model in the chain gets
  // tried and a total outage still reaches the delivery floor.
  const failure = completionFailure(data);
  if (failure) throw new Error(failure);
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

// daily_message_cap counts sent replies since UTC midnight. For DMs the unit is one
// conversation; for comments it is the whole account.
//
// The difference matters: comment conversations are per (post, commenter), so a
// per-conversation cap would only be reached by someone who commented `cap` times under the
// same post. Five hundred different people commenting once each would be five hundred model
// calls and five hundred public replies with the cap never reached. Counting every comment
// conversation on the account makes it an actual spend ceiling.
async function isDailyCapReached(admin: any, request: ReplyRequest, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const counted = admin
    .from("ai_agent_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", request.user_id)
    .eq("status", "sent")
    .gte("created_at", midnightUtc.toISOString());
  const { count } = await (isCommentConversationId(request.conversation_id)
    ? counted.like("conversation_id", commentConversationLikePrefix(request.social_account_id))
    : counted.eq("conversation_id", request.conversation_id));
  return (count || 0) >= cap;
}

// Statuses that represent a failed reply. Anything else is normal operation.
const ERROR_LOG_STATUSES = new Set([
  "error",
  "escalated_after_model_exhaustion",
  "model_exhaustion_unhandled",
]);

// Every outcome is written twice: to ai_agent_logs (user-facing Logs tab,
// RLS-scoped) and mirrored into system_logs so the /admin/logs page can
// track all AI agent chats and calls under the "ai" category.
// social_account_id reaches this function as a plain string and the sandbox
// substitutes the literal "test" when no account is named. Postgres raises
// 22P02 for a non-uuid compared against a uuid column, so the shape is checked
// here rather than discovered as a failed reply.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    level: ERROR_LOG_STATUSES.has(status) ? "error" : "info",
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

type TextSender = (recipientId: string, text: string) => Promise<string>;

async function buildWhatsAppTextSender(admin: any, account: any, fallbackPhoneNumberId?: string): Promise<TextSender> {
  if (!account.platform_user_id && !fallbackPhoneNumberId) throw new Error("No WhatsApp phone number available for this account");
  const transport = await resolveWhatsAppTransport(admin, {
    ...account,
    platform_user_id: account.platform_user_id || fallbackPhoneNumberId,
  });
  return async (recipientId, text) => (await transport.sendText({ recipientPhone: recipientId, text })).messageId || `ai_${Date.now()}`;
}

// Public comments are answered through the platform's comment API, which the comment
// manager and the n8n Comment resource already share. That module is also where the Threads
// two-step publish lives (create a container with reply_to_id, then publish it), so routing
// Threads through here is what gives the Threads agent a delivery path at all -- Threads
// exposes no DM API for the Send-API branch below to use.

async function buildCommentReplySender(admin: any, request: ReplyRequest): Promise<TextSender> {
  const { data: account, error } = await admin
    .from("social_accounts")
    .select("platform, access_token, platform_user_id, ig_auth_type, account_metadata")
    .eq("id", request.social_account_id)
    .eq("user_id", request.user_id)
    // The platform has to match the request, not merely the owner. Without
    // this, a request naming platform "instagram" with a Facebook account id
    // resolved no agent account (resolveAgentAccountId refuses the mismatch),
    // fell back to the owner's Instagram persona, and then delivered it here
    // through the Facebook account -- an Instagram voice posted publicly on a
    // Facebook page. A mismatch must refuse, not deliver a hybrid.
    .eq("platform", request.platform)
    .maybeSingle();
  if (error || !account) throw new Error("Account not found for AI comment reply");

  const commentId = request.comment_id!;
  return async (_authorId, text) => {
    // replyToComment reports failure by return value; TextSender's contract is to throw.
    // Returning here instead would log a public reply that never happened as "sent".
    const result = await replyToComment(account, commentId, text);
    if (!result.success) throw new Error(result.error || "Comment reply failed");
    return result.platform_comment_id || `ai_${Date.now()}`;
  };
}

// Resolves how to deliver the reply for the request's platform. WhatsApp uses
// the Cloud API messages endpoint; Facebook/Instagram use the page Send API
// (shared credential resolution with the fb-ig webhook).
async function buildReplySender(admin: any, request: ReplyRequest): Promise<TextSender> {
  if (request.comment_id) return buildCommentReplySender(admin, request);

  if (request.platform === "whatsapp") {
    const { data: account, error } = await admin
      .from("social_accounts")
      .select("id, platform_user_id, access_token, connection_mode, account_metadata")
      .eq("id", request.social_account_id)
      .eq("user_id", request.user_id)
      .eq("platform", request.platform)
      .maybeSingle();
    if (error || !account) throw new Error("WhatsApp account not found for AI reply");
    return buildWhatsAppTextSender(admin, account, request.phone_number_id);
  }

  const { data: account, error } = await admin
    .from("social_accounts")
    .select("*")
    // Owner alone is not enough. resolveAgentAccountId refuses a platform
    // mismatch by returning null, which means "fall back to the platform
    // config" -- so a request naming instagram with a Facebook account id
    // loaded the Instagram persona and would have delivered it through the
    // Facebook page. Every sender matches the request's platform so the
    // mismatch fails here instead of speaking in the wrong brand's voice.
    .eq("platform", request.platform)
    .eq("user_id", request.user_id)
    .eq("id", request.social_account_id)
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
    const { data: account, error } = await admin
      .from("social_accounts")
      .select("id, platform_user_id, access_token, connection_mode, account_metadata")
      .eq("id", request.social_account_id)
      .eq("user_id", request.user_id)
      .maybeSingle();
    if (error || !account) throw new Error("WhatsApp account not found for admin notifications");
    return buildWhatsAppTextSender(admin, account, request.phone_number_id);
  }

  const { data: waAccount } = await admin
    .from("social_accounts")
    .select("id, platform_user_id, access_token, connection_mode, account_metadata")
    .eq("user_id", request.user_id)
    .eq("platform", "whatsapp")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (!waAccount) throw new Error("No WhatsApp account available for admin notifications");
  return buildWhatsAppTextSender(admin, waAccount, Deno.env.get("WHATSAPP_PHONE_NUMBER_ID"));
}

// The three admin-managed global slots, in the order they are tried. Written by
// the AI Agent Models card in /admin/settings.
const AGENT_MODEL_KEYS = [
  "default_ai_model_agent",
  "default_ai_model_agent_fallback",
  "default_ai_model_agent_fallback_2",
] as const;

function isModelSetting(value: any): value is { provider_code: string; model_id: string } {
  return Boolean(value) &&
    typeof value.provider_code === "string" && value.provider_code.length > 0 &&
    typeof value.model_id === "string" && value.model_id.length > 0;
}

/**
 * Reads the global model chain. One set of models serves every user and every
 * platform; ai_agent_configs.model and its two fallback columns are deprecated
 * and no longer read.
 *
 * A valid Primary is required and a gap ends the chain. Filtering the missing
 * slots out instead would let an unset Primary promote Fallback 2 to index 0,
 * where it would run as the primary model and be logged with fallback_level 0 --
 * hiding both the misconfiguration and which tier actually answered.
 */
async function loadGlobalModelChain(admin: any): Promise<string[]> {
  const { data, error } = await admin
    .from("system_settings")
    .select("key, value")
    .in("key", AGENT_MODEL_KEYS);
  if (error) throw error;

  const byKey = new Map((data || []).map((row: any) => [row.key, row.value]));
  const slots = AGENT_MODEL_KEYS.map((key) => byKey.get(key));

  if (!isModelSetting(slots[0])) return [];

  const chain: string[] = [];
  for (const slot of slots) {
    if (!isModelSetting(slot)) break;
    chain.push(`${slot.provider_code}/${slot.model_id}`);
  }
  return chain;
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
    // The sandbox tests ONE account's agent. Without this it fabricated the
    // "test" sentinel, which resolves to no account -- so it fell through to
    // the platform fallback, and the moment a platform holds more than one
    // config that fallback's maybeSingle() returns a multiple-rows error and
    // every test answers agent_not_configured. Naming the account also keeps
    // knowledge retrieval scoped to the same corpus the live agent would read.
    const requestedAccount = typeof body.social_account_id === "string" && body.social_account_id.trim()
      ? body.social_account_id.trim()
      : null;
    let sandboxAccountId: string | null = null;
    if (requestedAccount) {
      const { data: owned } = await admin
        .from("social_accounts")
        .select("id")
        .eq("id", requestedAccount)
        .eq("user_id", user.id)
        .eq("platform", platform)
        .maybeSingle();
      // Refused rather than silently downgraded to the sentinel: a test that
      // quietly exercises a different account's persona is worse than an error.
      if (!owned) return badRequestResponse("Account not found");
      sandboxAccountId = owned.id;
    }
    // Built field by field rather than from the body: comment_id is the one field that makes
    // this function post publicly, and it must never be reachable from a user JWT.
    request = {
      user_id: user.id,
      platform,
      social_account_id: sandboxAccountId ?? "test",
      // Keyed by account so one account's test turns cannot replay as
      // another's; the owner-only key is kept for a caller naming no account.
      conversation_id: `test_${platform}_${sandboxAccountId ?? user.id}`,
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
    // On EVERY outcome row, not only the successful one: recovery reads the Logs tab too, and
    // has to tell "never ran" from "ran and failed" for the same work item.
    idempotency_key: request.outbox_id ?? null,
  };
  const outboxId = dryRun ? null : request.outbox_id ?? null;

  // Hoisted so the catch block can report which models were attempted.
  let usedModel: string | null = null;
  let usedFallbackLevel = 0;
  const modelErrors: Array<{ model: string; error: string }> = [];

  // Hoisted out of the try below so the model-outage floor in the catch can reach
  // them. A value declared inside the try is invisible to its own catch.
  let replySender: TextSender | null = null;
  let language: ReplyLanguage = "en";
  let escalationTarget: EscalationTarget | null = null;
  let modelChain: ModelRef[] = [];
  // Set when a tool escalated during this request. The loop runs another iteration
  // afterwards so the model can phrase a closing message, so exhaustion in THAT
  // iteration would otherwise escalate a second time -- closing and recreating the
  // active assignment, duplicating history, and notifying admins twice.
  let escalated = false;
  // Whether that tool escalation actually reached a person. escalate_to_human reports
  // success on a bare mute, so the floor cannot infer this from `escalated`.
  let escalationNotifiedHuman = false;
  // Whether anything externally visible happened before a failure: a tool ran, or the
  // outage floor sent something. Decides whether the outbox row may be retried (nothing
  // happened) or must go to a human (something may have).
  let sideEffectsHappened = false;

  try {
    const knowledgeAccountId = await resolveAgentAccountId(admin, request);
    const config = await loadAgentConfigForAccount(admin, {
      userId: request.user_id,
      platform: request.platform,
      accountId: knowledgeAccountId,
    }) as any;
    // Both are terminal for an outbox row: recovery re-driving it would reach the same
    // answer three times over and then mark it failed for no reason.
    // Both exits are logged. They were the only two silent ones, and that is why
    // an agent that had stopped replying for hours showed no evidence at all --
    // every other refusal in this function writes a row saying which gate closed.
    if (!config) {
      await logOutcome(admin, { ...baseLog, status: "skipped", error: "agent_not_configured" });
      if (outboxId) await cancelOutboxRow(admin, outboxId, "agent_not_configured");
      return jsonResponse({ ok: true, skipped: "agent_not_configured" });
    }
    // The Test sandbox works while the agent is still disabled, so users can
    // tune it before switching it on for real customers.
    if (!config.is_enabled && !dryRun) {
      await logOutcome(admin, { ...baseLog, status: "skipped", error: "agent_disabled" });
      if (outboxId) await cancelOutboxRow(admin, outboxId, "agent_disabled");
      return jsonResponse({ ok: true, skipped: "agent_disabled" });
    }

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
        dailyCapReached: await isDailyCapReached(admin, request, config.daily_message_cap),
      });
      if (!gate.reply) {
        await logOutcome(admin, { ...baseLog, status: "skipped", error: gate.reason });
        // Terminal for the work item: a closed gate is a decision, and recovery re-driving
        // the row would only reach the same gate.
        if (outboxId) await cancelOutboxRow(admin, outboxId, gate.reason);
        return jsonResponse({ ok: true, skipped: gate.reason });
      }
    }

    // Everything the reply is delivered through, resolved before any billable work so the
    // redelivery branch below can send without paying for retrieval it will not use.
    replySender = dryRun ? null : await buildReplySender(admin, request);

    // Declared here rather than beside the tool loop because persistDelivery reads it, and a
    // redelivery persists before the loop has run at all. Empty is the truthful value there:
    // a redelivered reply executed no tools on this invocation.
    const executedToolCalls: Array<{ name: string; arguments: unknown }> = [];

    /**
     * Writes what a reply leaves behind. Shared by redelivery and fresh sends.
     *
     * `outboundMessageId` is null on a sandbox run, which sends nothing -- the thread turns
     * are still written there, because the sandbox's whole purpose is to hold a conversation.
     */
    const persistDelivery = async (
      text: string,
      outboundMessageId: string | null,
      toolCalls: unknown[] = executedToolCalls,
    ) => {
      // Local message storage exists only for WhatsApp; FB/IG conversations are read live
      // from the Graph API.
      if (request.platform === "whatsapp" && outboundMessageId) {
        await admin.from("whatsapp_messages").insert({
          user_id: request.user_id,
          social_account_id: request.social_account_id,
          conversation_id: request.conversation_id,
          message_id: outboundMessageId,
          from_phone: request.phone_number_id,
          from_name: "AI Agent",
          to_phone: request.recipient_phone,
          message_text: text,
          message_type: "text",
          direction: "outbound",
          status: "sent",
          timestamp: new Date().toISOString(),
        });
      }
      const { error: threadWriteError } = await admin.from("ai_thread_messages").insert([
        { thread_id: thread.id, user_id: request.user_id, role: "user", content: request.inbound_text },
        {
          thread_id: thread.id,
          user_id: request.user_id,
          role: "assistant",
          content: text,
          tool_calls: toolCalls.length ? toolCalls : null,
        },
      ]);
      if (threadWriteError) console.error("[ai-agent-reply] Thread write failed:", threadWriteError.message);
    };

    // The outbox decides what this invocation may do, and it decides BEFORE any billable
    // work. A row that already holds a generated reply is DELIVERED, not regenerated --
    // re-entering the model chain and the tool loop for it is the replay the two-stage
    // design exists to prevent. A fresh row is claimed into `running` here, before the
    // embedding lookup below (which calls an external provider) and before any tool can
    // fire, so a later kill leaves a state recovery can classify rather than one that
    // wrongly reads as "nothing external happened".
    if (outboxId && replySender) {
      const entry = await takeOutboxRow(admin, outboxId);
      if (entry.mode === "refuse") {
        console.warn(`[ai-agent-reply] outbox row ${outboxId} not runnable: ${entry.status}`);
        return jsonResponse({ ok: false, error: `outbox row not runnable: ${entry.status}` }, 409);
      }
      if (entry.mode === "redeliver") {
        const sender = replySender;
        const outboundMessageId = await deliverStoredReply(
          admin, outboxId, entry.text, (text) => sender(request.recipient_phone, text),
        );
        // The same trail a fresh delivery leaves. Without it the customer has a reply that
        // is missing from the inbox UI and from the thread the next turn reads -- so the
        // agent would answer as though it had never spoken, and the cooldown could not see
        // the assistant turn either. A redelivery only ever runs from `ready_to_send`, which
        // means the original attempt died at or before its send, so nothing was written yet
        // and these are not duplicates.
        //
        // The tool calls come from the ROW, not from this invocation -- which ran none. An
        // empty list here would record a reply that had used tools as having used none.
        await persistDelivery(entry.text, outboundMessageId, entry.toolCalls ?? []);
        await logOutcome(admin, {
          ...baseLog,
          reply_text: entry.text.slice(0, 4000),
          tool_calls: entry.toolCalls?.length ? entry.toolCalls : null,
          latency_ms: Date.now() - startedAt,
          status: "sent",
        }, { redelivered: true, outbound_message_id: outboundMessageId });
        return jsonResponse({ ok: true, redelivered: true, reply: entry.text });
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

    // Retrieval uses the primary embedding provider and fails over to the
    // configured fallback provider's vector column when the primary is down. If
    // both are unavailable, degrade to replying without knowledge and record the
    // RAG failure in the logs rather than silencing the agent.
    let relevantChunks: Array<{ id: string; content: string; similarity: number }> = [];
    let ragError: string | null = null;
    const embeddingConfig = await resolveDualEmbeddingConfigFromDb(admin);
    try {
      const matchedChunks = await retrieveKnowledgeChunks(
        async (name, params) => await admin.rpc(name, params),
        {
          userId: request.user_id,
          socialAccountId: knowledgeAccountId,
          query: request.inbound_text,
          matchCount: 6,
        },
        embeddingConfig,
      );
      relevantChunks = matchedChunks.filter(
        (chunk) => chunk.similarity > SIMILARITY_FLOOR,
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
        // Graph expansion is the third retrieval path and the easiest to miss.
        // Entities are shared across a user's sources by design, so filtering by
        // entity would let a linked source's entity pull in relations extracted
        // from an unlinked one. The account-scoped function filters by relation
        // provenance instead.
        const { data, error } = knowledgeAccountId
          ? await admin.rpc("match_ai_knowledge_graph_relations_for_account", {
            p_user_id: request.user_id,
            p_social_account_id: knowledgeAccountId,
            p_source_chunk_ids: retrievedChunkIds,
            match_count: 12,
          })
          : await admin.rpc("match_ai_knowledge_graph_relations", {
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

    language = detectReplyLanguage(request.inbound_text, config.language_mode, request.language_hint);
    // Resolved on first use rather than up front. buildAdminNotifier throws when the user has
    // no connected WhatsApp account, and awaiting it here made that throw abort the entire
    // reply -- so a Facebook, Instagram or Threads user without WhatsApp got no answer at all,
    // even with no admin numbers configured. notifyAdmins already catches per recipient, which
    // is where the failure belongs.
    let adminNotifier: Promise<TextSender> | null = null;
    const notifyAdmin: TextSender = async (recipientPhone, text) => {
      adminNotifier ??= buildAdminNotifier(admin, request);
      return await (await adminNotifier)(recipientPhone, text);
    };
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
      // Same scope as the initial lookup. Fixing only the first retrieval path
      // would leave the model able to reach every source by calling the tool.
      retrieveKnowledge: (query: string, matchCount: number) =>
        retrieveKnowledgeChunks(
          async (name, params) => await admin.rpc(name, params),
          {
            userId: request.user_id,
            socialAccountId: knowledgeAccountId,
            query,
            matchCount,
          },
          embeddingConfig,
        ),
      sendWhatsAppText: async (recipientPhone: string, text: string) => {
        if (dryRun) return;
        await notifyAdmin(recipientPhone, text);
      },
    };
    escalationTarget = toolContext;

    // User-defined connector tools, narrowed to THIS account.
    //
    // Loading by user_id alone -- which is what this did until PR-5 -- offered
    // every tool the login owned to every account's agent, so one Facebook
    // page answered customers out of another page's store. Migration A scoped
    // the table; this query and resolveToolsForAccount are what make that
    // scoping real.
    const { data: customToolRows } = await admin
      .from("ai_agent_tools")
      .select("id, name, description, url, secret, admin_only, scope, social_account_id, connector_type")
      .eq("user_id", request.user_id)
      .eq("is_enabled", true);

    // The sandbox passes the literal "test" when a caller names no account, and
    // .eq() against a uuid column with a non-uuid raises 22P02 -- which would
    // kill a reply over a tool list. Anything unusable degrades to the
    // all_accounts corpus instead.
    const scopedAccountId = UUID_PATTERN.test(request.social_account_id)
      ? request.social_account_id
      : null;

    let toolLinks: ToolAccountLink[] = [];
    let toolLinksDegraded = false;
    if (scopedAccountId) {
      // Scoped by user_id as well as account: this runs under the service role,
      // so RLS is not evaluated and tenancy has to be structural (ARCHITECTURE
      // §24). Without it another tenant's link row would grant access here.
      const { data: linkRows, error: linkError } = await admin
        .from("ai_agent_tool_accounts")
        .select("tool_id, social_account_id")
        .eq("user_id", request.user_id)
        .eq("social_account_id", scopedAccountId);
      if (linkError) {
        // Codex P1. PostgREST returns { data: null, error } on a timeout, and
        // `linkRows || []` turned that into "this account was shared nothing" --
        // so every explicitly shared connector silently vanished from the prompt
        // and the customer got an answer as if it had never been configured.
        // The reply still proceeds on owned + all_accounts, because failing a
        // customer over a degraded read is worse; but it is now SAID, not
        // silently assumed.
        toolLinksDegraded = true;
        console.error(
          "[ai-agent-reply] connector link read failed; shared connectors omitted:",
          linkError.message,
        );
      }
      toolLinks = (linkRows || []) as ToolAccountLink[];
    }

    // admin_only is passed IN rather than filtered out afterwards: narrowing
    // after collision resolution let an admin-only tool win a name and then be
    // removed, leaving a customer with neither connector (Codex P2).
    const toolResolution = resolveToolsForAccount(
      (customToolRows || []) as ResolvableTool[],
      toolLinks,
      scopedAccountId,
      { includeAdminOnly: isAdmin },
    );
    const customTools: CustomTool[] = toolResolution.tools;
    const customToolByName = new Map(customTools.map((tool) => [tool.name, tool]));

    // Built HERE, not where the knowledge was gathered, because the prompt now
    // has to name the connectors this account actually resolved. A rule that
    // merely alludes to "a connector" loses to a persona holding a ready
    // answer -- a configured Supabase price table went unqueried that way
    // (2026-09-01). systemPrompt is read once, at the messages array below.
    const systemPrompt = buildSystemPrompt({
      persona: config.persona_instructions,
      language,
      // "ar"/"en" is a deliberate operator choice; "auto" mirrors the customer.
      languageForced: config.language_mode === "ar" || config.language_mode === "en",
      knowledgeBlocks: [
        ...relevantChunks.map((chunk: { content: string }) => chunk.content),
        relatedFacts,
      ].filter(Boolean),
      nowIso: new Date().toISOString(),
      isAdmin,
      surface: request.comment_id ? "comment" : "dm",
      connectorNames: customTools.map((tool) => tool.name),
    });

    if (toolResolution.droppedDuplicates.length > 0) {
      // Recorded in system_logs rather than ai_agent_logs: the latter is the
      // user's Logs tab, one row per reply, and a diagnostic row there would
      // read as a reply that never happened. Awaited but never allowed to
      // throw -- a failed log must not cost a customer their answer.
      console.warn(
        "[ai-agent-reply] dropped duplicate connector names:",
        JSON.stringify(toolResolution.droppedDuplicates),
      );
      // The insert result is INSPECTED, not just awaited (Codex P2). PostgREST
      // reports a constraint violation in the returned `error` rather than
      // throwing, so a try/catch alone would have made a rejected diagnostic
      // indistinguishable from a written one. `ai` and `warn` are both in the
      // live CHECK constraints, verified on the server -- the checked-in
      // migrations list fewer categories than production actually allows.
      try {
        const { error: logError } = await admin.from("system_logs").insert({
          source: "ai-agent-reply",
          category: "ai",
          level: "warn",
          message: `Dropped ${toolResolution.droppedDuplicates.length} duplicate connector name(s) for this account`,
          user_id: request.user_id,
          metadata: {
            platform: request.platform,
            social_account_id: scopedAccountId,
            links_degraded: toolLinksDegraded,
            dropped: toolResolution.droppedDuplicates,
          },
        });
        if (logError) {
          console.error("[ai-agent-reply] Duplicate-connector log rejected:", logError.message);
        }
      } catch (logError) {
        console.error("[ai-agent-reply] Failed to log dropped duplicates:", logError);
      }
    }

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: request.inbound_text.slice(0, MAX_INBOUND_CHARS) },
    ];
    let promptTokens = 0;
    let completionTokens = 0;
    let replyText = "";

    const maxIterations = Math.max(1, config.max_tool_iterations || 5);
    // Primary + fallback chain, each entry resolved to its provider endpoint.
    // Global as of 2026-08-27: config.model, config.fallback_model_1 and
    // config.fallback_model_2 are deprecated, still in the database but no longer
    // read. Scheduled for removal after a verification window -- see
    // docs/superpowers/specs/2026-08-27-agent-model-selection-design.md §3e.
    const rawChain = await loadGlobalModelChain(admin);
    if (!rawChain.length) {
      // No hardcoded last resort. Calling a model no admin selected is how an
      // unlisted gpt-4o-mini kept answering; a human is the better fallback.
      throw new ModelChainExhaustedError("No global AI agent model is configured");
    }
    modelChain = rawChain.map(parseModelRef);
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let completion: any = null;
      let lastError: unknown = null;
      for (let mi = 0; mi < modelChain.length; mi++) {
        // The worker is killed at 60s. Three models at CHAT_TIMEOUT_MS need 75s, so
        // without this the isolate dies mid-chain and takes the outage floor with it
        // -- the failure mode index.ts:72 describes. Stop early and let the floor run.
        const budgetMs = modelBudgetRemaining(startedAt, Date.now());
        if (budgetMs <= 0) {
          modelErrors.push({
            model: formatModelRef(modelChain[mi]),
            error: "request budget exhausted before this model was tried",
          });
          break;
        }
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
          }, Math.min(CHAT_TIMEOUT_MS, budgetMs));
          usedModel = formatModelRef(modelChain[mi]);
          usedFallbackLevel = mi;
          break;
        } catch (err) {
          lastError = err;
          modelErrors.push({ model: formatModelRef(modelChain[mi]), error: errorMessage(err) });
        }
      }
      if (!completion) {
        // Typed so the catch can tell a total model outage apart from the
        // database, send, and validation errors that share it. Per-model detail
        // is already in modelErrors.
        throw new ModelChainExhaustedError(
          lastError instanceof Error ? lastError.message : "All AI models failed",
        );
      }
      promptTokens += completion.usage?.prompt_tokens || 0;
      completionTokens += completion.usage?.completion_tokens || 0;
      // chatCompletion rejects any body that lacks one, so this cannot be undefined.
      const choice = completion.choices[0].message;

      if (!choice.tool_calls?.length) {
        // Flattened here, at the single place a reply is born, so the repair
        // covers the send, the stored transcript and the sandbox alike.
        replyText = flattenChatLinks((choice.content || "").trim());
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
        sideEffectsHappened = true;
        const customTool = customToolByName.get(toolCall.function.name);
        const result: ToolResult = customTool
          ? await executeRoutedCustomTool(toolContext, customTool, args)
          : (isAdmin ? await executeAdminTool(toolContext, toolCall.function.name, args) : null) ??
            (await executeTool(toolContext, toolCall.function.name, args));
        if (result.escalated) {
          escalated = true;
          if (result.humanNotified) escalationNotifiedHuman = true;
        }
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
      if (outboxId) await cancelOutboxRow(admin, outboxId, "no_reply_generated");
      return jsonResponse({ ok: true, skipped: "no_reply_generated" });
    }

    let outboundMessageId: string | null = null;
    if (!dryRun && replySender) {
      const sender = replySender;
      // With an outbox row, the send is wrapped in three durable steps (persist the text,
      // mark sending, mark sent) so a kill at any point leaves a state recovery can act on
      // without guessing. Without one -- callers that predate the outbox -- it is the plain
      // send it always was.
      outboundMessageId = outboxId
        ? await deliverGeneratedReply(
          admin,
          outboxId,
          { text: replyText, toolCalls: executedToolCalls },
          (text) => sender(request.recipient_phone, text),
        )
        : await sender(request.recipient_phone, replyText);
    }

    // Outside the send block, exactly as before: a sandbox run writes its thread turns
    // without sending anything.
    await persistDelivery(replyText, outboundMessageId);

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
    if (error instanceof ModelChainExhaustedError && !dryRun) {
      const floor = await deliverModelOutageFloor(
        request, replySender, language, escalationTarget,
        { escalated, humanNotified: escalationNotifiedHuman },
      );
      await logOutcome(admin, {
        ...baseLog,
        // Two statuses, so the log never claims more than happened: the second
        // means every model failed AND the handoff failed, so nothing was sent
        // and the conversation is still on the AI.
        status: floor.escalated ? "escalated_after_model_exhaustion" : "model_exhaustion_unhandled",
        error: errorMessage(error).slice(0, 500),
        latency_ms: Date.now() - startedAt,
      }, {
        used_model: usedModel,
        fallback_level: usedFallbackLevel,
        model_errors: modelErrors.length ? modelErrors : null,
        model_chain: modelChain.map(formatModelRef),
        ...floor,
      });
      if (outboxId) {
        // Escalated means the floor did something external -- assigned a human, notified
        // admins, sent an apology. Terminal: recovery re-running this would do it all twice.
        // Unhandled means nothing happened, and the row may be retried once models recover.
        if (floor.escalated) await cancelOutboxRow(admin, outboxId, "model outage handled by escalation");
        else await releaseAfterError(admin, outboxId, { sideEffectsHappened, error: errorMessage(error) });
      }
      // apology_sent and human_notified travel in the body so a caller can tell this apart
      // from an ordinary failure: parseAgentReplyResult reads `escalated` as terminal.
      return jsonResponse({
        ok: false,
        error: errorMessage(error),
        escalated: floor.escalated,
        apology_sent: floor.apology_sent,
        human_notified: floor.human_notified,
      });
    }
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
    if (outboxId) await releaseAfterError(admin, outboxId, { sideEffectsHappened, error: errorMessage(error) });
    return jsonResponse({ ok: false, error: errorMessage(error) });
  }
});
