// Internal AI agent reply engine. Called service-to-service by platform
// webhooks (whatsapp-webhook) after auto-reply rules found no match.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleCorsOptions, jsonResponse, unauthorizedResponse, badRequestResponse, corsHeaders } from "../_shared/cors.ts";
import { checkUserRateLimit, rateLimitExceededResponse } from "../_shared/rate-limiter.ts";
import {
  resolveToolsForAccount,
  type ResolvableTool,
  type ToolAccountLink,
} from "../_shared/toolResolution.ts";
import { loadAgentConfigForAccount } from "../_shared/agentConfigLookup.ts";
import { resolveConversationOverride } from "../_shared/conversationModeOverride.ts";
import {
  buildSystemPrompt,
  completionFailure,
  detectReplyLanguage,
  formatRelatedFacts,
  formatModelRef,
  type GraphRelationFact,
  ModelChainExhaustedError,
  iterationBudget,
  jevStartKey,
  modelBudgetRemaining,
  parseModelRef,
  evaluateGates,
  parallelizable,
  phaseTimings,
  procedurePromptBlock,
  procedureStateAfterTurn,
  procedureStoreTool,
  procedureTurnGate,
  replyIntentFields,
  resolveEngagementMode,
  invalidTestCaseKeyRefusalLog,
  sandboxRateLimitedLog,
  sandboxConversationId,
  type ReplyLanguage,
  SIMILARITY_FLOOR,
  shouldAiReply,
  triageSystemHint,
  waRecipient,
} from "./logic.ts";
import { repairChatReply } from "./chatLinks.ts";
import {
  customToolDefinitions,
  type EscalationTarget,
  executeTool,
  agentToolDefinitions,
  notifyAdmins,
  type CustomTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";
import { connectorCallFailed, executeProcedureStoreCall, executeRoutedCustomTool } from "./connectorExecution.ts";
import { deliverModelOutageFloor } from "./outage-floor.ts";
import { applyIntentLabel, intentLabelFor, shouldLabel, type LabelDb } from "./intentLabels.ts";
import { dashboardColumns } from "./dashboardColumns.ts";
import {
  type AdminClient as AccountScopeAdminClient,
  resolveAgentAccountId,
} from "./accountScope.ts";
import { attachComposioTools } from "./composioTools.ts";
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

import { type AiTier, fetchWithTimeout, resolvePlatformApiKey } from "../_shared/ai-fallback.ts";
import { callAnthropicJson } from "../_shared/anthropic-adapter.ts";
import { composeAiTiers, invalidateRejectedUserTier, resolveUserAiRoute, type AiRoutingAdmin } from "../_shared/ai-user-routing.ts";
import { AI_CONNECTION_REQUIRED, AI_USER_KEY_INVALID, ProviderHttpError, redactProviderError } from "../_shared/ai-routing-errors.ts";
import { loadOpenAiCompatibleBase, type RowReader } from "../_shared/providerEndpoint.ts";
import { runTriage, selectConnectorTools, TRIAGE_SETTING_KEYS, triageChainFromSettings, type TriageRun } from "../_shared/agentTriage.ts";
import { resolveProviderKey } from "../_shared/providerKeys.ts";
import { enabledProcedures, readProcedureConfig } from "../_shared/procedures/config.ts";
import { expireIfStale, isPendingOpener } from "../_shared/procedures/engine.ts";
import {
  createProcedureTurn,
  fieldsFor,
  planWaitlistJoin,
  PROCEDURE_TOOL_NAMES,
  procedureToolDefinitions,
  stepGuidance,
  stockSightingsFromToolOutput,
  stockWaitlistToolDefinition,
  type StockSighting,
} from "./procedureRuntime.ts";
import { PROCEDURE_STATE_CONFLICT, persistProcedureState } from "./procedureState.ts";

const OPENAI_API = "https://api.openai.com/v1";
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Only the last 6 stored turns are replayed to the model on each reply, to keep
// the prompt (and token cost) small; older context lives in ai_thread_messages.
//
// Raised from 4 on 2026-09-02: at 4 rows the model saw roughly two exchanges, so a
// customer returning to an existing thread ("the one I asked about earlier") got an
// agent with no idea what that referred to. The 4 was set when the prompt also carried
// a long stale price list; prices now come from the connector, which freed the budget.
const HISTORY_LIMIT = 6;

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

// Read-only connector calls in one round run concurrently, at most this many at
// a time (Phase 2): three keeps the reply's connector latency bounded by its
// slowest call without opening an unbounded fan-out at the adapter.
const PARALLEL_TOOLS_PER_CHUNK = 3;

// OpenAI-compatible chat-completion endpoints per provider. Providers here
// must stay in sync with the choices offered in AdminAiAgentSection.tsx.
// Providers not listed here resolve through ai_providers (providerEndpoint.ts).
const GOOGLE_ENDPOINT = { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", keyEnv: "GOOGLE_AI_STUDIO_KEY" };
const PROVIDER_ENDPOINTS: Record<string, { url: string; keyEnv: string; kind?: "anthropic" }> = {
  claude: { url: "https://api.anthropic.com/v1/messages", keyEnv: "ANTHROPIC_API_KEY", kind: "anthropic" },
  openai: { url: `${OPENAI_API}/chat/completions`, keyEnv: "OPENAI_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", keyEnv: "OPENROUTER_API_KEY" },
  // The admin model catalog (ai_providers) codes Google as "gemini"; accept both.
  google: GOOGLE_ENDPOINT,
  gemini: GOOGLE_ENDPOINT,
};

export async function chatCompletion(
  tier: AiTier,
  payload: Record<string, unknown>,
  timeoutMs = CHAT_TIMEOUT_MS,
  admin?: AiRoutingAdmin,
): Promise<any> {
  const provider = tier.provider;
  let endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    const base = await loadOpenAiCompatibleBase(admin, provider);
    // Only the legacy bare-id case ("gpt-4o" parsed as openai) may fall back to OpenAI;
    // a named provider without a usable row must fail, not send its key to OpenAI.
    if (!base) throw new Error(`${provider}: provider endpoint not configured`);
    endpoint = { url: `${base}/chat/completions`, keyEnv: "" };
  }
  const key = tier.credentialSource === "user" ? tier.apiKey : await resolvePlatformApiKey(admin, provider);
  if (!key?.trim()) throw new Error("AI tier requires an API key");
  let data;
  let status: number;
  try {
    if (endpoint.kind === "anthropic") {
      const response = await callAnthropicJson(payload, key, timeoutMs);
      data = response.json;
      status = response.status;
    } else {
      const response = await fetchWithTimeout(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, timeoutMs);
      status = response.status;
      const text = await response.text();
      try { data = JSON.parse(text); } catch {
        if (response.ok) throw new Error("Invalid chat completion response");
        data = { error: { message: "Chat completion failed" } };
      }
    }
  } catch (error) {
    throw new Error(redactProviderError(`${provider}/${payload.model}: ${errorMessage(error)}`, key));
  }
  if (status < 200 || status >= 300) throw new ProviderHttpError(
    redactProviderError(typeof data?.error?.message === "string" ? data.error.message : "Chat completion failed", key),
    { status, provider, credentialSource: tier.credentialSource },
  );
  // A 200 is not yet a completion -- see completionFailure. Throwing here is what puts
  // the failure inside the caller's per-model try, so the next model in the chain gets
  // tried and a total outage still reaches the delivery floor.
  const failure = completionFailure(data);
  if (failure) throw new Error(redactProviderError(failure, key));
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
  const { error } = await admin.from("ai_agent_logs").insert({ ...entry, ...dashboardColumns(meta) });
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
    .select("id, user_id, platform, auth_provider, access_token, refresh_token, token_expires_at, platform_user_id, connection_id, workspace_id, ig_auth_type, account_metadata")
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
  const timings = phaseTimings();
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
    const sandboxLimit = await checkUserRateLimit(admin, "ai-agent-reply-sandbox", user.id, 60, 900);
    if (!sandboxLimit.allowed) {
      // Before baseLog exists, like the invalid-key refusal: one row so support can see it.
      const { error: limitLogError } = await admin.from("system_logs").insert(sandboxRateLimitedLog(user.id));
      if (limitLogError) console.error("[ai-agent-reply] Sandbox rate-limit log rejected:", limitLogError.message);
      return rateLimitExceededResponse(sandboxLimit, corsHeaders);
    }
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
    // An optional test_case_key isolates one saved case from the account's
    // shared sandbox thread. Absent, the id is unchanged. Present and invalid
    // is a 400 — a prefix or a free-form string must not select another thread.
    const thread = sandboxConversationId(
      platform,
      sandboxAccountId ?? user.id,
      body.test_case_key,
    );
    if (!thread.ok) {
      // baseLog does not exist yet. One sanitized system_logs row, then the same 400.
      // A failed insert must not change that response, and the raw key must not be logged.
      const { error: refusalLogError } = await admin.from("system_logs").insert(
        invalidTestCaseKeyRefusalLog({
          userId: user.id,
          platform,
          testCaseKey: body.test_case_key,
        }),
      );
      if (refusalLogError) {
        console.error("[ai-agent-reply] Sandbox refusal log rejected:", refusalLogError.message);
      }
      return badRequestResponse(thread.error);
    }
    // Built field by field rather than from the body: comment_id is the one field that makes
    // this function post publicly, and it must never be reachable from a user JWT.
    request = {
      user_id: user.id,
      platform,
      social_account_id: sandboxAccountId ?? "test",
      // Keyed by account so one account's test turns cannot replay as
      // another's; the owner-only key is kept for a caller naming no account.
      conversation_id: thread.conversationId,
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
    social_account_id: UUID_PATTERN.test(request.social_account_id) ? request.social_account_id : null,
    // Here, not from logOutcome's meta: two outcome paths (agent_not_configured, the generic
    // error) pass no dry_run in meta, and the dashboard must exclude every sandbox outcome.
    dry_run: dryRun,
  };
  const outboxId = dryRun ? null : request.outbox_id ?? null;

  // Hoisted so the catch block can report which models were attempted.
  let usedModel: string | null = null;
  let usedFallbackLevel = 0;
  let usedCredentialSource: "user" | "platform" | null = null;
  let fallbackReason: string | undefined;
  const modelErrors: Array<{ model: string; error: string }> = [];
  // Hoisted so the catch block can log which triage outcome (if any) preceded the failure.
  let triage: TriageRun | null = null;

  // Hoisted out of the try below so the model-outage floor in the catch can reach
  // them. A value declared inside the try is invisible to its own catch.
  let replySender: TextSender | null = null;
  let language: ReplyLanguage = "en";
  let escalationTarget: EscalationTarget | null = null;
  let modelChain: AiTier[] = [];
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
    const knowledgeAccountId = await resolveAgentAccountId(
      admin as unknown as AccountScopeAdminClient,
      request,
    );
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

    // The override read and the thread upsert do not use each other's results.
    // A failed override read still throws (resolveConversationOverride), and a
    // failed upsert still throws below — Promise.all, so either abort aborts.
    const [overrideMode, threadResult] = await Promise.all([
      resolveConversationOverride(admin, {
        userId: request.user_id,
        platform: request.platform,
        conversationId: request.conversation_id,
      }, Date.now()),
      admin
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
        .single(),
    ]);
    const mode = resolveEngagementMode(overrideMode, config.default_mode);
    const { data: thread, error: threadError } = threadResult;
    if (threadError) throw threadError;

    const procedureConfig = readProcedureConfig(config.agent_behavior?.procedures);
    // A store-event opener the worker has not confirmed is not a live flow; the turn leaves it alone.
    const proceduresOn = procedureTurnGate(request) && !isPendingOpener(thread.procedure_state) &&
      enabledProcedures(procedureConfig).length > 0;
    const initialProcedureState = proceduresOn ? expireIfStale(thread.procedure_state ?? null, new Date()) : null;
    // The claim port advances this. The final write must expect it, not the value read above:
    // the winner then moves claimed -> null, and the loser's compare-and-set still expects what it read.
    let durableProcedureState: unknown = thread.procedure_state ?? null;

    // Sandbox runs bypass the delivery gates — they test the agent's brain,
    // not the conversation's delivery state. The sender is built only after
    // the gates, so a closed gate still returns without one.
    if (!dryRun) {
      // FB/IG replies happen inside the live webhook turnaround, so the
      // messaging window is open by definition; only WhatsApp needs the
      // stored-history check. Cooldown needs the thread id from the upsert.
      const gateChecks = await evaluateGates({
        withinServiceWindow: () => request.platform === "whatsapp"
          ? isWithinServiceWindow(admin, request.user_id, request.conversation_id)
          : Promise.resolve(true),
        humanAssignedAndOnline: () => isHumanAssignedAndOnline(admin, request.conversation_id),
        cooldownActive: () => isCooldownActive(admin, thread.id, config.reply_cooldown_seconds),
        dailyCapReached: () => isDailyCapReached(admin, request, config.daily_message_cap),
      });
      const gate = shouldAiReply({
        mode,
        ...gateChecks,
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

    // The sandbox passes the literal "test" when a caller names no account, and
    // .eq() against a uuid column with a non-uuid raises 22P02 -- which would
    // kill a reply over a tool list. Anything unusable degrades to the
    // all_accounts corpus instead.
    const scopedAccountId = UUID_PATTERN.test(request.social_account_id)
      ? request.social_account_id
      : null;

    let cachedConversationQuery = admin
      .from("messaging_cache")
      .select("id, workspace_id, participant_name")
      .eq("user_id", request.user_id)
      .eq("platform", request.platform)
      .eq("conversation_id", request.conversation_id);
    if (scopedAccountId) {
      cachedConversationQuery = cachedConversationQuery.eq("social_account_id", request.social_account_id);
    }

    // These five reads do not use each other's results. Promise.all, not
    // allSettled: a read that threw before still throws and the reply fails
    // the same way. The link read is the exception that already returned an
    // error instead of throwing; that handling stays after the group.
    const [
      historyResult,
      embeddingConfig,
      cachedConversationResult,
      customToolResult,
      linkResult,
    ] = await Promise.all([
      admin
        .from("ai_thread_messages")
        .select("role, content")
        .eq("thread_id", thread.id)
        .in("role", ["user", "assistant"])
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT),
      resolveDualEmbeddingConfigFromDb(admin),
      cachedConversationQuery.maybeSingle(),
      admin
        .from("ai_agent_tools")
        // `settings` is read only to tell the model which tables this connector
        // may reach; it holds no secret (credentials live in Vault).
        // `auth_strategy`/`connection_id` decide whether the tool is Composio-
        // backed, whose connection attachComposioTools resolves below.
        .select("id, name, description, url, secret, admin_only, scope, social_account_id, connector_type, read_only_mode, settings, auth_strategy, connection_id")
        .eq("user_id", request.user_id)
        .eq("is_enabled", true),
      scopedAccountId
        ? admin
          .from("ai_agent_tool_accounts")
          .select("tool_id, social_account_id")
          .eq("user_id", request.user_id)
          .eq("social_account_id", scopedAccountId)
        : Promise.resolve({ data: null, error: null }),
    ]);

    const { data: historyRows } = historyResult;
    const history = (historyRows || []).reverse().map((row: { role: string; content: string | null }) => ({
      role: row.role,
      content: row.content || "",
    }));

    let toolLinks: ToolAccountLink[] = [];
    let toolLinksDegraded = false;
    if (scopedAccountId) {
      // Scoped by user_id as well as account: this runs under the service role,
      // so RLS is not evaluated and tenancy has to be structural (ARCHITECTURE
      // §24). Without it another tenant's link row would grant access here.
      const { data: linkRows, error: linkError } = linkResult;
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

    const { data: cachedConversation, error: cachedConversationError } = cachedConversationResult;
    if (cachedConversationError) throw cachedConversationError;
    const { data: customToolRows } = customToolResult;

    // Retrieval uses the primary embedding provider and fails over to the
    // configured fallback provider's vector column when the primary is down. If
    // both are unavailable, degrade to replying without knowledge and record the
    // RAG failure in the logs rather than silencing the agent.
    let relevantChunks: Array<{ id: string; content: string; similarity: number }> = [];
    let retrievedChunkIds: string[] = [];
    let relatedFacts = "";
    let ragError: string | null = null;
    let graphError: string | null = null;
    const retrieveKnowledgeContext = async () => {
      let relevantChunks: Array<{ id: string; content: string; similarity: number }> = [];
      let ragError: string | null = null;
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
      return { relevantChunks, retrievedChunkIds, relatedFacts, ragError, graphError };
    };
    // Started here, right where the inline retrieval used to run -- before tool
    // resolution, Composio lookups, and everything else below -- so both overlap with
    // that work instead of adding their own serial round trip. Neither is awaited until
    // the triage point further down; retrieveKnowledgeContext catches its own errors, so
    // starting it unawaited is safe, and the triage settings read is forced to start
    // immediately by chaining .then() rather than left as an un-awaited query builder,
    // which would not send its request until awaited.
    const knowledgePromise = retrieveKnowledgeContext();
    const triageRowsPromise = admin
      .from("system_settings")
      .select("key, value")
      .in("key", TRIAGE_SETTING_KEYS)
      .then((res) => res);

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

    const toolContext: ToolContext = {
      admin,
      userId: request.user_id,
      platform: request.platform,
      conversationId: request.conversation_id,
      cachedConversation,
      customerName: cachedConversation?.participant_name || request.recipient_phone,
      adminPhoneNumbers: config.admin_phone_numbers || [],
      dryRun,
      // The sandbox's "test" sentinel is not a uuid; connector telemetry then
      // falls back to the owner's personal workspace (spec §4.3).
      socialAccountId: UUID_PATTERN.test(request.social_account_id) ? request.social_account_id : null,
      // One id per reply, so every connector row this reply writes can be
      // joined back to it; nothing upstream hands us a correlation id.
      requestId: crypto.randomUUID(),
      isAdmin,
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
      // The escalation's first write is bounded by these; under human_then_ai it
      // does not mute unless a human is actually assigned.
      defaultMode: config.default_mode ?? null,
      escalationTimeoutMinutes: config.escalation_timeout_minutes ?? null,
    };
    escalationTarget = toolContext;

    // User-defined connector tools, narrowed to THIS account.
    //
    // Loading by user_id alone -- which is what this did until PR-5 -- offered
    // every tool the login owned to every account's agent, so one Facebook
    // page answered customers out of another page's store. Migration A scoped
    // the table; this query and resolveToolsForAccount are what make that
    // scoping real.
    // admin_only is passed IN rather than filtered out afterwards: narrowing
    // after collision resolution let an admin-only tool win a name and then be
    // removed, leaving a customer with neither connector (Codex P2).
    const toolResolution = resolveToolsForAccount(
      (customToolRows || []) as ResolvableTool[],
      toolLinks,
      scopedAccountId,
      { includeAdminOnly: isAdmin },
    );

    // Spec §7.1: Composio tools are only offerable when their connection is
    // active, in the conversation account's workspace, and schema-cached. The
    // workspace is read here (one select by id AND user_id — the structural
    // tenancy check under the service role) rather than inside
    // attachComposioTools so the lookup happens once per reply, and only when
    // this account actually resolved a Composio tool.
    const hasComposioTools = toolResolution.tools.some(
      (tool: ResolvableTool) => tool.auth_strategy === "composio_oauth",
    );
    let accountWorkspaceId: string | null = null;
    if (hasComposioTools && scopedAccountId) {
      const { data: accountRow, error: accountError } = await admin
        .from("social_accounts")
        .select("workspace_id")
        .eq("id", scopedAccountId)
        .eq("user_id", request.user_id)
        .maybeSingle();
      if (accountError) {
        // Said, not swallowed: a failed read must not look like "no
        // workspace". attachComposioTools then omits the Composio tools.
        console.error(
          "[ai-agent-reply] account workspace read failed:",
          accountError.message,
        );
      } else {
        accountWorkspaceId = accountRow?.workspace_id ?? null;
      }
    }
    const customTools: CustomTool[] = hasComposioTools
      ? await attachComposioTools(admin, toolResolution.tools, {
        workspaceId: accountWorkspaceId,
        id: scopedAccountId,
      })
      : toolResolution.tools;
    const customToolByName = new Map(customTools.map((tool) => [tool.name, tool]));

    const storeTool = (capability: "lookup_orders" | "search_products") => procedureStoreTool(customTools, capability);
    const wooById = (connectorId: string) =>
      customTools.find((tool) => tool.id === connectorId && tool.connector_type === "woocommerce") ?? null;
    const readStorePayload = (found: ToolResult): Record<string, unknown> => {
      if (connectorCallFailed(found)) {
        if (found.output.includes("[store_write_denied]") || found.output.includes("[read_only_violation]")) {
          return { error: "store_write_denied" };
        }
        throw new Error("store_lookup_failed");
      }
      const marker = "returned: ";
      const at = found.output.indexOf(marker);
      if (at < 0) throw new Error("store_lookup_failed");
      const parsed = JSON.parse(found.output.slice(at + marker.length));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("store_lookup_failed");
      return parsed as Record<string, unknown>;
    };
    const procedureTurn = proceduresOn ? createProcedureTurn({
      state: initialProcedureState, config: procedureConfig, dryRun, now: () => new Date(),
      runId: outboxId ?? crypto.randomUUID(),
      userId: request.user_id,
      customerPhone: request.recipient_phone,
      leadContext: { platform: request.platform, socialAccountId: toolContext.socialAccountId, conversationId: request.conversation_id },
      ports: {
        claim: async (claimed) => {
          const won = await persistProcedureState(admin, thread.id, durableProcedureState, claimed);
          if (won) durableProcedureState = claimed;
          return won;
        },
        saveLead: async (row) => {
          const { data, error } = await admin.from("leads").upsert(
            { user_id: request.user_id, form_id: null, status: "new", ...row },
            { onConflict: "meta_lead_id", ignoreDuplicates: true },
          ).select("id");
          if (error) throw new Error(error.message);
          return (data ?? []).length > 0;
        },
        notifyAdmin: (message) => notifyAdmins(toolContext, message),
        escalate: (reason, summary) => executeTool(toolContext, "escalate_to_human", { reason, summary }),
        hasStoreCapability: (capability) => storeTool(capability) !== null,
        storeLookup: async (capability, parameters) => {
          const tool = storeTool(capability);
          if (!tool) return null;
          const found = await executeRoutedCustomTool(toolContext, tool, { capability, parameters }, {}, modelBudgetRemaining(startedAt, Date.now()));
          // Connector failures come back as text, not exceptions; the flow must keep its
          // final step for a retry instead of completing on an error (debate verdict 3).
          if (connectorCallFailed(found)) throw new Error("store_lookup_failed");
          return found;
        },
        logFailure: async (message, metadata) => {
          const { error } = await admin.from("system_logs").insert({
            source: "ai-agent-reply", category: "ai", level: "warn", message, user_id: request.user_id,
            metadata: { platform: request.platform, ...metadata },
          });
          if (error) console.error("[ai-agent-reply] Procedure failure log rejected:", error.message);
        },
        eventFor: async (runId) => {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return null;
          const { data, error } = await admin.from("store_events")
            .select("id, user_id, social_account_id, connector_id, flow, payload")
            .eq("id", runId)
            .maybeSingle();
          if (error) throw new Error("store_event_read_failed");
          if (!data || typeof data.user_id !== "string" || typeof data.social_account_id !== "string" || typeof data.connector_id !== "string" || typeof data.flow !== "string") {
            return null;
          }
          const payload: Record<string, string> = {};
          if (data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)) {
            for (const [key, value] of Object.entries(data.payload as Record<string, unknown>)) {
              if (typeof value === "string") payload[key] = value;
              else if (typeof value === "number" && Number.isFinite(value)) payload[key] = String(value);
            }
          }
          return {
            id: String(data.id), user_id: data.user_id, social_account_id: data.social_account_id,
            connector_id: data.connector_id, flow: data.flow, payload,
          };
        },
        updateOrder: async (order) => {
          const tool = wooById(order.connectorId);
          if (!tool) return { error: "missing" as const };
          const found = await executeProcedureStoreCall(toolContext, tool, {
            capability: "update_order",
            method: "POST",
            parameters: {
              order_id: order.orderId,
              note: order.note,
              expected_statuses: order.expectedStatuses,
              ...(order.status ? { status: order.status } : {}),
            },
          }, modelBudgetRemaining(startedAt, Date.now()));
          const data = readStorePayload(found);
          if (data.error === "store_write_denied") return { error: "store_write_denied" as const };
          if (data.changed === true && typeof data.status === "string") return { changed: true as const, status: data.status };
          if (data.changed === false && typeof data.status === "string") return { changed: false as const, status: data.status };
          throw new Error("store_lookup_failed");
        },
        getProduct: async (product) => {
          const tool = wooById(product.connectorId);
          if (!tool) return { ok: false as const };
          const found = await executeProcedureStoreCall(toolContext, tool, {
            capability: "get_product",
            method: "GET",
            parameters: {
              product_id: product.productId,
              ...(product.parentId ? { parent_id: product.parentId } : {}),
            },
          }, modelBudgetRemaining(startedAt, Date.now()));
          const data = readStorePayload(found);
          if (data.error === "store_write_denied") return { ok: false as const };
          return {
            ok: true as const,
            name: typeof data.name === "string" ? data.name : "",
            price: typeof data.price === "number" || typeof data.price === "string" ? String(data.price) : "",
            permalink: typeof data.permalink === "string" ? data.permalink : "",
          };
        },
      },
    }) : null;

    // Both off removes escalate_to_human entirely; one off narrows its
    // description to the trigger that is still allowed. Passing a single boolean
    // here was not enough -- the stock description names BOTH reasons, so
    // turning one switch off changed nothing the model could act on.
    const handoff = {
      onRequest: config.handoff_on_request ?? true,
      onLowConfidence: config.handoff_on_low_confidence ?? true,
    };

    timings.mark("setup");
    const { data: triageRows } = await triageRowsPromise;
    const triageChain = triageChainFromSettings(triageRows ?? []);
    if (triageChain.length) {
      triage = await runTriage(triageChain, {
        message: request.inbound_text.slice(0, MAX_INBOUND_CHARS),
        history,
        connectors: customTools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
        // Only onRequest, not onLowConfidence: triage can judge whether the customer
        // explicitly asked for a human, but "the model has low confidence in its own
        // answer" is not something a fast, separate decision call can see -- only the
        // chat model can know that once it has tried to answer.
        askHandoff: handoff.onRequest,
      }, (code) => resolveProviderKey(admin as unknown as RowReader, code));
    }
    timings.mark("triage");
    const triagePlan = triage?.outcome?.plan ?? null;
    if (procedureTurn && triagePlan?.handoff) procedureTurn.endForHandoff();
    const jevKey = procedureTurn ? jevStartKey(triage?.outcome?.answers.intent ?? null, procedureTurn.state !== null) : null;
    if (jevKey) procedureTurn!.start(jevKey, "jev");
    const procedureActive = procedureTurn?.state != null;
    if (triagePlan?.skipKnowledge) {
      knowledgePromise.catch(() => {}); // not awaited; keep a late rejection from being unhandled
    } else {
      ({ relevantChunks, retrievedChunkIds, relatedFacts, ragError, graphError } = await knowledgePromise);
    }
    timings.mark("knowledge");
    const offeredTools = (triagePlan?.smalltalk && !procedureActive) || triagePlan?.handoff ? [] : selectConnectorTools(customTools, triagePlan);

    // Built HERE, not where the knowledge was gathered, because the prompt now
    // has to name the connectors this account actually resolved. A rule that
    // merely alludes to "a connector" loses to a persona holding a ready
    // answer -- a configured Supabase price table went unqueried that way
    // (2026-09-01). systemPrompt is read once, at the messages array below.
    const systemPrompt = buildSystemPrompt({
      persona: config.persona_instructions,
      behavior: config.agent_behavior,
      handoffOnRequest: config.handoff_on_request,
      handoffOnLowConfidence: config.handoff_on_low_confidence,
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
      connectorNames: offeredTools.map((tool) => tool.name),
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
    const hint = triageSystemHint(triagePlan);
    if (hint) messages.splice(1, 0, { role: "system", content: hint });
    if (procedureTurn?.state) {
      const fields = fieldsFor(procedureTurn.state.key, procedureConfig);
      messages.splice(1, 0, { role: "system", content:
        procedurePromptBlock(procedureTurn.state, stepGuidance(procedureTurn.state, procedureConfig), fields.length) });
    }
    let promptTokens = 0;
    let completionTokens = 0;
    let replyText = "";

    const maxIterations = Math.max(1, config.max_tool_iterations || 5);
    // Primary + fallback chain, each entry resolved to its provider endpoint.
    // Global as of 2026-08-27: config.model, config.fallback_model_1 and
    // config.fallback_model_2 are deprecated, still in the database but no longer
    // read. Scheduled for removal after a verification window -- see
    // docs/superpowers/specs/2026-08-27-agent-model-selection-design.md §3e.
    const routingAdmin = admin as unknown as AiRoutingAdmin;
    const route = await resolveUserAiRoute(routingAdmin, request.user_id, 'agent');
    if (route.mode === 'user_only' && !route.userTier) {
      await logOutcome(admin, { ...baseLog, status: 'skipped', error: AI_CONNECTION_REQUIRED,
        latency_ms: Date.now() - startedAt }, { error_code: AI_CONNECTION_REQUIRED, dry_run: dryRun });
      if (outboxId) await cancelOutboxRow(admin, outboxId, AI_CONNECTION_REQUIRED);
      return jsonResponse({ ok: true, skipped: 'no_reply_generated', error: AI_CONNECTION_REQUIRED });
    }
    const rawChain = route.mode === 'user_only' ? [] : await loadGlobalModelChain(admin);
    modelChain = composeAiTiers(route, rawChain.map((ref) => ({ ...parseModelRef(ref), credentialSource: 'platform' })));
    if (route.reason === 'user_key_missing') fallbackReason = route.reason;
    if (!modelChain.length) {
      // No hardcoded last resort. Calling a model no admin selected is how an
      // unlisted gpt-4o-mini kept answering; a human is the better fallback.
      throw new ModelChainExhaustedError("No global AI agent model is configured");
    }
    const toolDefinitions = triagePlan?.smalltalk && !procedureActive ? [] : [
      ...agentToolDefinitions(handoff),
      ...(isAdmin ? adminToolDefinitions : []),
      ...customToolDefinitions(offeredTools),
      ...procedureToolDefinitions(procedureTurn && !triagePlan?.handoff ? enabledProcedures(procedureConfig) : []),
    ];
    // Rebuilt each round: the tool appears only after this turn's check_stock saw the product out of stock.
    const waitlistOn = procedureConfig.back_in_stock?.enabled === true && request.platform === "whatsapp";
    const stockSightings: StockSighting[] = [];
    const joinStockWaitlist = async (productId: string): Promise<ToolResult> => {
      const plan = planWaitlistJoin({
        productId,
        sightings: stockSightings,
        platform: request.platform,
        phone: request.recipient_phone,
        dryRun,
        userId: request.user_id,
        socialAccountId: toolContext.socialAccountId,
        conversationId: request.conversation_id,
        now: new Date().toISOString(),
      });
      if (plan.action === "upsert") {
        const { error } = await admin.from("stock_waitlist").upsert(
          plan.row,
          { onConflict: "connector_id,phone,product_id" },
        );
        if (error) {
          console.error("[ai-agent-reply] waitlist join failed:", error.message);
          return { output: "The waitlist could not be saved. Tell the customer the team will follow up." };
        }
      }
      return { output: plan.output };
    };
    let procedureToolRanThisRound = false;
    for (let iteration = 0; ; iteration++) {
      const procedureToolRanOnLastRound = procedureToolRanThisRound;
      procedureToolRanThisRound = false;
      const budget = iterationBudget(maxIterations, procedureToolRanOnLastRound, iteration);
      if (budget === "stop") break;
      const waitlistTool = waitlistOn ? stockWaitlistToolDefinition(stockSightings) : null;
      const roundToolDefinitions = budget === "text_only" ? [] : [
        ...toolDefinitions,
        ...(waitlistTool ? [waitlistTool] : []),
      ];
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
          completion = await timings.span("model_round", () => chatCompletion(modelChain[mi], {
            model: modelChain[mi].model,
            temperature: config.temperature ?? 0.4,
            messages,
            ...(roundToolDefinitions.length ? { tools: roundToolDefinitions, tool_choice: "auto" } : {}),
          }, Math.min(CHAT_TIMEOUT_MS, budgetMs), routingAdmin));
          usedModel = formatModelRef(modelChain[mi]);
          usedFallbackLevel = mi;
          usedCredentialSource = modelChain[mi].credentialSource;
          break;
        } catch (err) {
          await invalidateRejectedUserTier(routingAdmin, request.user_id, route, err);
          if (modelChain[mi].credentialSource === 'user') fallbackReason = `user_tier_failed:${err instanceof ProviderHttpError ? err.status : 0}`;
          lastError = err;
          modelErrors.push({ model: formatModelRef(modelChain[mi]), error: errorMessage(err) });
        }
      }
      if (!completion) {
        // A user_only chain rejected by its own provider is a credential error,
        // not a model outage: the key has just been invalidated, the next
        // request is skipped as AI_CONNECTION_REQUIRED, and running the outage
        // floor here would apologise or escalate for a problem only the user
        // can fix. Mirrors the 409 the caption path returns.
        if (
          route.mode === 'user_only' && lastError instanceof ProviderHttpError &&
          lastError.credentialSource === 'user' && [401, 403].includes(lastError.status)
        ) {
          await logOutcome(admin, { ...baseLog, status: 'skipped', error: AI_USER_KEY_INVALID,
            latency_ms: Date.now() - startedAt }, { error_code: AI_USER_KEY_INVALID, dry_run: dryRun,
            model_errors: modelErrors });
          if (outboxId) await cancelOutboxRow(admin, outboxId, AI_USER_KEY_INVALID);
          return jsonResponse({ ok: true, skipped: 'no_reply_generated', error: AI_USER_KEY_INVALID });
        }
        // Typed so the catch can tell a total model outage apart from the
        // database, send, and validation errors that share it. Per-model detail
        // is already in modelErrors.
        throw new ModelChainExhaustedError(
          lastError instanceof Error ? lastError.message : "All AI models failed",
        );
      }
      promptTokens += completion.usage?.prompt_tokens || 0;
      completionTokens += completion.usage?.completion_tokens || 0;
      timings.note("prompt_tokens_per_round", completion.usage?.prompt_tokens ?? 0);
      timings.note("completion_tokens_per_round", completion.usage?.completion_tokens ?? 0);
      // chatCompletion rejects any body that lacks one, so this cannot be undefined.
      const choice = completion.choices[0].message;

      if (!choice.tool_calls?.length) {
        // Repaired here, at the single place a reply is born, so the fix
        // covers the send, the stored transcript and the sandbox alike.
        // Links AND markdown: the model has ignored the no-markdown prompt
        // rule on a live reply (11:10 UTC), so rendering safety cannot
        // depend on it complying.
        replyText = repairChatReply((choice.content || "").trim());
        break;
      }

      messages.push(choice);
      // One per-call body shared by the serial and the parallel path, so their
      // bookkeeping (executed calls, side-effect flags, escalation, chunks) can
      // never drift apart.
      const runToolCall = async (
        toolCall: { id: string; function: { name: string; arguments?: string } },
      ): Promise<{ role: "tool"; tool_call_id: string; content: string }> => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          // leave args empty; the executor handles missing fields
        }
        executedToolCalls.push({ name: toolCall.function.name, arguments: args });
        sideEffectsHappened = true;
        const customTool = customToolByName.get(toolCall.function.name);
        const isProcedureTool = procedureTurn !== null && PROCEDURE_TOOL_NAMES.has(toolCall.function.name);
        if (isProcedureTool) procedureToolRanThisRound = true;
        const result: ToolResult = await timings.span(`tool:${toolCall.function.name}`, async () =>
          toolCall.function.name === "stock_waitlist_join"
            ? await joinStockWaitlist(String(args.product_id ?? ""))
            : isProcedureTool
            ? await procedureTurn!.handle(toolCall.function.name, args)
            : customTool
            ? await executeRoutedCustomTool(
              toolContext,
              customTool,
              args,
              {},
              // The model budget is elapsed, not a per-call allowance, so a tool
              // call late in the conversation must shrink to what is left.
              modelBudgetRemaining(startedAt, Date.now()),
            )
            : (isAdmin ? await executeAdminTool(toolContext, toolCall.function.name, args) : null) ??
              (await executeTool(toolContext, toolCall.function.name, args)));
        if (customTool && args.capability === "check_stock") {
          stockSightings.push(...stockSightingsFromToolOutput(customTool.id, result.output));
        }
        if (result.escalated) {
          escalated = true;
          if (result.humanNotified) escalationNotifiedHuman = true;
          procedureTurn?.endForHandoff();
        }
        if (result.retrievedChunkIds) retrievedChunkIds.push(...result.retrievedChunkIds);
        return { role: "tool", tool_call_id: toolCall.id, content: result.output };
      };
      if (parallelizable(choice.tool_calls, customToolByName)) {
        // Every call in the round is a read-only connector call, so they cannot
        // race a write; results are pushed in the model's original tool_calls
        // order whatever order they finish in.
        const toolMessages: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];
        for (let start = 0; start < choice.tool_calls.length; start += PARALLEL_TOOLS_PER_CHUNK) {
          const chunk = choice.tool_calls.slice(start, start + PARALLEL_TOOLS_PER_CHUNK);
          toolMessages.push(...(await Promise.all(chunk.map(runToolCall))));
        }
        messages.push(...toolMessages);
      } else {
        for (const toolCall of choice.tool_calls) {
          messages.push(await runToolCall(toolCall));
        }
      }
    }

    // Fire-and-forget audit trail for AI agent calls (admin-visible logs).
    try {
      const { error: auditError } = await admin.from("admin_audit_log").insert({
        admin_id: request.user_id,
        action: "ai_agent_reply",
        resource_type: "ai_agent",
        resource_id: request.conversation_id,
        details: {
          platform: request.platform,
          used_model: usedModel,
          credential_source: usedCredentialSource,
          fallback_reason: fallbackReason,
          fallback_level: usedFallbackLevel,
          model_chain: modelChain.map(formatModelRef),
          model_errors: modelErrors.length ? modelErrors : null,
          tool_calls: executedToolCalls.map((t) => t.name),
          escalated,
          dry_run: dryRun,
        },
      });
      if (auditError) throw new Error("AI audit log write failed");
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
        credential_source: usedCredentialSource,
        fallback_reason: fallbackReason,
        fallback_level: usedFallbackLevel,
        model_errors: modelErrors.length ? modelErrors : null,
        rag_error: ragError,
        graph_error: graphError,
        dry_run: dryRun,
        timings: timings.toJSON(),
        triage: triage ? { outcome: triage.outcome, errors: triage.errors.length ? triage.errors : null } : null,
      });
      if (outboxId) await cancelOutboxRow(admin, outboxId, "no_reply_generated");
      return jsonResponse({ ok: true, skipped: "no_reply_generated" });
    }

    const procedureStateToWrite = procedureStateAfterTurn({
      hadTurn: procedureTurn !== null, storedState: durableProcedureState,
      initialState: initialProcedureState, turnState: procedureTurn?.state ?? null,
      progressed: procedureTurn?.progressed ?? false, escalated, now: new Date(),
    });
    if (
      procedureTurn?.claimConflict ||
      (procedureStateToWrite !== undefined &&
        !(await persistProcedureState(admin, thread.id, durableProcedureState, procedureStateToWrite)))
    ) {
      // The reply claims a transition durable state does not hold (a concurrent turn won,
      // or the write failed). Sending it would re-ask answered questions next turn.
      await logOutcome(admin, { ...baseLog, status: "skipped", error: PROCEDURE_STATE_CONFLICT,
        latency_ms: Date.now() - startedAt }, { error_code: PROCEDURE_STATE_CONFLICT, dry_run: dryRun });
      if (outboxId) await cancelOutboxRow(admin, outboxId, PROCEDURE_STATE_CONFLICT);
      return jsonResponse({ ok: true, skipped: "no_reply_generated", error: PROCEDURE_STATE_CONFLICT });
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
    timings.mark("sent");
    // Customer-perceived: request start to the send completing (marks are per-phase deltas).
    timings.note("sent_total", Date.now() - startedAt);

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
      credential_source: usedCredentialSource,
      fallback_reason: fallbackReason,
      fallback_level: usedFallbackLevel,
      model_errors: modelErrors.length ? modelErrors : null,
        rag_error: ragError,
        graph_error: graphError,
      tool_calls: executedToolCalls.length ? executedToolCalls.map((t) => t.name) : null,
      // What the model was actually OFFERED, next to what it chose to call.
      // Without this, "the connector did not answer" needed a hand-run of
      // resolveToolsForAccount against live rows to tell "not offered" from
      // "offered and declined" -- two very different bugs that look identical
      // in this log. Names only; nothing here is a secret.
      connectors_offered: offeredTools.length ? offeredTools.map((tool) => tool.name) : null,
      escalated,
      dry_run: dryRun,
      intent: triage?.outcome?.answers.intent ?? null,
      triage: triage ? { outcome: triage.outcome, errors: triage.errors.length ? triage.errors : null } : null,
      timings: timings.toJSON(),
    });

    // Intent labels are advisory: applied only after a fresh delivery on
    // WhatsApp, and a failure here never changes or delays what the customer
    // already received. The redelivery branch above returned before this point.
    if (shouldLabel({ platform: request.platform, dryRun, freshDelivery: true })) {
      const label = intentLabelFor(triage?.outcome?.answers ?? null);
      if (label) {
        try {
          // The writer bounds this advisory operation to 2 s; its timer is always cleared.
          // The generated client type is too deep for a structural check; it satisfies LabelDb at runtime.
          await applyIntentLabel(admin as unknown as LabelDb, request.user_id, request.conversation_id, label);
        } catch (labelError) {
          console.warn(
            "[ai-agent-reply] intent label failed:",
            labelError instanceof Error ? labelError.name : "error",
          );
        }
      }
    }

    // Added fields only. Webhook and service-role callers ignore what they
    // do not read. intent is omitted unless triage cleared TRIAGE_CONFIDENCE;
    // intent_status says off, uncertain, or classified. Triage is not switched
    // on for a sandbox run. used_model is the chain slot that wrote the reply,
    // so a saved test run can snapshot it.
    return jsonResponse({
      ok: true,
      reply: replyText,
      escalated,
      tool_calls: executedToolCalls,
      is_admin: isAdmin,
      used_model: usedModel,
      ...replyIntentFields(triage),
      procedure: procedureTurn?.completed
        ? { key: procedureTurn.completed, step: -1, completed: true }
        : procedureTurn?.state ? { key: procedureTurn.state.key, step: procedureTurn.state.step, completed: false } : null,
    });
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
        credential_source: usedCredentialSource,
        fallback_reason: fallbackReason,
        fallback_level: usedFallbackLevel,
        model_errors: modelErrors.length ? modelErrors : null,
        model_chain: modelChain.map(formatModelRef),
        triage: triage ? { outcome: triage.outcome, errors: triage.errors.length ? triage.errors : null } : null,
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
      credential_source: usedCredentialSource,
      fallback_reason: fallbackReason,
      fallback_level: usedFallbackLevel,
      model_errors: modelErrors.length ? modelErrors : null,
      triage: triage ? { outcome: triage.outcome, errors: triage.errors.length ? triage.errors : null } : null,
    });
    if (outboxId) await releaseAfterError(admin, outboxId, { sideEffectsHappened, error: errorMessage(error) });
    return jsonResponse({ ok: false, error: errorMessage(error) });
  }
});
