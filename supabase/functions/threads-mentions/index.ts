import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { buildMentionEnvelope, dispatchN8nEvent } from "../_shared/n8nMessagingDispatch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface ThreadsMentionApiRow {
  id: string;
  text?: string;
  timestamp?: string;
  permalink?: string;
  username?: string;
  media_type?: string;
  user?: { id?: string; username?: string };
}

function classifyMetaError(
  err: { code?: number; message?: string; type?: string } | undefined,
): "missing_permission" | "token_invalid" | "api_failed" {
  if (!err) return "api_failed";
  const msg = (err.message || "").toLowerCase();
  if (
    err.code === 10 ||
    msg.includes("permission") ||
    msg.includes("scope") ||
    msg.includes("approved")
  ) {
    return "missing_permission";
  }
  if (err.code === 190 || msg.includes("token") || msg.includes("expired")) {
    return "token_invalid";
  }
  return "api_failed";
}

// =============================================================================
// V2 helpers
// =============================================================================

interface MinimalMention {
  id: string;
  user_id: string;
  social_account_id: string;
  mention_id: string;
  mention_author_username: string | null;
  mention_text: string | null;
  mention_permalink: string | null;
  mentioned_at: string | null;
  status: string;
  sentiment: string;
  labels: string[];
  assigned_to: string | null;
  source: string;
  notified_at: string | null;
}

/**
 * Insert an in-app system_notifications row for a fresh mention.
 * Idempotent: skipped when mention.notified_at is already set, then stamps it.
 */
async function createMentionNotification(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  mention: MinimalMention,
): Promise<void> {
  if (mention.notified_at) return;
  try {
    const author = mention.mention_author_username || "someone";
    const { error: insErr } = await supabase
      .from("system_notifications")
      .insert({
        title: "New Threads mention",
        message: `@${author} mentioned your Threads account`,
        type: "engagement",
        priority: "normal",
        target_type: "user",
        target_users: [mention.user_id],
        action_label: "View",
        action_url: "/messaging/thread",
        published_at: new Date().toISOString(),
        dismissible: true,
        metadata: {
          source: "threads_mentions",
          mention_id: mention.id,
          social_account_id: mention.social_account_id,
        },
      });
    if (insErr) {
      console.error("createMentionNotification insert failed", insErr.message);
      return;
    }
    await supabase
      .from("threads_mentions")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", mention.id);
  } catch (err) {
    console.error("createMentionNotification error", (err as Error).message);
  }
}

/**
 * Fire-and-forget n8n webhook dispatch. Mirrors process-post / n8n-api pattern.
 */
function asyncFire(p: Promise<unknown>): void {
  // deno-lint-ignore no-explicit-any
  const er: any = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(p);
  } else {
    p.catch((e) => console.error("asyncFire error", e));
  }
}

