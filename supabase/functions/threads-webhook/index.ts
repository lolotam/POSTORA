// Meta Threads webhook receiver — verifies signature, then hands mentions and replies to
// the shared ingest door. GET = hub.challenge verification. POST = mention/reply events.
//
// Not the only source of Threads comments, and not the reliable one: Meta's Threads
// Webhooks product offers only `replies` and `delete` (there is no `mentions` field — that
// permission unlocks a GET, not a subscription), and `replies` has never delivered here.
// threads-poll-replies covers the same ground by polling; both go through
// ingestThreadsComment so a comment seen twice still fires once.
// Mirrors whatsapp-webhook patterns. verify_jwt = false (public endpoint).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cacheAvatarToCdn } from "../_shared/avatar-cache.ts";
import { runInBackground } from "../_shared/background.ts";
import { ingestThreadsComment } from "../_shared/threadsCommentIngest.ts";
import {
  buildMentionEnvelope,
  dispatchN8nEvent,
} from "../_shared/n8nMessagingDispatch.ts";
import { extractThreadsChanges, normalizeThreadsReply, threadsUserIdFor } from "./replyEvents.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hub-signature-256",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("THREADS_WEBHOOK_VERIFY_TOKEN") || "";
const APP_SECRET = Deno.env.get("THREADS_APP_SECRET") || "";

// Each rejection reason needs a different fix, so they are reported separately rather than
// collapsed into one "invalid signature" line: `missing-header` is an unsigned probe and is
// noise, while `mismatch` on a real Meta delivery means THREADS_APP_SECRET belongs to a
// different app -- and telling those apart from the log is the whole point when the next
// failure is a webhook that silently delivers nothing.
type SignatureCheck = "ok" | "no-secret" | "missing-header" | "malformed-header" | "mismatch";

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<SignatureCheck> {
  if (!APP_SECRET) return "no-secret";
  if (!signatureHeader) return "missing-header";
  const expectedPrefix = "sha256=";
  if (!signatureHeader.startsWith(expectedPrefix)) return "malformed-header";
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
  if (calculated.length !== provided.length) return "mismatch";
  // constant-time compare
  let mismatch = 0;
  for (let i = 0; i < calculated.length; i++) {
    mismatch |= calculated.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0 ? "ok" : "mismatch";
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
    // The token comes from THREADS_WEBHOOK_VERIFY_TOKEN. When it is unset this branch is
    // unconditional, so the Meta App Dashboard can never verify the callback and the
    // account receives no `replies` or `mentions` deliveries at all.
    console.warn(`[threads-webhook] verify failed (verify_token configured: ${VERIFY_TOKEN ? "yes" : "no"})`);
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  const check = await verifySignature(rawBody, sig);
  if (check !== "ok") {
    console.warn(`[threads-webhook] rejected POST: ${check}`);
    return new Response("Forbidden", { status: 403 });
  }

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[threads-webhook] rejected POST: body is not JSON");
    return new Response("Bad request", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let processed = 0;

  const ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, account_metadata, access_token";

  // Everything that turns a delivery away above this point names itself in the log. The
  // three skips below did not, so a delivery Meta recorded as successful could vanish here
  // and leave nothing at all to read -- which is what made "Meta never sent it" and "we
  // received it and dropped it" indistinguishable. Shapes only: no comment text, no author.
  const changes = extractThreadsChanges(payload);
  if (changes.length === 0) {
    console.warn(
      `[threads-webhook] delivery parsed 0 changes (object=${payload?.object ?? "none"}, top-level keys: ${
        Object.keys(payload ?? {}).join(", ") || "none"
      })`,
    );
  }

  for (const change of changes) {
    if (change.field !== "mentions" && change.field !== "replies") {
      console.warn(`[threads-webhook] ignoring field '${change.field}' -- only mentions and replies are handled`);
      continue;
    }
    const threadsUserId = threadsUserIdFor(change);
    if (!threadsUserId) {
      console.warn(
        `[threads-webhook] '${change.field}' delivery carried no threads user id (value keys: ${
          Object.keys(change.value ?? {}).join(", ") || "none"
        })`,
      );
      continue;
    }

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
      const normalized = normalizeThreadsReply(change.value, account.platform_username);
      if (!normalized) {
        console.warn(
          `[threads-webhook] replies delivery for ${threadsUserId} had no reply id (value keys: ${
            Object.keys(change.value ?? {}).join(", ") || "none"
          })`,
        );
        continue;
      }

      // Dedupe, own-comment suppression and handler routing all live in the ingest door, so
      // that a reply Meta delivers and the same reply threads-poll-replies reads back from
      // Graph cannot both run the workflow. Whichever arrives first claims it.
      const outcome = await ingestThreadsComment(supabase, account, normalized, { rawPayload: change.value });
      // A repeat is normal — Meta retries, and the poller covers the same ground — but it is
      // the difference between "the workflow ran once" and "nothing happened", so say which.
      console.log(`[threads-webhook] reply ${normalized.comment.id}: ${outcome}`);
      if (outcome !== "duplicate" && outcome !== "persist_failed") processed += 1;
      continue;
    }

    const norm = normalizeMentionEvent(change.value, change.targetId);
    if (!norm) {
      console.warn(
        `[threads-webhook] mentions delivery had no usable id or user (value keys: ${
          Object.keys(change.value ?? {}).join(", ") || "none"
        })`,
      );
      continue;
    }


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
        // Bounded: this runs inside Meta's webhook request, which Meta retries when we are
        // slow, so a hanging profile lookup would turn one mention into repeated deliveries.
        const profRes = await fetch(profUrl, { signal: AbortSignal.timeout(5_000) });
        const profJson = await profRes.json().catch(() => ({}));
        if (profRes.ok && typeof profJson?.threads_profile_picture_url === "string") {
          const raw = profJson.threads_profile_picture_url as string;
          const cached = await cacheAvatarToCdn(
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
        // Unconditional and outside the ingest door: this legacy envelope predates the comment
        // shape and has its own live subscribers, whose delivery must not start depending on
        // an automation handler they never set.
        await dispatchN8nEvent(supabase, account.user_id, buildMentionEnvelope("threads.mention.created", account.id, upserted));

        // A mention is also a comment-shaped event, so it feeds the same automation as a
        // reply. Routing it through the shared door is what keeps a mention that is *also* a
        // reply — the same id arriving from the mentions field and from the poller — to a
        // single fire.
        await ingestThreadsComment(supabase, account, {
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
        }, { rawPayload: change.value });
      });
    }
  }

  return new Response(JSON.stringify({ success: true, processed }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
