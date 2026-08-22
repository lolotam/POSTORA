// Meta Threads webhook receiver — verifies signature + upserts mentions.
// GET = hub.challenge verification. POST = mention events.
// Mirrors whatsapp-webhook patterns. verify_jwt = false (public endpoint).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCloudinary } from "../_shared/avatar-cache.ts";
import { runInBackground } from "../_shared/background.ts";
import { resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { isOwnComment } from "../_shared/commentAuthor.ts";
import {
  buildCommentPayload,
  buildMentionEnvelope,
  dispatchN8nEvent,
} from "../_shared/n8nMessagingDispatch.ts";
import { extractThreadsChanges, normalizeThreadsReply } from "./replyEvents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("THREADS_WEBHOOK_VERIFY_TOKEN") || "";
const APP_SECRET = Deno.env.get("THREADS_APP_SECRET") || "";

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!APP_SECRET) {
    console.warn("[threads-webhook] THREADS_APP_SECRET not set — cannot verify signature");
    return false;
  }
  if (!signatureHeader) return false;
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const provided = signatureHeader.slice(expectedPrefix.length);

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const calculated = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (calculated.length !== provided.length) return false;
  // constant-time compare
  let mismatch = 0;
  for (let i = 0; i < calculated.length; i++) {
    mismatch |= calculated.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

interface NormalizedMention {
  threads_user_id: string;
  mention_id: string;
  text: string | null;
  permalink: string | null;
  username: string | null;
  author_id: string | null;
  mentioned_at: string | null;
  raw: Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
function normalizeMentionEvent(value: any, recipientId: string | null): NormalizedMention | null {
  if (!value) return null;
  const mention_id =
    value.media_id ||
    value.id ||
    value.mention_id ||
    value.comment_id ||
    null;
  if (!mention_id) return null;

  const threads_user_id = String(
    recipientId ||
      value.recipient_id ||
      value.target_user_id ||
      value.user_id ||
      "",
  );
  if (!threads_user_id) return null;

  const ts = value.created_time || value.timestamp;
  let mentioned_at: string | null = null;
  if (typeof ts === "number") {
    mentioned_at = new Date(ts * (ts > 1e12 ? 1 : 1000)).toISOString();
  } else if (typeof ts === "string") {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) mentioned_at = d.toISOString();
  }

  return {
    threads_user_id,
    mention_id: String(mention_id),
    text: value.text ?? value.message ?? null,
    permalink: value.permalink ?? null,
    username: value.username ?? value.from?.username ?? null,
    author_id: value.from?.id ?? value.author_id ?? null,
    mentioned_at,
    raw: value,
  };
}

async function createMentionNotification(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  // deno-lint-ignore no-explicit-any
  mention: any,
): Promise<void> {
  if (mention.notified_at) return;
  try {
    const author = mention.mention_author_username || "someone";
    await supabase.from("system_notifications").insert({
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
    await supabase
      .from("threads_mentions")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", mention.id);
  } catch (err) {
    console.error("[threads-webhook] notification failed", (err as Error).message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // Verification challenge
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      console.log("[threads-webhook] verify ok");
      return new Response(challenge ?? "", { status: 200 });
    }
    console.warn("[threads-webhook] verify failed");
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  const valid = await verifySignature(rawBody, sig);
  if (!valid) {
    console.warn("[threads-webhook] invalid signature");
    return new Response("Forbidden", { status: 403 });
  }

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const entries = payload?.entry || [];
  let processed = 0;

  const ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, account_metadata, access_token";

  for (const change of extractThreadsChanges(payload)) {
    if (change.field !== "mentions" && change.field !== "replies") continue;
    const threadsUserId = change.targetId || change.value?.recipient_id || change.value?.root_post?.owner_id;
    if (!threadsUserId) continue;

    const { data: account } = await supabase
      .from("social_accounts")
      .select(ACCOUNT_SELECT)
      .eq("platform", "threads")
      .eq("platform_user_id", String(threadsUserId))
      .eq("is_active", true)
      .maybeSingle();
    if (!account) {
      console.warn(`[threads-webhook] no account for threads_user_id=${threadsUserId}`);
      continue;
    }

    if (change.field === "replies") {
      const normalized = normalizeThreadsReply(change.value);
      if (!normalized) continue;

      // The insert is the idempotency claim: Meta retries deliveries, and only the first
      // one to persist may run the user's workflow.
      const { data: inserted, error: inboxError } = await supabase.from("social_inbox_events").upsert({
        user_id: account.user_id,
        social_account_id: account.id,
        platform: "threads",
        event_type: "comment",
        external_event_id: normalized.comment.id,
        payload: change.value,
      }, { onConflict: "social_account_id,external_event_id", ignoreDuplicates: true }).select("id");
      if (inboxError) {
        console.error("[threads-webhook] inbox persist failed", inboxError.message);
        continue;
      }
      if (!inserted?.length) continue;
      processed += 1;

      if (isOwnComment(account, normalized.author)) {
        console.log(`[threads-webhook] skipped own reply ${normalized.comment.id}`);
        continue;
      }
      if (resolveCommentAutomationHandler(account.account_metadata) !== "n8n") continue;

      await runInBackground("threads reply dispatch", () => dispatchN8nEvent(
        supabase,
        account.user_id,
        buildCommentPayload({ platform: "threads", socialAccountId: account.id, account, ...normalized }),
      ));
      continue;
    }

    const norm = normalizeMentionEvent(change.value, change.targetId);
    if (!norm) continue;


    // Check if exists
    const { data: existing } = await supabase
      .from("threads_mentions")
      .select("id, notified_at, mention_author_avatar_url")
      .eq("social_account_id", account.id)
      .eq("mention_id", norm.mention_id)
      .maybeSingle();

    const nowIso = new Date().toISOString();

    // Best-effort: fetch mention author's profile picture from Threads API.
    let authorAvatarUrl: string | null = null;
    if (norm.author_id && account.access_token) {
      try {
        const profUrl =
          `https://graph.threads.net/v1.0/${encodeURIComponent(norm.author_id)}?fields=threads_profile_picture_url&access_token=${encodeURIComponent(account.access_token)}`;
        const profRes = await fetch(profUrl);
        const profJson = await profRes.json().catch(() => ({}));
        if (profRes.ok && typeof profJson?.threads_profile_picture_url === "string") {
          const raw = profJson.threads_profile_picture_url as string;
          const cached = await cacheAvatarToCloudinary(
            raw,
            account.user_id,
            "threads-author",
            norm.author_id,
          );
          authorAvatarUrl = cached ?? raw;
        }
      } catch (_e) {
        authorAvatarUrl = null;
      }
    }
    // Preserve any prior avatar URL so an empty fetch doesn't wipe it out.
    if (!authorAvatarUrl && (existing as any)?.mention_author_avatar_url) {
      authorAvatarUrl = (existing as any).mention_author_avatar_url;
    }

    const upsertRow = {
      user_id: account.user_id,
      social_account_id: account.id,
      threads_media_id: norm.mention_id,
      mention_id: norm.mention_id,
      mention_author_id: norm.author_id,
      mention_author_username: norm.username,
      mention_author_avatar_url: authorAvatarUrl,
      mention_text: norm.text,
      mention_permalink: norm.permalink,
      mentioned_at: norm.mentioned_at,
      source: "webhook",
      last_synced_at: nowIso,
      raw_response: norm.raw as unknown as Record<string, unknown>,
    };

    const { data: upserted, error: upErr } = await supabase
      .from("threads_mentions")
      .upsert(upsertRow, { onConflict: "social_account_id,mention_id" })
      .select("*")
      .maybeSingle();
    if (upErr) {
      console.error("[threads-webhook] upsert err", upErr.message);
      continue;
    }
    processed += 1;

    // Notify + n8n only when row was newly created
    const isNew = !existing;
    if (isNew && upserted) {
      await createMentionNotification(supabase, upserted);
      await runInBackground("threads mention dispatch", async () => {
        await dispatchN8nEvent(supabase, account.user_id, buildMentionEnvelope("threads.mention.created", account.id, upserted));
        // A mention is also a comment-shaped event, so subscribers of the unified
        // comment.received stream get it too — but only when this account routes
        // comments to n8n, and never when the account mentioned itself.
        if (
          resolveCommentAutomationHandler(account.account_metadata) === "n8n" &&
          !isOwnComment(account, { id: norm.author_id || null, username: norm.username || null })
        ) {
          await dispatchN8nEvent(supabase, account.user_id, buildCommentPayload({
            platform: "threads",
            socialAccountId: account.id,
            account,
            comment: {
              id: norm.mention_id,
              kind: "mention",
              text: norm.text || "",
              parentCommentId: null,
              mediaUrl: norm.permalink || null,
            },
            post: { id: null, url: null, caption: null },
            author: { id: norm.author_id || null, name: null, username: norm.username || null },
            timestamp: norm.mentioned_at || undefined,
          }));
        }
      });
    }
  }

  return new Response(JSON.stringify({ success: true, processed }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