// =============================================================================
// Main entry
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { action, social_account_id } = body || {};

    if (!action || typeof action !== "string") {
      return jsonResponse({ error: "missing_action" }, 400);
    }

    const { userId } = await authenticateCaller(req, body.user_id);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // -----------------------------------------------------------------------
    // refresh — fetch from Threads API + upsert (status-preserve)
    // -----------------------------------------------------------------------
    if (action === "refresh") {
      if (!social_account_id || typeof social_account_id !== "string") {
        return jsonResponse({ error: "missing_social_account_id" }, 400);
      }

      const { data: account, error: accountErr } = await supabase
        .from("social_accounts")
        .select("id, user_id, platform, platform_user_id, platform_username, access_token, token_expires_at, is_active")
        .eq("id", social_account_id)
        .maybeSingle();

      if (accountErr || !account) {
        return jsonResponse({ error: "no_threads_account" }, 404);
      }
      if (account.user_id !== userId) {
        return jsonResponse({ error: "unauthorized" }, 403);
      }
      if (account.platform !== "threads" || !account.is_active) {
        return jsonResponse({ error: "no_threads_account" }, 400);
      }
      if (!account.access_token) {
        return jsonResponse({ error: "token_missing" }, 400);
      }
      if (
        account.token_expires_at &&
        new Date(account.token_expires_at).getTime() < Date.now()
      ) {
        return jsonResponse({ error: "token_missing", reason: "expired" }, 400);
      }

      const fields =
        "id,media_type,text,timestamp,permalink,username,user{id,username}";
      const url =
        `https://graph.threads.net/v1.0/me/mentions?fields=${fields}&access_token=${encodeURIComponent(account.access_token)}`;

      const apiRes = await fetch(url);
      const apiJson = await apiRes.json().catch(() => ({}));

      console.log(JSON.stringify({
        event: "threads_mentions_fetch",
        user_id: userId,
        social_account_id,
        ok: apiRes.ok,
        status: apiRes.status,
        rows: Array.isArray(apiJson?.data) ? apiJson.data.length : 0,
        error_code: apiJson?.error?.code,
      }));

      if (!apiRes.ok || apiJson?.error) {
        const kind = classifyMetaError(apiJson?.error);
        if (kind === "missing_permission") {
          return jsonResponse({
            error: "missing_permission",
            scope: "threads_manage_mentions",
            detail: apiJson?.error?.message,
          }, 200);
        }
        if (kind === "token_invalid") {
          return jsonResponse({ error: "token_missing", detail: apiJson?.error?.message }, 200);
        }
        return jsonResponse({ error: "threads_api_failed", detail: apiJson?.error?.message || "Unknown error" }, 200);
      }

      const rawRows: ThreadsMentionApiRow[] = Array.isArray(apiJson?.data) ? apiJson.data : [];
      const nowIso = new Date().toISOString();

      // Fetch profile pictures for unique mention authors (best-effort).
      const authorAvatarMap = new Map<string, string | null>();
      const uniqueAuthorIds = Array.from(
        new Set(rawRows.map((r) => r.user?.id).filter((v): v is string => !!v))
      );
      await Promise.all(
        uniqueAuthorIds.map(async (authorId) => {
          try {
            const profUrl =
              `https://graph.threads.net/v1.0/${encodeURIComponent(authorId)}?fields=threads_profile_picture_url&access_token=${encodeURIComponent(account.access_token!)}`;
            const profRes = await fetch(profUrl);
            const profJson = await profRes.json().catch(() => ({}));
            if (profRes.ok && typeof profJson?.threads_profile_picture_url === "string") {
              const raw = profJson.threads_profile_picture_url as string;
              const cached = await cacheAvatarToCloudinary(
                raw,
                userId,
                "threads-author",
                authorId,
              );
              authorAvatarMap.set(authorId, cached ?? raw);
            } else {
              authorAvatarMap.set(authorId, null);
            }
          } catch (_e) {
            authorAvatarMap.set(authorId, null);
          }
        })
      );

      // Read existing rows so we never overwrite user-edited workflow fields.
      const mentionIds = rawRows.map((r) => r.id).filter(Boolean);
      const existingMap = new Map<string, {
        status: string;
        sentiment: string;
        labels: string[];
        assigned_to: string | null;
        assigned_at: string | null;
        assigned_by: string | null;
        has_reply: boolean;
        reply_text: string | null;
        reply_platform_post_id: string | null;
        reply_permalink: string | null;
        replied_at: string | null;
        replied_by: string | null;
        reply_error: string | null;
        notified_at: string | null;
        mention_author_avatar_url: string | null;
      }>();
      if (mentionIds.length > 0) {
        const { data: existing } = await supabase
          .from("threads_mentions")
          .select("mention_id, status, sentiment, labels, assigned_to, assigned_at, assigned_by, has_reply, reply_text, reply_platform_post_id, reply_permalink, replied_at, replied_by, reply_error, notified_at, mention_author_avatar_url")
          .eq("social_account_id", social_account_id)
          .in("mention_id", mentionIds);
        for (const row of existing || []) {
          existingMap.set(row.mention_id, {
            status: row.status,
            sentiment: row.sentiment ?? "unknown",
            labels: Array.isArray(row.labels) ? row.labels : [],
            assigned_to: row.assigned_to ?? null,
            assigned_at: row.assigned_at ?? null,
            assigned_by: row.assigned_by ?? null,
            has_reply: !!row.has_reply,
            reply_text: row.reply_text ?? null,
            reply_platform_post_id: row.reply_platform_post_id ?? null,
            reply_permalink: row.reply_permalink ?? null,
            replied_at: row.replied_at ?? null,
            replied_by: row.replied_by ?? null,
            reply_error: row.reply_error ?? null,
            notified_at: row.notified_at ?? null,
            mention_author_avatar_url: (row as any).mention_author_avatar_url ?? null,
          });
        }
      }

      const upsertRows = rawRows.map((r) => {
        const prev = existingMap.get(r.id);
        return {
          user_id: userId,
          social_account_id,
          threads_media_id: r.id,
          mention_id: r.id,
          mention_author_id: r.user?.id ?? null,
          mention_author_username: r.user?.username ?? r.username ?? null,
          mention_author_avatar_url:
            (r.user?.id ? authorAvatarMap.get(r.user.id) ?? null : null) ??
            prev?.mention_author_avatar_url ??
            null,
          mention_text: r.text ?? null,
          mention_permalink: r.permalink ?? null,
          mentioned_at: r.timestamp ?? null,
          status: prev?.status ?? "new",
          sentiment: prev?.sentiment ?? "unknown",
          labels: prev?.labels ?? [],
          assigned_to: prev?.assigned_to ?? null,
          assigned_at: prev?.assigned_at ?? null,
          assigned_by: prev?.assigned_by ?? null,
          has_reply: prev?.has_reply ?? false,
          reply_text: prev?.reply_text ?? null,
          reply_platform_post_id: prev?.reply_platform_post_id ?? null,
          reply_permalink: prev?.reply_permalink ?? null,
          replied_at: prev?.replied_at ?? null,
          replied_by: prev?.replied_by ?? null,
          reply_error: prev?.reply_error ?? null,
          notified_at: prev?.notified_at ?? null,
          source: prev ? "manual" : "manual",
          last_synced_at: nowIso,
          raw_response: r as unknown as Record<string, unknown>,
        };
      });

      if (upsertRows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("threads_mentions")
          .upsert(upsertRows, { onConflict: "social_account_id,mention_id" });
        if (upsertErr) {
          console.error("threads_mentions_upsert_failed", upsertErr);
          return jsonResponse({ error: "db_upsert_failed", detail: upsertErr.message }, 500);
        }
      }

      // Re-read so we have ids + know which rows are brand new (notified_at null)
      const { data: mentions } = await supabase
        .from("threads_mentions")
        .select("*")
        .eq("social_account_id", social_account_id)
        .order("mentioned_at", { ascending: false, nullsFirst: false })
        .limit(200);

      // For each newly inserted mention (no prior existingMap entry, no notified_at)
      // → fire notification + n8n event
      for (const m of (mentions || []) as MinimalMention[]) {
        const wasExisting = existingMap.has(m.mention_id);
        if (!wasExisting && !m.notified_at) {
          asyncFire(createMentionNotification(supabase, m));
          asyncFire(dispatchN8nEvent(supabase, userId, buildMentionEnvelope("threads.mention.created", m.social_account_id, m)));
        }
      }

      const unread_count =
        (mentions || []).filter((m: { status: string }) => m.status === "new").length;

      return jsonResponse({
        success: true,
        mentions: mentions || [],
        unread_count,
        fetched: rawRows.length,
      });
    }

    // -----------------------------------------------------------------------
    // update_status (V1, kept)
    // -----------------------------------------------------------------------
    if (action === "update_status") {
      const { mention_id, status } = body;
      if (!mention_id || typeof mention_id !== "string") {
        return jsonResponse({ error: "missing_mention_id" }, 400);
      }
      if (!status || !["new", "read", "archived", "replied"].includes(status)) {
        return jsonResponse({ error: "invalid_status" }, 400);
      }
      const { error: updErr } = await supabase
        .from("threads_mentions")
        .update({ status })
        .eq("id", mention_id)
        .eq("user_id", userId);
      if (updErr) {
        return jsonResponse({ error: "update_failed", detail: updErr.message }, 500);
      }
      return jsonResponse({ success: true });
    }

    // -----------------------------------------------------------------------
    // update_meta — sentiment / labels / assignment
    // -----------------------------------------------------------------------
    if (action === "update_meta") {
      const { mention_id, sentiment, labels, assigned_to } = body;
      if (!mention_id || typeof mention_id !== "string") {
        return jsonResponse({ error: "missing_mention_id" }, 400);
      }

      const { data: current, error: curErr } = await supabase
        .from("threads_mentions")
        .select("*")
        .eq("id", mention_id)
        .maybeSingle();
      if (curErr || !current) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (current.user_id !== userId) {
        return jsonResponse({ error: "unauthorized" }, 403);
      }

      // deno-lint-ignore no-explicit-any
      const patch: Record<string, any> = {};
      const events: string[] = [];

      if (sentiment !== undefined) {
        if (!["positive", "neutral", "negative", "unknown"].includes(sentiment)) {
          return jsonResponse({ error: "invalid_sentiment" }, 400);
        }
        if (sentiment !== current.sentiment) {
          patch.sentiment = sentiment;
          events.push("threads.mention.sentiment_updated");
        }
      }
      if (labels !== undefined) {
        if (!Array.isArray(labels) || labels.some((l) => typeof l !== "string")) {
          return jsonResponse({ error: "invalid_labels" }, 400);
        }
        const normalized = Array.from(
          new Set(labels.map((l: string) => l.trim().toLowerCase()).filter(Boolean)),
        ).slice(0, 10);
        const prevSorted = [...(current.labels || [])].sort().join(",");
        const newSorted = [...normalized].sort().join(",");
        if (prevSorted !== newSorted) {
          patch.labels = normalized;
          events.push("threads.mention.labeled");
        }
      }
      if (assigned_to !== undefined) {
        const next: string | null = assigned_to === null || assigned_to === "" ? null : String(assigned_to);
        if (next !== current.assigned_to) {
          patch.assigned_to = next;
          patch.assigned_at = next ? new Date().toISOString() : null;
          patch.assigned_by = next ? userId : null;
          events.push("threads.mention.assigned");
        }
      }

      if (Object.keys(patch).length === 0) {
        return jsonResponse({ success: true, mention: current, no_change: true });
      }

      const { data: updated, error: updErr } = await supabase
        .from("threads_mentions")
        .update(patch)
        .eq("id", mention_id)
        .select("*")
        .maybeSingle();
      if (updErr || !updated) {
        return jsonResponse({ error: "update_failed", detail: updErr?.message }, 500);
      }

      for (const ev of events) {
        asyncFire(dispatchN8nEvent(supabase, userId, buildMentionEnvelope(ev, (updated as MinimalMention).social_account_id, updated as MinimalMention)));
      }

      return jsonResponse({ success: true, mention: updated });
    }

    // -----------------------------------------------------------------------
    // reply — invokes threads-comment then persists reply state
    // -----------------------------------------------------------------------
    if (action === "reply") {
      const { mention_id, text } = body;
      if (!mention_id || typeof mention_id !== "string") {
        return jsonResponse({ error: "missing_mention_id" }, 400);
      }
      if (!social_account_id || typeof social_account_id !== "string") {
        return jsonResponse({ error: "missing_social_account_id" }, 400);
      }
      const replyText = String(text || "").trim();
      if (!replyText) {
        return jsonResponse({ error: "empty_text" }, 400);
      }
      if (replyText.length > 500) {
        return jsonResponse({ error: "text_too_long", limit: 500 }, 400);
      }

      const { data: mention, error: mErr } = await supabase
        .from("threads_mentions")
        .select("*")
        .eq("id", mention_id)
        .maybeSingle();
      if (mErr || !mention) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (mention.user_id !== userId) {
        return jsonResponse({ error: "unauthorized" }, 403);
      }
      if (mention.social_account_id !== social_account_id) {
        return jsonResponse({ error: "account_mismatch" }, 400);
      }
      const targetThreadId = mention.threads_media_id || mention.mention_id;
      if (!targetThreadId) {
        return jsonResponse({ error: "no_thread_id" }, 400);
      }

      // Forward the caller's user JWT so threads-comment can resolve the user.
      const userAuthHeader = req.headers.get("Authorization") ?? "";
      const commentRes = await fetch(`${SUPABASE_URL}/functions/v1/threads-comment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": userAuthHeader,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          thread_id: targetThreadId,
          text: replyText,
          social_account_id,
        }),
      });
      const commentJson = await commentRes.json().catch(() => ({}));

      if (!commentJson?.ok) {
        const errMsg = commentJson?.message || "Threads reply failed";
        await supabase
          .from("threads_mentions")
          .update({ reply_error: String(errMsg).slice(0, 500) })
          .eq("id", mention_id);
        return jsonResponse({
          error: "reply_failed",
          reason: commentJson?.reason || "unknown",
          detail: errMsg,
          needsReauth: !!commentJson?.needsReauth,
          needsPermission: !!commentJson?.needsPermission,
        }, 200);
      }

      const replyId: string | undefined = commentJson?.comment_id;
      const replyPermalink: string | undefined = commentJson?.permalink;
      const nowIso = new Date().toISOString();

      const { data: updated, error: updErr } = await supabase
        .from("threads_mentions")
        .update({
          has_reply: true,
          reply_text: replyText,
          reply_platform_post_id: replyId ?? null,
          reply_permalink: replyPermalink ?? null,
          replied_at: nowIso,
          replied_by: userId,
          reply_error: null,
          status: "replied",
        })
        .eq("id", mention_id)
        .select("*")
        .maybeSingle();
      if (updErr) {
        return jsonResponse({ error: "persist_failed", detail: updErr.message }, 500);
      }

      asyncFire(dispatchN8nEvent(supabase, userId, buildMentionEnvelope("threads.mention.replied", (updated as MinimalMention).social_account_id, updated as MinimalMention)));

      return jsonResponse({ success: true, mention: updated });
    }

    return jsonResponse({ error: "unknown_action" }, 400);
  } catch (err) {
    console.error("threads-mentions error:", err);
    const msg = (err as Error).message || "Internal error";
    if (msg.toLowerCase().includes("unauthorized") || msg.toLowerCase().includes("authorization")) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
