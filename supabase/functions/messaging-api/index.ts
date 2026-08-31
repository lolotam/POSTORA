import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isDirectInstagramAccount, getPageTokenForMessaging, getSendCredentials } from "../_shared/messengerCredentials.ts";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { WhatsAppAccessError, type WhatsAppAccountAccess, type WhatsAppWorkspaceAccessClient } from "../_shared/whatsappWorkspaceAccess.ts";
import { withWhatsAppActionAccess } from "./whatsappAccess.ts";
import {
  parseNamedAccountId,
  resolveConfigWriteAccount,
  resolveOwnedAccountId,
  writeAccountScopedConfig,
} from "./aiConfigScope.ts";
import { toWhatsAppMessageView } from "../_shared/whatsappMessageView.ts";
import { loadAgentConfigForAccount } from "../_shared/agentConfigLookup.ts";
import { blankedFields } from "./configBlanking.ts";
import { parseCredentialUpsertResult } from "./credentialVaultRpc.ts";
import {
  type CredentialVault,
  deleteAccountScopedTool,
  listToolsForUser,
  parseUpsertToolInput,
  type ToolAdminClient,
  ToolWriteError,
  upsertAccountScopedTool,
} from "./toolWrites.ts";
import {
  parseSetToolAccountsInput,
  type SharingAdminClient,
  setToolAccounts,
  ToolSharingError,
} from "./toolSharing.ts";
import {
  MEDIA_UNDERSTANDING_MODES,
  resolveMediaUnderstandingMode,
} from "../_shared/mediaUnderstandingMode.ts";
import {
  conversationIdsForFilter,
  keysetOrFilter,
  MalformedMessageCursorError,
  pageFetchLimit,
  parseWhatsAppMessagePageRequest,
  sliceWhatsAppMessagePage,
} from "../_shared/whatsappMessagePage.ts";
import {
  MAX_MEDIA_ROWS,
  OUTBOUND_SIGN_TTL_SECONDS,
  ownedStoragePath,
  resolveWhatsAppMedia,
  signMediaPath,
} from "../_shared/whatsappMediaResolver.ts";
import { sendTemplate } from "../_shared/whatsappPartnerOps.ts";
import { resolveWhatsAppTransport } from "../_shared/whatsappTransport.ts";
import {
  getWhatsAppConversationState,
  setWhatsAppMessageFlag,
} from "../_shared/whatsappConversationState.ts";
import {
  revokeWhatsAppMessage,
  WhatsAppRevokeError,
} from "../_shared/whatsappRevoke.ts";
import {
  sendWhatsAppVoice,
  WhatsAppVoiceSendError,
} from "../_shared/whatsappVoiceSend.ts";
import {
  COMMENT_AUTOMATION_HANDLERS,
  MESSAGE_AUTOMATION_HANDLERS,
  resolveAutomationHandler,
  resolveCommentAutomationHandler,
} from "../_shared/automationHandler.ts";

// Meta's participant profile_pic URLs expire after a few days; re-fetch/re-cache
// before that window closes rather than serving a dead link from messaging_cache.
const AVATAR_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_VERSION = "v22.0";
const GRAPH_API = `https://graph.facebook.com/${GRAPH_VERSION}`;
const INSTAGRAM_GRAPH_API = `https://graph.instagram.com/${GRAPH_VERSION}`;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gracefulError(message: string, errorType: string) {
  return jsonResponse({ error: message, error_type: errorType });
}

/**
 * Upserts messaging_cache + whatsapp_contacts after a successful outbound WhatsApp send.
 * Makes the conversation appear in the inbox immediately and auto-saves the contact.
 */
