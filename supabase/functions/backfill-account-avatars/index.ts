/**
 * Re-hosts stored account avatars that no longer load.
 *
 * Avatars were cached to a Cloudinary account that has since been disabled, so
 * every URL it wrote returns 401; the handful of rows still holding a raw Meta
 * CDN link return 403 because those signatures expire. Either way the UI falls
 * back to a generic platform glyph, which is what made every account in the
 * selectors look identical.
 *
 * This re-fetches each avatar from the platform with the account's stored token
 * and re-uploads it through the shared cache helper, which now targets
 * Openinary. Safe to re-run: rows whose avatar_url already points at Openinary
 * are skipped unless `force` is set.
 *
 * POST body (all optional):
 *   { "platforms": ["threads","pinterest"], "limit": 100, "dryRun": true, "force": false }
 *
 * Omitting `platforms` covers every platform in AVATAR_FETCHERS below.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import {
  cacheAvatarToCdn,
  fetchBlueskyAvatarUrl,
  fetchFacebookAvatarUrl,
  fetchInstagramAvatarUrl,
  fetchLinkedInAvatarUrl,
  fetchPinterestAvatarUrl,
  fetchRedditAvatarUrl,
  fetchThreadsAvatarUrl,
  fetchTikTokAvatarUrl,
  fetchTwitterAvatarUrl,
  fetchYouTubeAvatarUrl,
} from "../_shared/avatar-cache.ts";
import { getOpeninaryConfig } from "../_shared/openinary.ts";
import { corsHeaders } from "../_shared/cors.ts";

interface AccountRow {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string;
  avatar_url: string | null;
  access_token: string | null;
}

/**
 * One fetcher per platform. Some read the profile straight off the token and
 * take no id; the rest address a specific page, user or actor. Bluesky's
 * `actor` parameter accepts the DID that `platform_user_id` holds, so the same
 * column serves both shapes.
 *
 * A platform absent from this map is never scanned: WhatsApp avatars arrive
 * through the messaging webhooks rather than an OAuth profile call, so there is
 * nothing here to re-fetch them from.
 */
const AVATAR_FETCHERS: Record<string, (account: AccountRow) => Promise<string | null>> = {
  facebook: (a) => fetchFacebookAvatarUrl(a.access_token!, a.platform_user_id),
  instagram: (a) => fetchInstagramAvatarUrl(a.access_token!, a.platform_user_id),
  threads: (a) => fetchThreadsAvatarUrl(a.access_token!, a.platform_user_id),
  bluesky: (a) => fetchBlueskyAvatarUrl(a.access_token!, a.platform_user_id),
  tiktok: (a) => fetchTikTokAvatarUrl(a.access_token!),
  twitter: (a) => fetchTwitterAvatarUrl(a.access_token!),
  linkedin: (a) => fetchLinkedInAvatarUrl(a.access_token!),
  pinterest: (a) => fetchPinterestAvatarUrl(a.access_token!),
  youtube: (a) => fetchYouTubeAvatarUrl(a.access_token!),
  reddit: (a) => fetchRedditAvatarUrl(a.access_token!),
};

const SUPPORTED = new Set(Object.keys(AVATAR_FETCHERS));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await verifyCronOrAdmin(req);
  if (!auth.ok) return auth.response;

  const config = getOpeninaryConfig();
  if (!config) return json({ error: "Openinary is not configured; nothing would be re-hosted" }, 503);

  const body = await req.json().catch(() => ({}));
  const platforms: string[] = Array.isArray(body.platforms)
    ? body.platforms.filter((p: unknown) => typeof p === "string" && SUPPORTED.has(p))
    : [...SUPPORTED];
  const limit = Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 500) : 500;
  const dryRun = body.dryRun === true;
  const force = body.force === true;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data, error } = await supabase
    .from("social_accounts")
    .select("id, user_id, platform, platform_user_id, avatar_url, access_token")
    .in("platform", platforms)
    .eq("is_active", true)
    .limit(limit);

  if (error) return json({ error: error.message }, 500);

  const accounts = (data ?? []) as AccountRow[];
  const results = { scanned: accounts.length, skipped: 0, rehosted: 0, failed: 0, details: [] as unknown[] };

  for (const account of accounts) {
    // Already on the live host: re-fetching would burn a Graph call per account
    // for no gain, and this runs over every connected account.
    if (!force && account.avatar_url?.startsWith(config.serverUrl)) {
      results.skipped += 1;
      continue;
    }
    if (!account.access_token) {
      results.failed += 1;
      results.details.push({ id: account.id, platform: account.platform, error: "no stored access token" });
      continue;
    }

    const fresh = await AVATAR_FETCHERS[account.platform](account);

    if (!fresh) {
      results.failed += 1;
      results.details.push({ id: account.id, platform: account.platform, error: "platform returned no avatar" });
      continue;
    }

    if (dryRun) {
      results.rehosted += 1;
      results.details.push({ id: account.id, platform: account.platform, wouldRehost: true });
      continue;
    }

    const hosted = await cacheAvatarToCdn(fresh, account.user_id, account.platform, account.platform_user_id);

    // cacheAvatarToCdn returns the source URL unchanged when the upload fails.
    // Writing that back would replace a dead Cloudinary link with a Meta link
    // that expires in days, so treat it as a failure and leave the row alone.
    if (!hosted || !hosted.startsWith(config.serverUrl)) {
      results.failed += 1;
      results.details.push({ id: account.id, platform: account.platform, error: "upload did not return a hosted URL" });
      continue;
    }

    const { error: updateError } = await supabase
      .from("social_accounts")
      .update({ avatar_url: hosted })
      .eq("id", account.id);

    if (updateError) {
      results.failed += 1;
      results.details.push({ id: account.id, platform: account.platform, error: updateError.message });
      continue;
    }

    results.rehosted += 1;
  }

  return json({ ok: true, dryRun, ...results });
});
