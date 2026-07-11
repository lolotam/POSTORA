import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isDirectInstagramAccount, getPageTokenForMessaging, getSendCredentials } from "../_shared/messengerCredentials.ts";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";

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
  }
) {
  const normalizedPhone = params.recipient_phone.replace(/\D/g, "");
  const conversationId = `wa_${params.phone_number_id}_${normalizedPhone}`;
  const nowIso = new Date().toISOString();

  // Look up existing contact display name (if any)
  const { data: existingContact } = await (adminClient as any)
    .from("whatsapp_contacts")
    .select("display_name")
    .eq("user_id", params.user_id)
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  const participantName = existingContact?.display_name || `+${normalizedPhone}`;

  // Auto-save contact (no-op on conflict)
  await (adminClient as any).from("whatsapp_contacts").upsert(
    {
      user_id: params.user_id,
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
    const body = await req.json();
    const { action } = body;

    // Helper: get access token for a social account
    async function getAccountToken(socialAccountId: string) {
      const { data, error } = await adminClient
        .from("social_accounts")
        .select("id, user_id, access_token, platform_user_id, platform_username, platform, ig_auth_type, account_metadata")
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

    const supportedAiAgentPlatforms = ["whatsapp", "facebook", "instagram"];
    const supportedAiAgentModes = ["ai_first", "human_first", "human_then_ai"];

    function isAiAgentPlatform(value: unknown): value is string {
      return typeof value === "string" && supportedAiAgentPlatforms.includes(value);
    }

    function normalizeAdminPhoneNumber(value: unknown): string | null {
      if (typeof value !== "string" || !value.trim().startsWith("+")) return null;
      const normalized = `+${value.trim().slice(1).replace(/[\s-]/g, "")}`;
      return /^\+[1-9]\d{1,14}$/.test(normalized) ? normalized : null;
    }

    // ACTION: ai_get_config
    if (action === "ai_get_config") {
      const { platform } = body;
      if (!isAiAgentPlatform(platform)) return jsonResponse({ error: "Invalid AI agent platform" }, 400);
      const { data, error } = await adminClient
        .from("ai_agent_configs")
        .select("*")
        .eq("user_id", user.id)
        .eq("platform", platform)
        .maybeSingle();
      if (error) throw error;
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
        "language_mode", "model", "temperature", "admin_phone_numbers",
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

      const { data, error } = await adminClient
        .from("ai_agent_configs")
        .upsert({ user_id: user.id, platform, ...updates }, { onConflict: "user_id,platform" })
        .select()
        .single();
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
      const { graphBase, pageToken } = await getSendCredentials(adminClient, account);
      const url = `${graphBase}/${message_id}?access_token=${encodeURIComponent(pageToken)}`;

      const res = await fetch(url, { method: "DELETE" });
      const data = await res.json();
      return jsonResponse({ success: res.ok, data });
    }

    // ===== WhatsApp Cloud API Actions =====

    // Helper: get WhatsApp token. Multi-tenant: each account sends with its own
    // per-user token from the DB. The shared WHATSAPP_ACCESS_TOKEN env secret is
    // only a fallback for legacy admin accounts that never stored a token.
    function getWhatsAppToken(account: any): string {
      if (account?.access_token) {
        console.log("[messaging] Using per-user token from DB");
        return account.access_token;
      }
      const envToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
      if (envToken) {
        console.log("[messaging] No per-user token — falling back to WHATSAPP_ACCESS_TOKEN env secret");
        return envToken;
      }
      console.log("[messaging] No token available for this account");
      return account?.access_token;
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

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const phoneNumberId = account.platform_user_id;
      const token = getWhatsAppToken(account);
      const result = await registerWhatsAppPhone(phoneNumberId, token, social_account_id);
      return jsonResponse({ success: true, message: "Phone number registered successfully", data: result });
    }

    // ACTION: whatsapp_send_message
    if (action === "whatsapp_send_message") {
      const { social_account_id, recipient_phone, message, message_type } = body;
      if (!social_account_id || !recipient_phone || !message) throw new Error("social_account_id, recipient_phone, and message required");

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const phoneNumberId = account.platform_user_id;
      const url = `${GRAPH_API}/${phoneNumberId}/messages`;
      const token = getWhatsAppToken(account);

      const payload: any = {
        messaging_product: "whatsapp",
        to: recipient_phone,
        type: message_type || "text",
      };

      if (message_type === "template") {
        payload.template = typeof message === "string" ? JSON.parse(message) : message;
      } else {
        payload.text = { body: message };
      }

      const data = await sendWhatsAppWithRetry(url, token, payload, phoneNumberId, social_account_id);
      const sentMessageId = data.messages?.[0]?.id;

      // Store outbound message in whatsapp_messages table
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: user!.id,
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
        user_id: user!.id,
        social_account_id,
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

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const phoneNumberId = account.platform_user_id;
      const url = `${GRAPH_API}/${phoneNumberId}/messages`;
      const token = getWhatsAppToken(account);

      const payload = {
        messaging_product: "whatsapp",
        to: recipient_phone,
        type: "template",
        template: {
          name: template_name,
          language: { code: template_language || "en_US" },
          components: template_components || [],
        },
      };

      const data = await sendWhatsAppWithRetry(url, token, payload, phoneNumberId, social_account_id);
      const sentMessageId = data.messages?.[0]?.id;

      // Store outbound template message in whatsapp_messages
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: user!.id,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
        message_text: `[Template: ${template_name}]`,
        message_type: "template",
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: user!.id,
        social_account_id,
        phone_number_id: phoneNumberId,
        recipient_phone,
        preview: `[Template: ${template_name}]`,
      });

      return jsonResponse({ success: true, message_id: sentMessageId, data });
    }

    // ACTION: whatsapp_list_templates
    if (action === "whatsapp_list_templates") {
      const { social_account_id } = body;
      if (!social_account_id) throw new Error("social_account_id required");

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const wabaId = account.account_metadata?.waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
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

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const wabaId = account.account_metadata?.waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
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

      // Get conversation stats from messaging_cache
      const { data: cacheData, error: cacheError } = await adminClient
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", social_account_id)
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

      const { data, error } = await adminClient
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", social_account_id)
        .eq("platform", "whatsapp")
        .order("last_message_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      const conversations = (data || []).map((c: any) => ({
        id: c.conversation_id,
        participant_name: c.participant_name || "Unknown",
        participant_id: c.conversation_id.replace(`wa_${social_account_id}_`, "").replace(/^wa_\d+_/, ""),
        participant_avatar: c.participant_avatar || null,
        last_message: c.last_message_preview || "",
        last_message_time: c.last_message_at,
        last_message_from: c.participant_name || "",
        unread_count: c.unread_count || 0,
        updated_time: c.updated_at,
      }));

      return jsonResponse({ conversations });
    }

    // ACTION: whatsapp_get_messages
    if (action === "whatsapp_get_messages") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      // Normalize conversation_id to handle both with and without '+' prefix
      const normalizedConvId = conversation_id.replace(/_\+/g, "_");

      const { data: msgs, error: msgsError } = await adminClient
        .from("whatsapp_messages")
        .select("*")
        .eq("social_account_id", social_account_id)
        .or(`conversation_id.eq.${normalizedConvId},conversation_id.eq.${conversation_id}`)
        .order("timestamp", { ascending: true })
        .limit(100);

      if (msgsError) throw msgsError;

      // Format to match the Message interface expected by ConversationDetail
      const messages = (msgs || []).map((m: any) => ({
        id: m.id,
        message: m.message_text || "",
        from: { name: m.from_name || m.from_phone || "Unknown", id: m.from_phone || "" },
        to: [{ name: "", id: m.to_phone || "" }],
        created_time: m.timestamp,
        attachments: m.media_url ? [{ file_url: m.media_url }] : [],
      }));

      return jsonResponse({ messages });
    }

    // ACTION: whatsapp_mark_read
    if (action === "whatsapp_mark_read") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      const { error } = await adminClient
        .from("messaging_cache")
        .update({ unread_count: 0 })
        .eq("social_account_id", social_account_id)
        .eq("conversation_id", conversation_id);

      if (error) throw error;
      return jsonResponse({ success: true });
    }

    // ACTION: whatsapp_send_media
    if (action === "whatsapp_send_media") {
      const { social_account_id, recipient_phone, media_url, media_type, caption } = body;
      if (!social_account_id || !recipient_phone || !media_url) throw new Error("social_account_id, recipient_phone, and media_url required");

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const phoneNumberId = account.platform_user_id;
      const url = `${GRAPH_API}/${phoneNumberId}/messages`;
      const token = getWhatsAppToken(account);

      const mType = media_type || "document";
      const mediaObj: any = { link: media_url };
      if (caption && (mType === "image" || mType === "video" || mType === "document")) {
        mediaObj.caption = caption;
      }
      if (mType === "document") {
        mediaObj.filename = media_url.split("/").pop() || "file";
      }

      const payload = {
        messaging_product: "whatsapp",
        to: recipient_phone,
        type: mType,
        [mType]: mediaObj,
      };

      const data = await sendWhatsAppWithRetry(url, token, payload, phoneNumberId);
      const sentMessageId = data.messages?.[0]?.id;

      // Store outbound media message
      const normalizedPhone = recipient_phone.replace(/^\+/, "");
      const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: user!.id,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
        message_text: caption || `[${mType}]`,
        message_type: mType,
        media_url: media_url,
        media_type: mType,
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: user!.id,
        social_account_id,
        phone_number_id: phoneNumberId,
        recipient_phone,
        preview: caption || `[${mType}]`,
      });

      return jsonResponse({ success: true, message_id: sentMessageId, data });
    }
    if (action === "whatsapp_send_interactive") {
      const { social_account_id, recipient_phone, interactive } = body;
      if (!social_account_id || !recipient_phone || !interactive) throw new Error("social_account_id, recipient_phone, and interactive required");

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const phoneNumberId = account.platform_user_id;
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
        user_id: user!.id,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipient_phone,
      });

      // Make conversation appear in inbox + auto-save contact
      await upsertOutboundConversation(adminClient, {
        user_id: user!.id,
        social_account_id,
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

      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");

      const wabaId = account.account_metadata?.waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
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
      const account = await getAccountToken(social_account_id);
      if (account.platform !== "whatsapp") throw new Error("Account is not a WhatsApp Business account");
      const wabaId = account.account_metadata?.waba_id || Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID");
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
      const account = await getAccountToken(social_account_id);
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
      const account = await getAccountToken(social_account_id);
      const phoneNumberId = account.account_metadata?.phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
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
      const account = await getAccountToken(social_account_id);
      const phoneNumberId = account.account_metadata?.phone_number_id || Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
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