async function upsertOutboundConversation(
  adminClient: any,
  params: {
    user_id: string;
    social_account_id: string;
    phone_number_id: string;
    recipient_phone: string;
    preview: string;
    workspace_id: string;
  }
) {
  const normalizedPhone = params.recipient_phone.replace(/\D/g, "");
  const conversationId = `wa_${params.phone_number_id}_${normalizedPhone}`;
  const nowIso = new Date().toISOString();

  // Look up existing contact display name (if any)
  const { data: existingContact } = await (adminClient as any)
    .from("whatsapp_contacts")
    .select("display_name")
    .eq("workspace_id", params.workspace_id)
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  const participantName = existingContact?.display_name || `+${normalizedPhone}`;

  // Auto-save contact (no-op on conflict)
  await (adminClient as any).from("whatsapp_contacts").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      phone_number: normalizedPhone,
      display_name: existingContact?.display_name || `+${normalizedPhone}`,
      last_message_at: nowIso,
    },
    { onConflict: "user_id,phone_number", ignoreDuplicates: false }
  );

  // Upsert messaging_cache so conversation appears in the inbox
  await (adminClient as any).from("messaging_cache").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      social_account_id: params.social_account_id,
      platform: "whatsapp",
      conversation_id: conversationId,
      participant_name: participantName,
      last_message_preview: params.preview.slice(0, 200),
      last_message_at: nowIso,
      unread_count: 0,
      updated_at: nowIso,
    },
    { onConflict: "user_id,conversation_id" }
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    // Use anon client with the user's token for auth validation
    const anonClient = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    
    // Try getClaims first (faster), fall back to getUser
    let userId: string;
    const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
    if (!claimsError && claimsData?.claims?.sub) {
      userId = claimsData.claims.sub;
    } else {
      const { data: { user: authUser }, error: authError } = await anonClient.auth.getUser(token);
      if (authError || !authUser) return jsonResponse({ error: "Unauthorized" }, 401);
      userId = authUser.id;
    }
    
    // Create a virtual user object for backward compatibility
    const user = { id: userId };

    const adminClient = createClient(supabaseUrl, supabaseKey);
    const whatsappAccessClient = adminClient as unknown as WhatsAppWorkspaceAccessClient;
    const body = await req.json();
    const { action } = body;

    // Helper: get access token for a social account
    async function getAccountToken(socialAccountId: string) {
      const { data, error } = await adminClient
        .from("social_accounts")
        .select("id, user_id, access_token, platform_user_id, platform_username, platform, ig_auth_type, account_metadata, connection_mode")
        .eq("id", socialAccountId)
        .eq("user_id", user!.id)
        .single();
      if (error || !data) throw new Error("Account not found or access denied");
      return data;
    }

    // Helper: call Graph API with graceful error handling
    async function graphFetch(url: string, options?: RequestInit): Promise<any> {
      const res = await fetch(url, options);
      if (!res.ok) {
        const errText = await res.text();
        console.error("Graph API error:", res.status, errText);
        
        let parsed: any = {};
        try { parsed = JSON.parse(errText); } catch {}
        
        const fbError = parsed?.error;
        if (fbError?.code === 190) {
          throw new Error("TOKEN_EXPIRED: Your access token has expired. Please reconnect your Facebook/Instagram account in Settings → Profiles.");
        }
        if (fbError?.code === 10 || fbError?.code === 200) {
          throw new Error(`PERMISSION_ERROR: ${fbError.message || "Missing required permission for messaging."}`);
        }
        
        throw new Error(`GRAPH_ERROR: ${fbError?.message || errText}`);
      }
      return await res.json();
    }

    async function listDirectInstagramConversations(account: any): Promise<any> {
      const fields = "participants{username,id,name,profile_pic},messages.limit(1){message,created_time,from},unread_count,updated_time";
      const url = `${INSTAGRAM_GRAPH_API}/${account.platform_user_id}/conversations?platform=instagram&fields=${encodeURIComponent(fields)}&limit=50&access_token=${encodeURIComponent(account.access_token)}`;
      try {
        return await graphFetch(url);
      } catch (err) {
        const msg = (err as Error).message || "";
        if (/PERMISSION_ERROR/i.test(msg)) {
          return {
            data: [],
            error: "Missing instagram_business_manage_messages permission. Please reconnect your Instagram account.",
            error_type: "MISSING_SCOPE",
            missing_scope: "instagram_business_manage_messages",
          };
        }
        throw err;
      }
    }

    // Helper: fetch a conversation participant's profile (name + avatar) from Meta.
    // Direct-login Instagram accounts must be queried via graph.instagram.com with the
    // IG user's own token; Facebook Pages and business-login IG go through graph.facebook.com
    // with the page token. Never throws: a missing/blocked profile just yields nulls.
    //
    // Field names are NOT interchangeable between platforms: Facebook's Messenger User
    // Profile API only recognizes first_name/last_name/profile_pic and fails the entire
    // request (error 100/33 "Object does not exist") if given Instagram-only fields like
    // name/username. Confirmed live against production: requesting the wrong fields for
    // Facebook silently zeroed out every Facebook avatar while Instagram kept working.
    async function fetchParticipantProfile(
      participantId: string,
      account: any,
      pageToken: string,
      platform: string
    ): Promise<{ name: string | null; profilePic: string | null }> {
      const isDirect = platform === "INSTAGRAM" && isDirectInstagramAccount(account);
      const base = isDirect ? INSTAGRAM_GRAPH_API : GRAPH_API;
      const token = isDirect ? account.access_token : pageToken;
      const isFacebookMessenger = platform !== "INSTAGRAM";
      const fields = isFacebookMessenger ? "first_name,last_name,profile_pic" : "name,username,profile_pic";
      try {
        const url = `${base}/${participantId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        if (!res.ok) return { name: null, profilePic: null };
        const data = await res.json();
        const name = isFacebookMessenger
          ? [data.first_name, data.last_name].filter(Boolean).join(" ") || null
          : data.name || (data.username ? `@${data.username}` : null);
        return { name, profilePic: data.profile_pic || null };
      } catch {
        // Silently fail - privacy restrictions, blocked user, or missing App Review feature
        return { name: null, profilePic: null };
      }
    }

    // Helper: resolve participant name for IG conversations
    async function resolveParticipantName(participant: any, pageToken: string, platform: string, account: any): Promise<string> {
      // If name is available, use it
      if (participant?.name && participant.name !== "") return participant.name;
      // If username available (IG), use it
      if (participant?.username) return `@${participant.username}`;

      // For Instagram, try fetching user info
      if (platform === "INSTAGRAM" && participant?.id) {
        const { name } = await fetchParticipantProfile(participant.id, account, pageToken, platform);
        if (name) return name;
      }

      return participant?.id ? `User ${participant.id.slice(-6)}` : "Unknown";
    }

    interface ParticipantAvatarRequest {
      account: any;
      pageToken: string;
      platform: string;
      conversationId: string;
      participant: any;
      participantName: string;
    }

    // Reads a still-fresh cached avatar for a conversation, if one exists.
    // Meta's profile_pic URLs expire after a few days, so anything older than
    // AVATAR_CACHE_TTL_MS is treated as a miss and re-fetched.
    async function getCachedParticipantAvatar(conversationId: string): Promise<string | null> {
      const { data: cached } = await adminClient
        .from("messaging_cache")
        .select("participant_avatar, updated_at")
        .eq("user_id", user.id)
        .eq("conversation_id", conversationId)
        .maybeSingle();

      const isFresh = !!cached?.updated_at
        && Date.now() - new Date(cached.updated_at).getTime() < AVATAR_CACHE_TTL_MS;
      return isFresh ? (cached?.participant_avatar || null) : null;
    }

    // Uploads a freshly-fetched profile_pic to Cloudinary for permanent storage,
    // then records it in messaging_cache so getCachedParticipantAvatar can serve it
    // without hitting Meta again until the TTL expires.
    async function cacheParticipantAvatar(req: ParticipantAvatarRequest, profilePic: string): Promise<string | null> {
      const cachedUrl = await cacheAvatarToCloudinary(profilePic, user.id, req.account.platform, req.participant.id);

      await adminClient.from("messaging_cache").upsert(
        {
          user_id: user.id,
          social_account_id: req.account.id,
          platform: req.account.platform,
          conversation_id: req.conversationId,
          participant_id: req.participant.id,
          participant_name: req.participantName,
          participant_avatar: cachedUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id" }
      );

      return cachedUrl;
    }

    // Helper: resolve (and permanently cache) a conversation participant's avatar.
    // profile_pic isn't included in the bulk participants{} payload, so this checks
    // messaging_cache first and only calls Meta + Cloudinary once the cache is stale.
    async function resolveParticipantAvatar(req: ParticipantAvatarRequest): Promise<string | null> {
      const participantId = req.participant?.id;
      if (!participantId) return null;

      const fresh = await getCachedParticipantAvatar(req.conversationId);
      if (fresh) return fresh;

      // Opportunistic: some Conversations API responses already include profile_pic
      // inline on the participant, saving a per-participant Graph round trip.
      const profilePic = req.participant?.profile_pic
        || (await fetchParticipantProfile(participantId, req.account, req.pageToken, req.platform)).profilePic;
      if (!profilePic) return null;

      return cacheParticipantAvatar(req, profilePic);
    }

    // Threads has no DM API, so its agent only ever answers public replies and mentions.
    // It still needs a config row, engagement modes and threads like the others.
    const supportedAiAgentPlatforms = ["whatsapp", "facebook", "instagram", "threads"];
    const supportedAiAgentModes = ["ai_first", "human_first", "human_then_ai"];

function isAiAgentPlatform(value: unknown): value is string {
      return typeof value === "string" && supportedAiAgentPlatforms.includes(value);
    }

    function normalizeAdminPhoneNumber(value: unknown): string | null {
      if (typeof value !== "string" || !value.trim().startsWith("+")) return null;
      const normalized = `+${value.trim().slice(1).replace(/[\s-]/g, "")}`;
      return /^\+[1-9]\d{1,14}$/.test(normalized) ? normalized : null;
    }

    // ACTION: get_automation_handlers
    if (action === "get_automation_handlers") {
      const account = await getAccountToken(String(body.social_account_id || ""));
      return jsonResponse({
        social_account_id: account.id,
        platform: account.platform,
        automation_handler: resolveAutomationHandler(account.account_metadata),
        comment_automation_handler: resolveCommentAutomationHandler(account.account_metadata),
        media_understanding: resolveMediaUnderstandingMode(account.account_metadata),
      });
    }

    // ACTION: set_automation_handlers
    if (action === "set_automation_handlers") {
      // getAccountToken already scopes the lookup to this user, so an unowned id 404s here
      // before the RPC is ever reached.
      const account = await getAccountToken(String(body.social_account_id || ""));
      const patch: Record<string, string> = {};

      if (body.automation_handler !== undefined) {
        if (!(MESSAGE_AUTOMATION_HANDLERS as readonly unknown[]).includes(body.automation_handler)) {
          return jsonResponse({ error: "automation_handler must be internal, n8n or off" }, 400);
        }
        patch.automation_handler = body.automation_handler;
      }

      if (body.comment_automation_handler !== undefined) {
        if (!(COMMENT_AUTOMATION_HANDLERS as readonly unknown[]).includes(body.comment_automation_handler)) {
          return jsonResponse({ error: "comment_automation_handler must be off, internal or n8n" }, 400);
        }
        patch.comment_automation_handler = body.comment_automation_handler;
      }

      if (body.media_understanding !== undefined) {
        if (!(MEDIA_UNDERSTANDING_MODES as readonly unknown[]).includes(body.media_understanding)) {
          return jsonResponse({
            error: `media_understanding must be one of ${MEDIA_UNDERSTANDING_MODES.join(", ")}`,
          }, 400);
        }
        patch.media_understanding = body.media_understanding;
      }

      if (Object.keys(patch).length === 0) return jsonResponse({ error: "Nothing to update" }, 400);

      // Atomic jsonb merge inside the row lock. A read-merge-write here would clobber a
      // concurrent update to any other account_metadata key (ig_igid, flow, token_type).
      // anonClient carries the caller's JWT, which the RPC needs: it self-scopes on auth.uid().
      const { data: merged, error } = await anonClient.rpc("patch_account_metadata", {
        p_account_id: account.id,
        p_patch: patch,
      });
      if (error) throw error;

      return jsonResponse({
        social_account_id: account.id,
        platform: account.platform,
        automation_handler: resolveAutomationHandler(merged),
        comment_automation_handler: resolveCommentAutomationHandler(merged),
      });
    }

    // ACTION: ai_get_config
    if (action === "ai_get_config") {
      const { platform } = body;
      if (!isAiAgentPlatform(platform)) return jsonResponse({ error: "Invalid AI agent platform" }, 400);
      // A malformed id is refused rather than read as "no account named" --
      // the unscoped read answers for a different account than the caller
      // thought they named.
      const named = parseNamedAccountId(body.social_account_id);
      if ("invalid" in named) {
        return jsonResponse({ error: "social_account_id must be a non-empty string" }, 400);
      }
      const accountId = "absent" in named
        ? null
        : await resolveOwnedAccountId(adminClient, user.id, platform, (named as { id: string }).id, {
          // Active on the read too, so read and write agree. Splitting them
          // let ai_get_config answer for a deactivated account that
          // ai_upsert_config then refused with 404 -- a form you can open and
          // cannot save. The selector never offers an inactive account, so
          // there is no repair path behind that door anyway.
          requireActive: true,
        });
      if (!("absent" in named) && !accountId) {
        return jsonResponse({ error: "Account not found" }, 404);
      }
      // Shared with ai-agent-reply so the form can never render a different
      // config from the one that actually answers customers.
      const data = await loadAgentConfigForAccount(adminClient, {
        userId: user.id,
        platform,
        accountId,
      });
      return jsonResponse({ config: data || null });
    }

    // ACTION: ai_upsert_config
    if (action === "ai_upsert_config") {
      const { platform, config } = body;
      if (!isAiAgentPlatform(platform)) return jsonResponse({ error: "Invalid AI agent platform" }, 400);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return jsonResponse({ error: "config must be an object" }, 400);
      }

      const allowedFields = [
        "is_enabled", "default_mode", "persona_instructions", "business_profile_text",
        "language_mode", "model", "fallback_model_1", "fallback_model_2",
        "temperature", "admin_phone_numbers",
        "daily_message_cap", "reply_cooldown_seconds", "max_tool_iterations",
        "handoff_on_request", "handoff_on_low_confidence",
      ];
      const updates: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (field in config) updates[field] = config[field];
      }

      if ("admin_phone_numbers" in updates) {
        if (!Array.isArray(updates.admin_phone_numbers)) {
          return jsonResponse({ error: "admin_phone_numbers must be an array" }, 400);
        }
        const normalized = updates.admin_phone_numbers.map(normalizeAdminPhoneNumber);
        const invalid = updates.admin_phone_numbers.filter((_: unknown, index: number) => !normalized[index]);
        if (invalid.length > 0) {
          return jsonResponse({ error: `Invalid admin phone numbers: ${invalid.join(", ")}` }, 400);
        }
        updates.admin_phone_numbers = normalized as string[];
      }

      // Model fields must come from the admin-curated allow-list. Values are
      // stored as "provider/model_id"; bare "model_id" is accepted for legacy
      // configs. Empty-string fallbacks clear the slot.
      const modelFields = ["model", "fallback_model_1", "fallback_model_2"] as const;
      const modelFieldsPresent = modelFields.filter((field) => field in updates);
      if (modelFieldsPresent.length > 0) {
        const { data: allowedModels, error: allowedError } = await adminClient
          .from("ai_agent_allowed_models")
          .select("provider, model_id")
          .eq("is_active", true);
        if (allowedError) throw allowedError;
        const validValues = new Set<string>();
        for (const row of allowedModels || []) {
          validValues.add(row.model_id);
          validValues.add(`${row.provider}/${row.model_id}`);
        }
        for (const field of modelFieldsPresent) {
          const value = updates[field];
          if (value === null || value === "") {
            if (field === "model") return jsonResponse({ error: "model is required" }, 400);
            updates[field] = null;
            continue;
          }
          if (typeof value !== "string" || !validValues.has(value)) {
            return jsonResponse({ error: `${field} is not an allowed model` }, 400);
          }
        }
      }

      // Same refusal as the read: "" / 0 / false are a caller bug, not an
      // absent account, and reading them as unscoped writes to whichever
      // account the server picks instead of the one that was named.
      const namedWrite = parseNamedAccountId(body.social_account_id);
      if ("invalid" in namedWrite) {
        return jsonResponse({ error: "social_account_id must be a non-empty string" }, 400);
      }
      // requireActive on the WRITE path only. Reading a deactivated account's
      // config is legitimate -- an operator inspecting a account whose
      // credentials expired -- but writing through a stale id would move the
      // platform's only config back onto the dead row a QR reconnect replaced.
      const accountId = "absent" in namedWrite
        ? null
        : await resolveOwnedAccountId(adminClient, user.id, platform, (namedWrite as { id: string }).id, {
          requireActive: true,
        });
      if (!("absent" in namedWrite) && !accountId) {
        return jsonResponse({ error: "Account not found" }, 404);
      }
      // A caller naming no account is resolved to the owner's active
      // accounts on the platform: exactly one is unambiguous, and zero or
      // several are refused because picking for the caller would either
      // write the wrong brand's persona or resurrect a dead account's row.
      // This is what keeps the action correct after
      // ai_agent_configs_user_id_platform_key is dropped; while it stands,
      // a scoped upsert onto the owner's only account is equivalent to the
      // old unscoped write.
      const writeScope = accountId
        ? { accountId }
        : await resolveConfigWriteAccount(adminClient, user.id, platform);
      if ("error" in writeScope) {
        return jsonResponse({ error: writeScope.error }, 400);
      }
      // A write that empties a stored persona or business profile must say it
      // means to. On 2026-08-30 the settings form submitted its blank defaults
      // over a live persona twice, four minutes apart, with every client-side
      // guard satisfied -- so this refusal cannot depend on the client being
      // correct. It sits after writeScope because it reads THAT account's stored
      // config; earlier it would compare against the wrong row or against
      // nothing. loadAgentConfigForAccount throws rather than returning null on a
      // read error, which is the right failure here: a save that cannot read what
      // is stored cannot know whether it destroys it.
      if (body.confirm_clear !== true) {
        const existing = await loadAgentConfigForAccount(adminClient, {
          userId: user.id,
          platform,
          accountId: writeScope.accountId,
        });
        const blanked = blankedFields(updates, existing);
        if (blanked.length > 0) {
          return jsonResponse({
            error:
              `Refusing to clear ${blanked.join(" and ")} for this account. ` +
              `Re-send with confirm_clear to erase it deliberately.`,
            blanked_fields: blanked,
          }, 409);
        }
      }
      // The row decision lives in aiConfigScope so the row it writes can be
      // asserted directly: while UNIQUE (user_id, platform) stands it updates
      // the owner's single config for the platform and re-points it at the
      // named account, because inserting a second row for that pair trips the
      // surviving constraint with 23505 -- which is what a WhatsApp QR
      // reconnect produces, the config still bound to the deactivated row.
      const { data, error } = await writeAccountScopedConfig(adminClient, {
        userId: user.id,
        platform,
        accountId: writeScope.accountId,
        updates,
      });
      if (error) throw error;
      return jsonResponse({ config: data });
    }

    // ACTION: ai_get_conversation_mode
    if (action === "ai_get_conversation_mode") {
      const { platform, conversation_id } = body;
      if (!isAiAgentPlatform(platform) || typeof conversation_id !== "string" || !conversation_id.trim()) {
        return jsonResponse({ error: "platform and conversation_id are required" }, 400);
      }
      const { data, error } = await adminClient
        .from("ai_conversation_modes")
        .select("*")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .eq("conversation_id", conversation_id)
        .maybeSingle();
      if (error) throw error;
      return jsonResponse({ mode: data || null });
    }

    // ACTION: ai_set_conversation_mode
    if (action === "ai_set_conversation_mode") {
      const { platform, conversation_id, mode } = body;
      if (!isAiAgentPlatform(platform) || typeof conversation_id !== "string" || !conversation_id.trim()) {
        return jsonResponse({ error: "platform and conversation_id are required" }, 400);
      }
      if (mode === null || mode === "default") {
        const { error } = await adminClient
          .from("ai_conversation_modes")
          .delete()
          .eq("user_id", user.id)
          .eq("platform", platform)
          .eq("conversation_id", conversation_id);
        if (error) throw error;
        return jsonResponse({ mode: null });
      }
      if (typeof mode !== "string" || !supportedAiAgentModes.includes(mode)) {
        return jsonResponse({ error: "Invalid AI conversation mode" }, 400);
      }
      const { data, error } = await adminClient
        .from("ai_conversation_modes")
        .upsert({ user_id: user.id, platform, conversation_id, mode }, { onConflict: "user_id,platform,conversation_id" })
        .select()
        .single();
      if (error) throw error;
      return jsonResponse({ mode: data });
    }

    // ACTION: ai_list_conversation_modes
    if (action === "ai_list_conversation_modes") {
      const { platform } = body;
      if (!isAiAgentPlatform(platform)) return jsonResponse({ error: "Invalid AI agent platform" }, 400);
      const { data, error } = await adminClient
        .from("ai_conversation_modes")
        .select("*")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return jsonResponse({ modes: data || [] });
    }

    // The Vault seam for the tool actions. PostgREST on this stack exposes
    // only public/storage/graphql_public, so the vault schema is reached
    // through the service-role-only wrappers this PR's migration adds
    // (upsert_connector_credential_secret does the §4.3 decrypt-merge-
    // re-encrypt inside the database; a decrypted credential never enters
    // this function's process).
    function wrapRpcError(error: unknown, fallback: string): Error {
      const message = (error as { message?: unknown })?.message;
      return new Error(typeof message === "string" ? message : fallback);
    }
    const credentialVault: CredentialVault = {
      async upsertCredentials(secretId, blob) {
        const { data, error } = await adminClient.rpc("upsert_connector_credential_secret", {
          p_secret_id: secretId,
          p_secret: blob,
        });
        if (error) throw wrapRpcError(error, "Failed to store connector credentials");
        // The wrapper is RETURNS TABLE, so PostgREST sends an array; parsing
        // lives in credentialVaultRpc.ts because that is the only shape here a
        // test can reach. See that file's header for the failure it fixes.
        return parseCredentialUpsertResult(data);
      },
      async deleteCredentials(secretId) {
        const { error } = await adminClient.rpc("delete_connector_credential_secret", {
          p_secret_id: secretId,
        });
        if (error) throw wrapRpcError(error, "Failed to delete connector credentials");
      },
    };

    // The tool/sharing modules declare the exact client surface they use
    // (see toolWrites.ts); the esm.sh client here is untyped, so the seam is
    // crossed with one explicit cast rather than four drifting `any`s.
    const toolAdmin = adminClient as unknown as ToolAdminClient;
    const sharingAdmin = adminClient as unknown as SharingAdminClient;

    // ACTION: ai_list_tools
    if (action === "ai_list_tools") {
      // Stored secrets and vault ids never leave the server; the client only
      // learns whether a secret exists (ARCHITECTURE.md §13) and which
      // credential fields are configured -- configured_secret_fields exists
      // precisely so this list never touches Vault (spec §4.3).
      const tools = await listToolsForUser(toolAdmin, user.id);
      return jsonResponse({ tools });
    }

    // ACTION: ai_upsert_tool
    // Writes one account-scoped connector row (scope, account, platform
    // derived from the account) with its credentials split by the registry:
    // non-secret fields into `settings`, secret fields into one Vault secret
    // per connector, vault FIRST and row SECOND. All validation and refusal
    // semantics live in toolWrites.ts, testable without an Edge Runtime.
    if (action === "ai_upsert_tool") {
      const input = parseUpsertToolInput(body);
      const tool = await upsertAccountScopedTool(toolAdmin, credentialVault, {
        userId: user.id,
        input,
      });
      return jsonResponse({ tool });
    }

    // ACTION: ai_delete_tool
    // The Vault secret is reclaimed BEFORE the row is gone: once the row is
    // deleted the secret id is unrecoverable and the secret is orphaned
    // forever (spec §4.3 -- vault has no delete function of its own).
    if (action === "ai_delete_tool") {
      const { tool_id } = body;
      if (typeof tool_id !== "string" || !tool_id.trim()) {
        return jsonResponse({ error: "tool_id is required" }, 400);
      }
      await deleteAccountScopedTool(toolAdmin, credentialVault, {
        userId: user.id,
        toolId: tool_id.trim(),
      });
      return jsonResponse({ ok: true });
    }

    // ACTION: set_tool_accounts
    // Replaces a connector's whole explicit share set by delegating to the
    // set_ai_agent_tool_accounts RPC (migration 20260831130000, §12.2).
    // Parsing and ownership pre-checks live in toolSharing.ts so a caller
    // gets a clean 400/403/404 instead of a raw database error string; the
    // RPC is the authority and re-verifies everything.
    if (action === "set_tool_accounts") {
      const input = parseSetToolAccountsInput(body);
      await setToolAccounts(sharingAdmin, { userId: user.id, input });
      return jsonResponse({ ok: true });
    }

    // ACTION: list_accounts
    if (action === "list_accounts") {
      const { data, error } = await adminClient
        .from("social_accounts")
        .select("id, platform, platform_user_id, platform_username, avatar_url, account_metadata")
        .eq("user_id", user.id)
        .in("platform", ["facebook", "instagram", "whatsapp"])
        .eq("is_active", true);
      if (error) throw error;
      return jsonResponse({ accounts: data || [] });
    }

    // ACTION: list_conversations
    if (action === "list_conversations") {
      const { social_account_id, messaging_platform } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await getAccountToken(social_account_id);
      const platform = messaging_platform || (account.platform === "instagram" ? "INSTAGRAM" : "MESSENGER");

      let pageId = account.platform_user_id;
      let pageToken = account.access_token;
      let data: any;

      try {
        if (platform === "INSTAGRAM" && isDirectInstagramAccount(account)) {
          data = await listDirectInstagramConversations(account);
          if (data.error_type) return jsonResponse({ conversations: [], ...data });
        } else {
          const resolved = await getPageTokenForMessaging(adminClient, account);
          pageId = resolved.pageId;
          pageToken = resolved.pageToken;
          const url = `${GRAPH_API}/${pageId}/conversations?platform=${platform}&fields=participants{name,id,username,email,profile_pic},messages.limit(1){message,created_time,from},unread_count,updated_time&limit=50&access_token=${encodeURIComponent(pageToken)}`;
          data = await graphFetch(url);
        }
      } catch (err) {
        const msg = (err as Error).message || "";
        // For Instagram, surface a structured missing-scope payload instead of a
        // hard error so the inbox can render a "Reconnect Instagram" CTA.
        if (platform === "INSTAGRAM" && /PERMISSION_ERROR/i.test(msg)) {
          return jsonResponse({
            conversations: [],
            error: "Missing Instagram messaging permission. Please reconnect your Instagram account.",
            error_type: "MISSING_SCOPE",
            missing_scope: isDirectInstagramAccount(account) ? "instagram_business_manage_messages" : "instagram_manage_messages",
          });
        }
        if (platform === "INSTAGRAM" && /TOKEN_EXPIRED/i.test(msg)) {
          return jsonResponse({ conversations: [], error: msg, error_type: "TOKEN_EXPIRED" });
        }
        if (/NO_LINKED_PAGE_MATCH/i.test(msg)) {
          return jsonResponse({
            conversations: [],
            error: "Could not find the Facebook Page linked to this Instagram account. Please reconnect your Instagram account.",
            error_type: "MISSING_SCOPE",
            missing_scope: "instagram_manage_messages",
          });
        }
        throw err;
      }

      const conversations = await Promise.all((data.data || []).map(async (conv: any) => {
        // Self-exclusion by id alone is unreliable for direct-login Instagram accounts: Meta
        // reports a different id for "self" inside conversation payloads than the platform_user_id
        // stored at connect time. Also exclude by username, which is stable across both paths.
        const participant = conv.participants?.data?.find(
          (p: any) => p.id !== pageId && p.username !== account.platform_username
        ) || conv.participants?.data?.[0];
        const lastMsg = conv.messages?.data?.[0];
        const participantName = await resolveParticipantName(participant, pageToken, platform, account);
        const participantAvatar = await resolveParticipantAvatar({
          account, pageToken, platform, conversationId: conv.id, participant, participantName,
        });

        return {
          id: conv.id,
          participant_name: participantName,
          participant_id: participant?.id || "",
          participant_avatar: participantAvatar,
          // Stable key for agent-assignment/auto-reply lookups, matching what
          // facebook-instagram-webhook computes for the same conversation. Meta's own
          // conversation id (conv.id) isn't usable for this: it isn't present in webhook
          // payloads at all, only in this Graph API response.
          assignment_key: participant?.id ? `${account.id}_${participant.id}` : "",
          last_message: lastMsg?.message || "",
          last_message_time: lastMsg?.created_time || conv.updated_time,
          last_message_from: lastMsg?.from?.name || "",
          unread_count: conv.unread_count || 0,
          updated_time: conv.updated_time,
        };
      }));

      return jsonResponse({ conversations, paging: data.paging });
    }

    // ACTION: get_messages
    if (action === "get_messages") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      const account = await getAccountToken(social_account_id);
      let data: any;

      if (isDirectInstagramAccount(account)) {
        const fields = "messages.limit(50){message,from,to,created_time,attachments{mime_type,name,size,image_data,video_data,file_url}}";
        const url = `${INSTAGRAM_GRAPH_API}/${conversation_id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(account.access_token)}`;
        data = await graphFetch(url);
        data = data.messages || data;
      } else {
        const { pageToken } = await getPageTokenForMessaging(adminClient, account);
        const url = `${GRAPH_API}/${conversation_id}/messages?fields=message,from,to,created_time,attachments{mime_type,name,size,image_data,video_data,file_url}&limit=50&access_token=${encodeURIComponent(pageToken)}`;
        data = await graphFetch(url);
      }

      const messages = (data.data || []).map((msg: any) => ({
        id: msg.id,
        message: msg.message || "",
        from: msg.from,
        to: msg.to?.data || [],
        created_time: msg.created_time,
        attachments: msg.attachments?.data || [],
      }));

      return jsonResponse({ messages, paging: data.paging });
    }

    // Older inbox clients call send_message without a recipient, having only ever needed the
    // conversation id. Instagram Login cannot use that id to send, so the participant is
    // recovered from the conversation rather than failing the reply.
    async function resolveConversationRecipient(account: any, conversationId: string): Promise<string> {
      const url = `${INSTAGRAM_GRAPH_API}/${conversationId}?fields=participants&access_token=${encodeURIComponent(account.access_token)}`;
      const data = await graphFetch(url);
      const participant = (data?.participants?.data || []).find(
        (candidate: any) => candidate?.id !== account.platform_user_id && candidate?.username !== account.platform_username,
      );
      if (!participant?.id) throw new Error("Could not determine who to reply to in this conversation");
      return participant.id;
    }

    // ACTION: send_message
    if (action === "send_message") {
      const { social_account_id, conversation_id, message, recipient_id, use_human_agent_tag } = body;
      if (!social_account_id || !conversation_id || !message) throw new Error("social_account_id, conversation_id, and message required");

      const account = await getAccountToken(social_account_id);
      const { graphBase, pageId, pageToken } = await getSendCredentials(adminClient, account);

      // A human agent replying outside the standard messaging window needs Meta's HUMAN_AGENT
      // message tag, which requires the standard Send API (recipient + messaging_type) rather
      // than the conversation-reply shortcut used for ordinary in-window replies.
      let url: string;
      let payload: Record<string, unknown>;
      if (use_human_agent_tag) {
        if (!recipient_id) throw new Error("recipient_id required when use_human_agent_tag is set");
        url = `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;
        payload = {
          recipient: { id: recipient_id },
          messaging_type: "MESSAGE_TAG",
          tag: "HUMAN_AGENT",
          message: { text: message },
        };
      } else if (isDirectInstagramAccount(account)) {
        // graph.instagram.com has no conversation-reply shortcut. POSTing to the opaque
        // conversation id there fails with "Object with ID 'aWdf...' does not exist", so an
        // Instagram Login DM can only be answered through the Send API form -- the same one
        // the webhook's auto-reply and send_media already use.
        url = `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;
        payload = {
          recipient: { id: recipient_id || await resolveConversationRecipient(account, conversation_id) },
          message: { text: message },
        };
      } else {
        url = `${graphBase}/${conversation_id}/messages?access_token=${encodeURIComponent(pageToken)}`;
        payload = { message };
      }

      const data = await graphFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return jsonResponse({ success: true, message_id: data.id || data.message_id });
    }

    // ACTION: send_media
    if (action === "send_media") {
      const { social_account_id, recipient_id, media_url, media_type } = body;
      if (!social_account_id || !recipient_id || !media_url) throw new Error("social_account_id, recipient_id, and media_url required");

      const account = await getAccountToken(social_account_id);
      const { graphBase, pageId, pageToken } = await getSendCredentials(adminClient, account);
      const url = `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;

      const payload = {
        recipient: { id: recipient_id },
        message: {
          attachment: {
            type: media_type || "image",
            payload: { url: media_url, is_reusable: false },
          },
        },
      };

      const data = await graphFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return jsonResponse({ success: true, message_id: data.message_id });
    }

    // ACTION: delete_message
    if (action === "delete_message") {
      const { social_account_id, message_id } = body;
      if (!social_account_id || !message_id) throw new Error("social_account_id and message_id required");

      const account = await getAccountToken(social_account_id);
      // The inbox renders delete on every message, but this routes through Meta Graph.
      // A Direct QR account has no Graph token, so without this the button fails with an
      // opaque credentials error instead of saying the action is unavailable.
      if (account.connection_mode === "evolution_qr") {
        throw new Error("This action is not supported in Direct QR mode");
      }
      const { graphBase, pageToken } = await getSendCredentials(adminClient, account);
      const url = `${graphBase}/${message_id}?access_token=${encodeURIComponent(pageToken)}`;

      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      return jsonResponse({ success: res.ok, data });
    }

    // ===== WhatsApp Cloud API Actions =====

    function getWhatsAppMetadata(account: WhatsAppAccountAccess): Record<string, unknown> {
      return account.accountMetadata && typeof account.accountMetadata === "object"
        ? account.accountMetadata as Record<string, unknown>
        : {};
    }

    function rejectDirectQrCapability(account: WhatsAppAccountAccess): void {
      if (account.connectionMode === "evolution_qr") {
        throw new Error("This action is not supported in Direct QR mode");
      }
    }

    // Helper: get WhatsApp token. Multi-tenant: each account sends with its own
    // per-user token from the DB. The shared WHATSAPP_ACCESS_TOKEN env secret is
    // only a fallback for legacy admin accounts that never stored a token.
    function getWhatsAppToken(account: WhatsAppAccountAccess): string {
      if (account.accessToken) {
        console.log("[messaging] Using per-user token from DB");
        return account.accessToken;
      }
      const envToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      if (envToken) {
        console.log("[messaging] No per-user token — falling back to WHATSAPP_ACCESS_TOKEN env secret");
        return envToken;
      }
      console.log("[messaging] No token available for this account");
      return account.accessToken;
    }

    // Helper: mark account as cloud-api-registered in DB
    async function markCloudApiRegistered(socialAccountId: string) {
      try {
        const { data: acc } = await (adminClient as any)
          .from("social_accounts")
          .select("account_metadata")
          .eq("id", socialAccountId)
          .maybeSingle();
        const meta = (acc?.account_metadata as Record<string, unknown>) || {};
        await (adminClient as any)
          .from("social_accounts")
          .update({ account_metadata: { ...meta, cloud_api_registered: true, cloud_api_registered_at: new Date().toISOString() } })
          .eq("id", socialAccountId);
      } catch (e) {
        console.warn("[messaging] Failed to mark cloud_api_registered:", e);
      }
    }

    // Helper: register WhatsApp phone number via Cloud API
    async function registerWhatsAppPhone(phoneNumberId: string, token: string, socialAccountId?: string): Promise<any> {
      const pin = Deno.env.get("WHATSAPP_VERIFY_PIN") || "000000";
      const url = `${GRAPH_API}/${phoneNumberId}/register`;
      console.log(`[messaging] Attempting to register phone number ${phoneNumberId}...`);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messaging_product: "whatsapp", pin }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        console.error("[messaging] Registration failed:", JSON.stringify(data));
        const err = data.error || {};
        // Subcode 2388001: 2FA enabled on the WhatsApp Business mobile app
        if (err.code === 100 && err.error_subcode === 2388001) {
          const friendly = "Two-step verification is enabled on the WhatsApp Business mobile app for this number. Open WhatsApp Business → Settings → Account → Two-step verification → Turn off, then try again. (After the first successful registration, you may re-enable it.)";
          const e: any = new Error(friendly);
          e.error_type = "WHATSAPP_2FA_ENABLED";
          e.error_subcode = 2388001;
          throw e;
        }
        const userMsg = err.error_user_msg || err.message || JSON.stringify(data);
        throw new Error(`Registration failed: ${userMsg}`);
      }
      console.log("[messaging] Phone number registered successfully");
      if (socialAccountId) await markCloudApiRegistered(socialAccountId);
      return data;
    }

    // Helper: send WhatsApp message with auto-registration retry on 133010
    async function sendWhatsAppWithRetry(url: string, token: string, payload: any, phoneNumberId: string, socialAccountId?: string): Promise<any> {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      // Auto-register on error 133010 OR 100/33 (phone not on Cloud API yet)
      const needsRegistration =
        data.error?.code === 133010 ||
        (data.error?.code === 100 && data.error?.error_subcode === 33);

      if (needsRegistration) {
        console.log(`[messaging] Got ${data.error?.code}/${data.error?.error_subcode ?? ""} — attempting auto-register of phone ${phoneNumberId}...`);
        try {
          await registerWhatsAppPhone(phoneNumberId, token, socialAccountId);
        } catch (regErr) {
          // Registration itself failed — surface a friendly message
          const msg = regErr instanceof Error ? regErr.message : String(regErr);
          throw new Error(
            `This WhatsApp number (${phoneNumberId}) is not registered on the Cloud API. ` +
            `Auto-registration failed: ${msg}. ` +
            `For Coexistence accounts, the phone must be migrated to the Cloud API before sending. ` +
            `Open Admin → WhatsApp → Register Phone, or reconnect the account in Cloud API mode.`
          );
        }
        // Retry the send
        const retryRes = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
        const retryData = await retryRes.json();
        if (retryData.error) {
          throw new Error(`Graph API error after registration: ${JSON.stringify(retryData.error)}`);
        }
        return retryData;
      }

      if (data.error) {
        throw new Error(`Graph API error: ${JSON.stringify(data.error)}`);
      }
      return data;
    }

    // ACTION: whatsapp_register_phone (manual registration)
    if (action === "whatsapp_register_phone") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_register_phone",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const phoneNumberId = account.platformUserId;
      const token = getWhatsAppToken(account);
      const result = await registerWhatsAppPhone(phoneNumberId, token, social_account_id);
      return jsonResponse({ success: true, message: "Phone number registered successfully", data: result });
    }

    // ACTION: whatsapp_send_message
    if (action === "whatsapp_send_message") {
      const { social_account_id, recipient_phone, message, message_type } = body;
      if (!social_account_id || !recipient_phone || !message) throw new Error("social_account_id, recipient_phone, and message required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_message",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      const phoneNumberId = account.platformUserId;
      let data: any;
      if (message_type === "template") {
        rejectDirectQrCapability(account);
        const token = getWhatsAppToken(account);
        const payload = {
          messaging_product: "whatsapp",
          to: recipient_phone,
          type: message_type,
          template: typeof message === "string" ? JSON.parse(message) : message,
        };
        data = await sendWhatsAppWithRetry(
          `${GRAPH_API}/${phoneNumberId}/messages`,
          token,
          payload,
          phoneNumberId,
          social_account_id,
        );
      } else {
        const transport = await resolveWhatsAppTransport(adminClient, {
          id: account.accountId,
          platform_user_id: account.platformUserId,
          access_token: account.accessToken,
          connection_mode: account.connectionMode,
          account_metadata: account.accountMetadata as Record<string, unknown> | null,
        });
        data = (await transport.sendText({ recipientPhone: recipient_phone, text: String(message) })).raw;
      }
      const sentMessageId = data?.messages?.[0]?.id || data?.key?.id;

      // Store outbound message in whatsapp_messages table
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: account.ownerId,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
        message_text: message_type === "template" ? "[Template message]" : message,
        message_type: message_type || "text",
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: account.ownerId,
        social_account_id,
        workspace_id: account.workspaceId,
        phone_number_id: phoneNumberId,
        recipient_phone,
        preview: message_type === "template" ? "[Template message]" : message,
      });

      return jsonResponse({ success: true, message_id: sentMessageId, data });
    }

    // ACTION: whatsapp_send_template
    if (action === "whatsapp_send_template") {
      const { social_account_id, recipient_phone, template_name, template_language, template_components } = body;
      if (!social_account_id || !recipient_phone || !template_name) throw new Error("social_account_id, recipient_phone, and template_name required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_template",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);

      // Delegated to the shared op so the JWT door and the partner-api key door
      // run one implementation and cannot drift. Authorization stays here: this
      // door resolves a human workspace role, the other resolves key scopes.
      const result = await sendTemplate({
        admin: adminClient,
        accountId: account.accountId,
        ownerId: account.ownerId,
        workspaceId: account.workspaceId,
        phoneNumberId: account.platformUserId,
        accessToken: getWhatsAppToken(account),
        connectionMode: account.connectionMode,
      }, {
        recipientPhone: recipient_phone,
        templateName: template_name,
        templateLanguage: template_language || "en_US",
        components: template_components,
      });

      // `data` preserves the existing frontend contract — WhatsAppDiagnostics.tsx
      // and useMessaging.ts consume this response shape.
      return jsonResponse({ success: true, message_id: result.messageId, data: result.raw });
    }

    // ACTION: whatsapp_list_templates
    if (action === "whatsapp_list_templates") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_list_templates",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      const wabaId = getWhatsAppMetadata(account).waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
      if (!wabaId) throw new Error("WhatsApp Business Account ID not found. Please reconnect your account.");

      const waToken = getWhatsAppToken(account);
      const url = `${GRAPH_API}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=100&access_token=${waToken}`;
      const data = await graphFetch(url);

      return jsonResponse({ templates: data.data || [] });
    }

    // ACTION: whatsapp_create_template
    if (action === "whatsapp_create_template") {
      const { social_account_id, name, category, language, components } = body;
      if (!social_account_id || !name || !category || !components) throw new Error("social_account_id, name, category, and components required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_create_template",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      const wabaId = getWhatsAppMetadata(account).waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
      if (!wabaId) throw new Error("WhatsApp Business Account ID not found.");

      const waToken = getWhatsAppToken(account);
      const url = `${GRAPH_API}/${wabaId}/message_templates`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${waToken}`,
        },
        body: JSON.stringify({
          name,
          category,
          language,
          components,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      return jsonResponse({ success: true, template_id: data.id, data });
    }

    // ACTION: whatsapp_get_analytics
    if (action === "whatsapp_get_analytics") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_analytics",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      // Get conversation stats from messaging_cache
      const { data: cacheData, error: cacheError } = await adminClient
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", social_account_id)
        .eq("workspace_id", account.workspaceId)
        .eq("platform", "whatsapp");
      if (cacheError) throw cacheError;

      // Get analytics data
      const { data: analyticsData, error: analyticsError } = await adminClient
        .from("whatsapp_message_analytics")
        .select("*")
        .eq("social_account_id", social_account_id)
        .eq("user_id", user!.id)
        .order("date", { ascending: false })
        .limit(30);
      if (analyticsError) throw analyticsError;

      return jsonResponse({
        conversations: cacheData || [],
        analytics: analyticsData || [],
        summary: {
          total_conversations: cacheData?.length || 0,
          total_unread: cacheData?.reduce((sum: number, c: any) => sum + (c.unread_count || 0), 0) || 0,
        },
      });
    }

    // ACTION: whatsapp_list_conversations (from messaging_cache)
    if (action === "whatsapp_list_conversations") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_list_conversations",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      const { data, error } = await adminClient
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", social_account_id)
        .eq("workspace_id", account.workspaceId)
        .eq("platform", "whatsapp")
        .order("last_message_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const participantPhone = (conversationId: string) =>
        conversationId.replace(`wa_${social_account_id}_`, "").replace(/^wa_\d+_/, "");
      const participantPhones = [...new Set(
        (data || []).map((conversation: any) => participantPhone(conversation.conversation_id)),
      )].filter(Boolean);
      const contactIdByPhone = new Map<string, string>();

      if (participantPhones.length > 0) {
        const { data: contacts, error: contactsError } = await adminClient
          .from("whatsapp_contacts")
          .select("id, phone_number")
          .eq("workspace_id", account.workspaceId)
          .in("phone_number", participantPhones);
        if (contactsError) throw contactsError;
        for (const contact of contacts || []) {
          contactIdByPhone.set(contact.phone_number, contact.id);
        }
      }

      const conversations = (data || []).map((c: any) => {
        const phone = participantPhone(c.conversation_id);
        return {
          id: c.conversation_id,
          cache_id: c.id,
          workspace_id: c.workspace_id,
          contact_id: contactIdByPhone.get(phone) || null,
          participant_name: c.participant_name || "Unknown",
          participant_id: phone,
          participant_avatar: c.participant_avatar || null,
          last_message: c.last_message_preview || "",
          last_message_time: c.last_message_at,
          last_message_from: c.participant_name || "",
          unread_count: c.unread_count || 0,
          updated_time: c.updated_at,
        };
      });

      return jsonResponse({ conversations });
    }

    // ACTION: whatsapp_get_messages
    if (action === "whatsapp_get_messages") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_messages",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      const pageRequest = parseWhatsAppMessagePageRequest(body);
      // Normalize conversation_id to handle both with and without '+' prefix
      const normalizedConvId = conversation_id.replace(/_\+/g, "_");

      // `.in` rather than `.or` for the conversation ids: the PostgREST client appends
      // duplicate `or` parameters, so the keyset predicate below would silently corrupt
      // the SQL if this occupied the single `.or()` slot.
      let messagesQuery = adminClient
        .from("whatsapp_messages")
        .select("*")
        .eq("social_account_id", social_account_id)
        .in("conversation_id", conversationIdsForFilter(normalizedConvId, conversation_id));

      if (pageRequest.mode === "paginated" && pageRequest.before) {
        messagesQuery = messagesQuery.or(keysetOrFilter(pageRequest.before));
      }

      // Newest-first, like Graph `get_messages`, so the shared inbox pane can treat both
      // platforms alike. Ascending would also make the limit keep the OLDEST hundred, which
      // hid every recent message on threads longer than that.
      const { data: msgs, error: msgsError } = await messagesQuery
        .order("timestamp", { ascending: false })
        // WhatsApp timestamps are second-granular and both ingest paths can land the same
        // second, so the id keeps the page stable across refetches instead of shuffling ties.
        .order("id", { ascending: false })
        .limit(pageFetchLimit(pageRequest));

      if (msgsError) throw msgsError;

      const paged = sliceWhatsAppMessagePage(msgs || [], pageRequest);
      const messages = paged.rows.map((m: any) => toWhatsAppMessageView(m));
      if (paged.page_info) return jsonResponse({ messages, page_info: paged.page_info });
      return jsonResponse({ messages });
    }

    // ACTION: whatsapp_get_media
    if (action === "whatsapp_get_media") {
      const { social_account_id, message_row_ids } = body;
      if (!social_account_id || !Array.isArray(message_row_ids)) {
        throw new Error("social_account_id and message_row_ids required");
      }
      if (message_row_ids.length > MAX_MEDIA_ROWS) {
        throw new Error(`message_row_ids exceeds ${MAX_MEDIA_ROWS}`);
      }

      const media = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_media",
        socialAccountId: social_account_id,
      }, (accountAccess) =>
        resolveWhatsAppMedia(adminClient, accountAccess, { messageRowIds: message_row_ids }));

      return jsonResponse({ media });
    }

    // ACTION: whatsapp_get_conversation_state
    if (action === "whatsapp_get_conversation_state") {
      const { social_account_id, conversation_id, message_row_ids } = body;
      if (!social_account_id || !conversation_id || !Array.isArray(message_row_ids)) {
        throw new Error("social_account_id, conversation_id, and message_row_ids required");
      }

      const state = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_conversation_state",
        socialAccountId: social_account_id,
      }, (accountAccess) =>
        getWhatsAppConversationState(adminClient, accountAccess, user.id, {
          conversationId: conversation_id,
          messageRowIds: message_row_ids,
        }));

      return jsonResponse(state);
    }

    // ACTION: whatsapp_set_message_flag
    if (action === "whatsapp_set_message_flag") {
      const { social_account_id, conversation_id, message_row_id, pinned, hidden } = body;
      if (!social_account_id || !conversation_id || !message_row_id) {
        throw new Error("social_account_id, conversation_id, and message_row_id required");
      }
      if (pinned === undefined && hidden === undefined) {
        throw new Error("pinned or hidden required");
      }

      const result = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_set_message_flag",
        socialAccountId: social_account_id,
      }, (accountAccess) =>
        setWhatsAppMessageFlag(adminClient, accountAccess, user.id, {
          conversationId: conversation_id,
          messageRowId: message_row_id,
          ...(typeof pinned === "boolean" ? { pinned } : {}),
          ...(typeof hidden === "boolean" ? { hidden } : {}),
        }));

      return jsonResponse(result);
    }

    // ACTION: whatsapp_revoke_message
    if (action === "whatsapp_revoke_message") {
      const { social_account_id, message_row_id } = body;
      if (!social_account_id || !message_row_id) {
        throw new Error("social_account_id and message_row_id required");
      }

      const result = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_revoke_message",
        socialAccountId: social_account_id,
      }, (accountAccess) =>
        revokeWhatsAppMessage(adminClient, accountAccess, user.id, {
          messageRowId: message_row_id,
        }));

      return jsonResponse(result);
    }

    // ACTION: whatsapp_send_voice
    if (action === "whatsapp_send_voice") {
      const { social_account_id, recipient_phone, media_path, duration_seconds, mime_type } = body;
      if (!social_account_id) {
        throw new Error("social_account_id required");
      }

      const result = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_voice",
        socialAccountId: social_account_id,
      }, (accountAccess) =>
        sendWhatsAppVoice(adminClient, accountAccess, user.id, {
          recipient_phone,
          media_path,
          duration_seconds,
          mime_type,
        }, { upsertOutboundConversation }));

      return jsonResponse(result);
    }

    // ACTION: whatsapp_mark_read
    if (action === "whatsapp_mark_read") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_mark_read",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      const { error } = await adminClient
        .from("messaging_cache")
        .update({ unread_count: 0 })
        .eq("social_account_id", social_account_id)
        .eq("workspace_id", account.workspaceId)
        .eq("conversation_id", conversation_id);

      if (error) throw error;
      return jsonResponse({ success: true });
    }

    // ACTION: whatsapp_send_media
    if (action === "whatsapp_send_media") {
      const { social_account_id, recipient_phone, media_url, media_path, media_type, caption } = body;
      if (!social_account_id || !recipient_phone || (!media_url && !media_path)) {
        throw new Error("social_account_id, recipient_phone, and media_url or media_path required");
      }

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_media",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      const phoneNumberId = account.platformUserId;

      let transportUrl = media_url as string | undefined;
      let persistedMediaUrl = media_url as string | undefined;
      if (media_path) {
        const path = ownedStoragePath(media_path, user.id);
        const signed = await signMediaPath(adminClient, path, OUTBOUND_SIGN_TTL_SECONDS);
        if (!signed) throw new Error("could not sign media_path");
        transportUrl = signed;
        persistedMediaUrl = path;
      }
      if (!transportUrl) throw new Error("media_url or media_path required");

      const mType = media_type || "document";
      const transport = await resolveWhatsAppTransport(adminClient, {
          id: account.accountId,
          platform_user_id: account.platformUserId,
          access_token: account.accessToken,
          connection_mode: account.connectionMode,
          account_metadata: account.accountMetadata as Record<string, unknown> | null,
      });
      const sourceName = String(media_path || media_url || "file");
      const data: any = (await transport.sendMedia({
        recipientPhone: recipient_phone,
        mediaUrl: transportUrl,
        mediaType: (mType === "image" || mType === "video" || mType === "document" || mType === "audio") ? mType : "document",
        caption,
        fileName: mType === "document" ? sourceName.split("/").pop() || "file" : undefined,
      })).raw;
      const sentMessageId = data?.messages?.[0]?.id || data?.key?.id;

      // Store outbound media message
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: account.ownerId,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
        message_text: caption || `[${mType}]`,
        message_type: mType,
        // media_url holds either an http(s):// provider URL (legacy/coexistence)
        // or a bucket-relative storage path. whatsapp_get_media branches on the http prefix.
        media_url: persistedMediaUrl,
        media_type: mType,
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: account.ownerId,
        social_account_id,
        workspace_id: account.workspaceId,
        phone_number_id: phoneNumberId,
        recipient_phone,
        preview: caption || `[${mType}]`,
      });

      return jsonResponse({ success: true, message_id: sentMessageId, data });
    }
    if (action === "whatsapp_send_interactive") {
      const { social_account_id, recipient_phone, interactive } = body;
      if (!social_account_id || !recipient_phone || !interactive) throw new Error("social_account_id, recipient_phone, and interactive required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_interactive",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const phoneNumberId = account.platformUserId;
      const url = `${GRAPH_API}/${phoneNumberId}/messages`;
      const token = getWhatsAppToken(account);

      const payload = {
        messaging_product: "whatsapp",
        to: recipient_phone,
        type: "interactive",
        interactive,
      };

      const data = await sendWhatsAppWithRetry(url, token, payload, phoneNumberId);
      const sentMessageId = data.messages?.[0]?.id;

      // Store outbound interactive message
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: account.ownerId,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: account.ownerId,
        social_account_id,
        workspace_id: account.workspaceId,
        phone_number_id: phoneNumberId,
        recipient_phone,
        preview: `[Interactive: ${interactive.type}] ${interactive.body?.text || ""}`,
      });

      return jsonResponse({ success: true, message_id: sentMessageId, data });
    }

    // ACTION: whatsapp_delete_template
    if (action === "whatsapp_delete_template") {
      const { social_account_id, template_name } = body;
      if (!social_account_id || !template_name) throw new Error("social_account_id and template_name required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_delete_template",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      const wabaId = getWhatsAppMetadata(account).waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
      if (!wabaId) throw new Error("WhatsApp Business Account ID not found.");

      const waToken = getWhatsAppToken(account);
      const url = `${GRAPH_API}/${wabaId}/message_templates?name=${template_name}`;

      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${waToken}` },
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      return jsonResponse({ success: true, data });
    }

    // ACTION: whatsapp_get_catalog
    if (action === "whatsapp_get_catalog") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");
      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_catalog",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const wabaId = getWhatsAppMetadata(account).waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
      if (!wabaId) throw new Error("WhatsApp Business Account ID not found.");
      const waToken = getWhatsAppToken(account);
      const res = await fetch(`${GRAPH_API}/${wabaId}/product_catalogs`, {
        headers: { Authorization: `Bearer ${waToken}` },
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      const catalogs = data.data || [];
      const catalog = catalogs[0];
      return jsonResponse({ catalog_id: catalog?.id || null, catalogs });
    }

    // ACTION: whatsapp_get_products
    if (action === "whatsapp_get_products") {
      const { social_account_id, catalog_id } = body;
      if (!social_account_id || !catalog_id) throw new Error("social_account_id and catalog_id required");
      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_get_products",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const waToken = getWhatsAppToken(account);
      const res = await fetch(`${GRAPH_API}/${catalog_id}/products?fields=id,name,description,price,currency,image_url,url,retailer_id,availability&limit=100`, {
        headers: { Authorization: `Bearer ${waToken}` },
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      return jsonResponse({ products: data.data || [] });
    }

    // ACTION: whatsapp_send_product
    if (action === "whatsapp_send_product") {
      const { social_account_id, recipient_phone, catalog_id, product_retailer_id } = body;
      if (!social_account_id || !recipient_phone || !catalog_id || !product_retailer_id) {
        throw new Error("social_account_id, recipient_phone, catalog_id, and product_retailer_id required");
      }
      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_product",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const phoneNumberId = getWhatsAppMetadata(account).phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      const waToken = getWhatsAppToken(account);
      const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipient_phone,
          type: "interactive",
          interactive: {
            type: "product",
            body: { text: "Check out this product" },
            action: { catalog_id, product_retailer_id },
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      return jsonResponse({ success: true, data });
    }

    // ACTION: whatsapp_send_product_list
    if (action === "whatsapp_send_product_list") {
      const { social_account_id, recipient_phone, catalog_id, sections } = body;
      if (!social_account_id || !recipient_phone || !catalog_id || !sections) {
        throw new Error("social_account_id, recipient_phone, catalog_id, and sections required");
      }
      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_product_list",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));
      rejectDirectQrCapability(account);
      const phoneNumberId = getWhatsAppMetadata(account).phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
      const waToken = getWhatsAppToken(account);
      const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipient_phone,
          type: "interactive",
          interactive: {
            type: "product_list",
            header: { type: "text", text: "Our Products" },
            body: { text: "Browse our catalog" },
            action: { catalog_id, sections },
          },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(`GRAPH_ERROR: ${data.error.message}`);
      return jsonResponse({ success: true, data });
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    console.error("messaging-api error:", err);
    const message = err.message || "Internal error";

    if (err instanceof ToolWriteError || err instanceof ToolSharingError) {
      return jsonResponse({ error: err.message }, err.status);
    }

    if (err instanceof WhatsAppAccessError) {
      return jsonResponse({ error: err.message }, err.status);
    }

    if (err instanceof WhatsAppRevokeError) {
      return gracefulError(err.message, err.error_type);
    }

    if (err instanceof WhatsAppVoiceSendError) {
      return gracefulError(err.message, err.error_type);
    }

    if (err instanceof MalformedMessageCursorError) {
      return jsonResponse({ error: err.message }, 400);
    }

    // Surface friendly WhatsApp 2FA error as 200 with structured field
    if (err.error_type === "WHATSAPP_2FA_ENABLED") {
      return gracefulError(message, "WHATSAPP_2FA_ENABLED");
    }
    
    // Return user-friendly errors as 200 with error field
    if (message.startsWith("TOKEN_EXPIRED:") || message.startsWith("PERMISSION_ERROR:") || message.startsWith("NO_LINKED_PAGE:") || message.startsWith("GRAPH_ERROR:")) {
      return gracefulError(message, message.split(":")[0]);
    }

    // Also catch "Cannot parse access token" as TOKEN_EXPIRED
    if (message.includes("Cannot parse access token") || message.includes("Invalid OAuth access token")) {
      return gracefulError("TOKEN_EXPIRED: Your access token has expired or is invalid. Please reconnect your account in Settings → Profiles.", "TOKEN_EXPIRED");
    }
    
    // Account not found - return graceful error
    if (message === "Account not found or access denied") {
      return gracefulError(message, "ACCOUNT_NOT_FOUND");
    }
    
    return jsonResponse({ error: message }, 500);
  }
});
