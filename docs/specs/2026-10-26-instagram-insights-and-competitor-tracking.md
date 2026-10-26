# Spec: Instagram insights and competitor tracking

**Date:** 2026-10-26
**Status:** Draft. Not implemented. Nothing in the codebase has been changed for this spec.
**Origin:** `docs/meta-analytics-gap.ar.md` (gap analysis, same date)
**Base ref read:** `origin/ccr-f0848f64-lbmmrr` @ `1a6429a6`. All `file:line` references below are from that ref.
**Required reading for the implementer:** `ARCHITECTURE.md` §3 (feature structure), §12–16 (edge function shape, auth, validation, errors), §17 (logging), §23 (migrations and RLS), §26 (external HTTP), §27–28 (background and scheduled work), §33 (testing), §37 (tokens), §38 (quotas). `CLAUDE.md` deployment rules apply.

---

## ملخص بالعربي

التعديلات على 4 مراحل:

| المرحلة | إيه اللي هيتعمل | المدة | محتاج مراجعة من Meta؟ |
|---|---|---|---|
| **0** | إصلاح Business Discovery في `brand-scrape`: يختار الحساب الصح، ويطلب `view_count` و`media_product_type`، ويضيف `instagram_manage_insights` لربط فيسبوك | يوم | لأ |
| **1** | تحليلات حسابك: جدولين جداد، وcron يومي يسحب Insights لكل بوست وللحساب، وصفحة أداء، وInstagram في `get_post_analytics` | 5–8 أيام | لأ |
| **2** | قايمة منافسين ثابتة، ولقطة يومية لكل منافس وبوستاته | 3–4 أيام | لأ |
| **3** | Outlier score: أداء كل بوست مقارنةً بـ median الحساب، ليك وللمنافسين | 1–2 يوم | لأ |
| مؤجل | Hashtag Search وAd Library API وInsights صفحات فيسبوك | — | Hashtag محتاج Instagram Public Content Access |

كل الصلاحيات المطلوبة للمراحل 0 لـ 3 واخدة **Advanced access granted** في App Dashboard (`instagram_manage_insights` و`instagram_business_manage_insights` و`pages_read_engagement` و`instagram_basic` و`instagram_business_basic`). الشغل كله كود.

الاختبارات في §8 والرحلات (user journeys) في §9 مكتوبين كقوايم جاهزة تتحول لملفات اختبار وملفات journeys بعد التنفيذ.

---

## 1. Problem

1. **Owner insights do not exist** for Instagram or Facebook, although the app requests and holds Advanced Access for `instagram_manage_insights`, `instagram_business_manage_insights` and `read_insights`. App Dashboard shows `Ready to use (0)` for both Instagram insights permissions. MCP `get_post_analytics` (`supabase/functions/mcp/index.ts:459`, `supabase/functions/n8n-api/serviceProxy.ts:233`) supports only Threads and TikTok.
2. **Competitor analysis through the official API almost never runs.**
   - `brand-scrape` picks a viewer account with `.eq("ig_auth_type", "facebook_page")` only (`supabase/functions/brand-scrape/index.ts:549`).
   - `facebook_page` accounts come from `facebook-oauth`, whose scopes (`supabase/functions/facebook-oauth/index.ts:20`) do not include `instagram_manage_insights`. Business Discovery requires it.
   - `instagram-business-oauth` does request it (`supabase/functions/instagram-business-oauth/index.ts:37`), but saves accounts as `facebook_business` (`:213`). `brand-scrape` ignores that type.
   - The `instagram_manage_insights` API-call count of 0 in App Dashboard is consistent with this. Instagram results most likely come from Apify.
3. **Business Discovery requests the wrong view field.** `scrapeInstagramOfficial` (`brand-scrape/index.ts:14`) asks for `video_view_count`. The current IG Media reference documents `view_count` (Public, Reels, paid + organic, Business Discovery only). Reel views are probably always 0. It also maps every `VIDEO` to `REEL` instead of reading `media_product_type`.
4. **No metric history.** Competitor data lives only in `brand_scrape_cache` (1-hour TTL) and `brand_scrape_sessions` (search history). Nothing stores numbers over time, so growth and outlier scores cannot be computed.

## 2. Goals

- G1. Business Discovery works for every user who has any page-linked Instagram account with `instagram_manage_insights` granted.
- G2. Daily owner insights for every active Instagram account, per media and per account, stored as dated snapshots.
- G3. A per-user competitor watchlist with daily profile and media snapshots from the official API.
- G4. An outlier score for own and competitor posts.
- G5. Instagram supported in `get_post_analytics` (MCP and n8n API).

## 3. Non-goals

- Searching all of Instagram by topic, region or language, or discovering unknown accounts. No official API exists. Keep using the vidIQ connector for this.
- Building or extending a scraping index. Apify stays an admin-controlled fallback only (§6.4).
- Hashtag Search (needs the **Instagram Public Content Access** feature, which the app does not have).
- Ad Library API (commercial ads return only if they reached the EU; low value for the Gulf).
- Facebook Page insights (`read_insights` is granted; separate spec later).
- Migrating the 56 `graph.facebook.com/v18.0` calls (separate task).

## 4. Meta facts this spec relies on

Verified against Meta docs on 2026-10-26. Links in §12.

| Fact | Consequence |
|---|---|
| Business Discovery is available only with Facebook Login and needs `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`. | The viewer must be a page-linked account (`facebook_page` or `facebook_business`), never `business_login`. |
| Business Discovery returns Business/Creator accounts only; age-gated accounts are not returned. | Clear error for personal, private or age-gated usernames. |
| IG Media `view_count` is Public, Reels only, paid + organic, available only via Business Discovery. `like_count` is omitted when the owner hides likes. `media_product_type` is Public, Facebook Login only. | Store `view_count` and `like_count` as nullable. Never coerce a missing value to 0. |
| Media insights: `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions` (FEED, REELS); `follows`, `profile_visits`, `profile_activity` (FEED, STORY); `ig_reels_avg_watch_time` (REELS). `impressions` is deprecated for media after 2024-07-02. No insights for album children. Data can lag 48 h; kept 2 years; unavailable data returns an empty set, not 0. Story metrics live 24 h. | Metric list depends on product type (§6.2.3). Empty means null. |
| Account insights: `reach`, `views`, `accounts_engaged`, `total_interactions`, `likes`, `comments`, `saves`, `shares`, `replies`, `reposts`, `profile_links_taps`, `follows_and_unfollows` (period `day`, mostly `total_value`). `impressions` is deprecated from v22.0. Without `since`/`until` the API looks back 24 h. Some metrics need 100+ followers. | Pull one day at a time for yesterday. |
| Insights permissions: Facebook Login uses `instagram_basic` + `instagram_manage_insights` + `pages_read_engagement` on `graph.facebook.com`. Instagram Login uses `instagram_business_basic` + `instagram_business_manage_insights` on `graph.instagram.com`. | Host and token depend on the account type (§6.2.2). |

## 5. Current state (what exists)

| Area | File |
|---|---|
| IG via Facebook Login scopes | `supabase/functions/facebook-oauth/index.ts:20`, mirrored in `src/hooks/oauth/useFacebookOAuth.ts:59` |
| IG via Facebook Business scopes | `supabase/functions/instagram-business-oauth/index.ts:37` |
| IG Login scopes | `supabase/functions/instagram-oauth/index.ts:34` |
| Direct vs page-linked rule | `isDirectInstagramAccount` in `supabase/functions/_shared/messengerCredentials.ts:17` |
| Competitor lookup | `supabase/functions/brand-scrape/index.ts` (official `:14`, own account `:62`, Apify `:108`, viewer selection `:541–580`) |
| Brand Intelligence UI | `src/pages/BrandIntelligence.tsx`, `src/pages/analytics/InstagramAnalytics.tsx` (competitor search, despite the name), `src/components/brand-intelligence/*` |
| Brand Intelligence tables | `supabase/migrations/20260324013145_58e93514-87ec-4785-befb-d2d740c10819.sql` |
| Published post ids | `platform_posts.platform_post_id` (IG media id set in `supabase/functions/process-post/index.ts:1731`) |
| Analytics proxy | `supabase/functions/n8n-api/serviceProxy.ts:233`, route `n8n-api/index.ts:2581`, rate limit `n8n-api/rateLimitConfig.ts:87` |
| MCP tool and scope | `supabase/functions/mcp/index.ts:459`, `supabase/functions/mcp/toolScopes.ts:84` |
| Cron-invoked function template | `supabase/functions/media-retention/` (`index.ts` → `handler.ts` → `run.ts` with ports → `deps.ts`, a test per file, `verifyCronOrAdmin`) and its cron in `supabase/migrations/20261001100000_media_retention.sql:1093` |
| Shared helpers | `_shared/auth-helper.ts`, `_shared/cron-auth.ts`, `_shared/cors.ts`, `_shared/errorSanitizer.ts`, `_shared/request-timeout.ts` (`fetchWithTimeout`), `_shared/metaErrors.ts` (`parseMetaError`, `isPermanentMetaError`), `_shared/logging.ts` |
| Admin review checklist | `src/pages/admin/oauth-verification/checklist-data/instagram.ts` (missing the two insights permissions) |

---

## 6. Requirements

### Phase 0: fix Business Discovery

**R0.1 Viewer selection.** Extract the viewer choice into a pure function and use it in `brand-scrape` and in the Phase 2 sync.

```ts
// supabase/functions/_shared/instagramDiscoveryViewer.ts
export function pickBusinessDiscoveryViewer(accounts: ViewerCandidate[]): ViewerCandidate | null
```

- Candidates: same `user_id`, `platform = 'instagram'`, `is_active = true`, `needs_reauth` not true, and `isDirectInstagramAccount(account) === false`. Both `facebook_page` and `facebook_business` qualify.
- Prefer accounts whose `account_metadata.granted_scopes` contains `instagram_manage_insights`. Next, accounts with no recorded scopes (unknown). Never pick an account whose recorded scopes exist and lack it.
- Tie-break: most recently `connected_at`.
- Replace the inline query at `brand-scrape/index.ts:541–550`.

**R0.2 Request the permission in the Facebook flow.** Add `instagram_manage_insights` to `FB_OAUTH_SCOPES` (`facebook-oauth/index.ts:20`) and to `src/hooks/oauth/useFacebookOAuth.ts:59`. Both lists must stay identical.

- If `facebook-oauth` does not already persist `granted_scopes` and `scopes_checked_at` in `account_metadata` (as `instagram-business-oauth` does at `:139` and `:224`), add it with the same `/me/permissions` call.
- Existing `facebook_page` accounts keep their old token until the user reconnects. See R0.5.

**R0.3 Correct fields.** In `scrapeInstagramOfficial`:
- Request `view_count` and `media_product_type`. Remove `video_view_count`.
- Map type from `media_product_type`: `REELS` → `REEL`. Otherwise use `media_type` (`IMAGE`, `VIDEO`, `CAROUSEL_ALBUM` → `CAROUSEL`).
- `videoViewCount` comes from `view_count`, `null` when absent. `likesCount` is `null` when `like_count` is absent (hidden likes). Update `calculateEngagementScore` callers to treat `null` as unknown, not 0.
- Move the mapping into a pure `mapBusinessDiscoveryMedia()` so it can be unit-tested.

**R0.4 Pagination.** Follow the `after` cursor of the `media` edge until `maxPosts` is reached. Meta returns `before`/`after` but no `next`. Bound it to at most `ceil(maxPosts / 25)` requests.

**R0.5 Reconnect prompt.** If the user has page-linked IG accounts but none passes R0.1 because recorded scopes lack `instagram_manage_insights`, `brand-scrape` returns a typed error `IG_INSIGHTS_SCOPE_MISSING` before falling back. The UI shows "Reconnect Instagram to enable official competitor data" with the reconnect action.
- Keep the Apify fallback behaviour unchanged when the admin enabled it, but surface the source (R0.6).

**R0.6 Source label.** The `brand-scrape` response carries `source: "official" | "apify" | "graph_own"` (from the existing `strategyUsed`). `ProfileCard` shows an "Official" or "Third-party" badge.

**R0.7 Housekeeping.** Add `instagram_manage_insights` and `instagram_business_manage_insights` to `src/pages/admin/oauth-verification/checklist-data/instagram.ts` as granted.

### Phase 1: owner insights

**R1.1 Tables** (new migration, RLS enabled; see §7 for DDL):
- `ig_media_insight_snapshots`: one row per (account, media, capture date).
- `ig_account_insight_daily`: one row per (account, metric date).
- Owners can `SELECT` their rows. Only service role writes.

**R1.2 Edge function `instagram-insights-sync`.** Copy the `media-retention` layout:

```text
supabase/functions/instagram-insights-sync/
  index.ts      // Deno.serve → handler
  handler.ts    // CORS, auth (verifyCronOrAdmin OR authenticated user for on-demand), zod body, map errors
  run.ts        // use case: runInsightsSync(ports, input) — no fetch, no supabase
  deps.ts       // ports: AccountRepo, SnapshotRepo, InstagramInsightsGateway, Clock, Logger
  graph.ts      // InstagramInsightsGateway implementation (fetchWithTimeout, parseMetaError)
  *.test.ts     // one per file
```

Inputs:
- Cron: `{ mode: "all" }`. Every active IG account, oldest-synced first, capped per run.
- User: `{ mode: "account", social_account_id }`. Ownership verified from the JWT (ARCHITECTURE §14). Rate-limited to one on-demand run per account per 15 minutes.

**R1.2.1 Steps per account:**
1. Resolve host and token (R1.2.2).
2. List media with `GET /{ig-user-id}/media?fields=id,media_type,media_product_type,timestamp,permalink,caption,like_count,comments_count&limit=50`, following `after` while `timestamp` ≥ now − 90 days. At most 4 pages.
3. For each media, call `shouldSnapshot` (R1.2.4). If yes, `GET /{media-id}/insights?metric=<metricsFor(type)>`. Never request breakdowns in a multi-metric call.
4. Upsert into `ig_media_insight_snapshots` on `(social_account_id, ig_media_id, captured_on)`. Re-running the same day overwrites, so the job is idempotent.
5. Account metrics for yesterday (Asia/Kuwait day, converted to Unix `since`/`until`): `GET /{ig-user-id}/insights?metric=reach,views,accounts_engaged,total_interactions,likes,comments,saves,shares,follows_and_unfollows&period=day&metric_type=total_value&since=…&until=…`. Plus `followers_count` and `media_count` from `GET /{ig-user-id}?fields=followers_count,media_count`. Upsert into `ig_account_insight_daily`.
6. Link `post_id` when `platform_posts.platform_post_id = ig_media_id` for the same `social_account_id`. Media published outside Postora keep `post_id = null`.

**R1.2.2 Host and token.** Pure function `resolveInsightsTransport(account)`:
- `isDirectInstagramAccount(account)` → `https://graph.instagram.com/v22.0`, `account.access_token`.
- Otherwise → `https://graph.facebook.com/v22.0`, page token (`account.access_token`, else `account_metadata.page_access_token`).
- Read the version from `FACEBOOK_GRAPH_API_VERSION` with default `v22.0`, as `instagram-business-oauth` does.

**R1.2.3 Metrics by product type.** Pure function `metricsFor(mediaProductType, mediaType)`:

| product type | metrics |
|---|---|
| `FEED` (image, video, carousel parent) | `views,reach,likes,comments,saved,shares,total_interactions,follows,profile_visits` |
| `REELS` | `views,reach,likes,comments,saved,shares,total_interactions,ig_reels_avg_watch_time` |
| `STORY` | `views,reach,shares,follows,profile_visits,replies` |
| `AD` or unknown | skip |

If Meta rejects one metric with an "unsupported metric" error, retry once without the rejected metric and log the metric name. Do not fail the account.

**R1.2.4 Snapshot cadence.** Pure function `shouldSnapshot(publishedAt, lastCapturedOn, today)`:
- age ≤ 7 days: daily
- 8–30 days: every 3 days
- 31–90 days: every 7 days
- \> 90 days: stop

**R1.2.5 Errors** (via `parseMetaError` / `isPermanentMetaError`):
- OAuth 190: mark the account `needs_reauth` the same way the refresh code does. Stop that account.
- Permission error (code 10 or 200 range, "permission"): record `account_metadata.insights_status = "scope_missing"`. Do **not** set `needs_reauth`. Continue with other accounts.
- Empty `data`: store `null` for that metric.
- 429, or `X-Business-Use-Case-Usage` / `X-App-Usage` above 80 %: stop the run and log. The next cron picks up from the oldest `insights_synced_at`.
- 5xx or timeout: at most 2 retries with backoff. These are read-only calls, so retry is safe (ARCHITECTURE §26).
- Never log tokens or full URLs that contain `access_token`.

**R1.2.6 Bookkeeping.** Write `account_metadata.insights_synced_at` and `insights_status` (`ok | scope_missing | reauth | throttled | error`) per account.

**R1.2.7 Run budget.**
- At most 25 accounts per cron run.
- At most 60 media insight calls per account per run.
- Each fetch has a 10 s timeout.

**R1.3 Cron.** New migration that schedules `instagram-insights-sync` daily at 00:30 UTC (03:30 Kuwait) with the same `get_cron_secret()` / `net.http_post` guard pattern as `20261001100000_media_retention.sql:1093`. Make it idempotent (`IF NOT EXISTS … cron.job`).

**R1.4 Stories (optional, Phase 1b).** Stories expire in 24 h, so a daily run misses most of them.
- Option A: a second cron every 4 h that lists `GET /{ig-user-id}/stories` and snapshots their insights.
- Option B: skip stories in v1.
- **Decision needed from Waleed** (§11).

**R1.5 Analytics API.** Extend `handleGetPostAnalytics` (`n8n-api/serviceProxy.ts:233`):
- `account.platform === "instagram"` reads from the two tables. It does **not** call Meta live.
- Returns:
  - `{ account: { daily: [...] }, media: [ latest snapshot per media within period_days, with outlier fields from R3 ] }`
  - `period_days` ∈ {7, 14, 30, 90} (reuse `THREADS_PERIODS`).
  - `data_freshness: { synced_at, lag_note: "Meta data can lag up to 48 hours" }`.
- Update the `unsupported(...)` list and the MCP tool description at `mcp/index.ts:459` to include Instagram. The tool scope stays `posts:read` (`toolScopes.ts:84`).

**R1.6 UI.** New feature folder (ARCHITECTURE §3):

```text
src/features/instagram-insights/
  domain/        // engagementRate(), outlier types (re-exported from R3 contract), period helpers
  application/   // useInstagramInsights query (React Query) → infrastructure
  infrastructure/// supabase reads of the two tables (RLS-scoped, no service role)
  ui/            // InstagramPerformancePage, MediaPerformanceTable, AccountTrendChart, SyncStatusBadge
  tests/
  index.ts
```

- **Route:** add an "Instagram Performance" page. Rename the current `src/pages/analytics/InstagramAnalytics.tsx` nav label to "Instagram Competitors" (or point it at Brand Intelligence). It is a competitor search, and the old name will confuse users once real analytics exist. Keep the old route as a redirect (ARCHITECTURE §36).
- **Table columns:** thumbnail, type (Reel / Carousel / Image / Story), published date, views, reach, likes, comments, saves, shares, engagement rate, outlier label.
- **Filters:** type and period.
- **Empty and partial states:**
  - "First sync runs tonight. Sync now?"
  - "Some metrics need 100+ followers."
  - "Numbers can lag up to 48 hours."
  - "Reconnect needed."
- **Engagement rate** = `(likes + comments + saved + shares) / reach`. `null` when reach is null or 0.

### Phase 2: competitor watchlist

**R2.1 Tables** (§7):
- `competitor_watchlist`
- `competitor_profile_snapshots`
- `competitor_media_snapshots`

Owners can read their own rows, and can insert, update and delete their own watchlist rows. Only service role writes snapshots.

**R2.2 Quota.** The maximum number of active watchlist entries per user comes from the existing plan-quota system (ARCHITECTURE §38, `docs/specs/2026-08-23-unified-plan-quotas.md`). The number is a **decision for Waleed** (§11). Enforce it in the insert path (RPC or trigger), not only in the UI.

**R2.3 Edge function `competitor-snapshot-sync`.** Same layout as R1.2.
- Cron daily at 01:00 UTC.
- On demand: when an entry is added, snapshot it immediately.
- For each active entry:
  1. Viewer from `pickBusinessDiscoveryViewer` (R0.1) for that user.
  2. Business Discovery with fields `id,username,name,followers_count,media_count,profile_picture_url,media.limit(30){id,media_type,media_product_type,timestamp,permalink,caption,like_count,comments_count,view_count}`.
  3. Upsert one profile row and up to 30 media rows for today, with `source = 'official'`.
  4. No viewer, or Business Discovery fails: if admin `apify_enabled` is on, use the existing Apify path with `source = 'apify'`. Otherwise record `last_error` on the entry and skip.
  5. Username not found, not Business, or age-gated: set `status = 'unavailable'` with the reason. Do not retry daily; retry weekly.
- Budget: at most 50 entries per run. Same 80 % usage stop as R1.2.5.

**R2.4 UI.**
- A "Track" button on `ProfileCard` adds the profile to the watchlist.
- New "Competitors" tab in Brand Intelligence:
  - list of tracked accounts with follower growth (7 / 30 days) and posts per week
  - the latest outliers (R3)
  - source badge
  - status (`ok | unavailable | error`)
- Remove from watchlist keeps the snapshot history for 90 days, then a retention job deletes it. The retention job can be added to the existing retention cron.

**R2.5 MCP (optional).**
- New tools `list_competitors` and `get_competitor_report(watchlist_id, period_days)`.
- `toolScopes.ts` fails closed, so each new tool **must** get a scope entry. Use `posts:read` or a new `analytics:read`; that is a decision (§11).
- The connection-mode rules from PR #286 apply: competitor captions are third-party text, so return them with `okUntrusted`.

### Phase 3: outlier score

**R3.1 Single implementation** in `supabase/functions/_shared/outlierScore.ts`. Pure TypeScript with no Deno APIs, so the frontend can import the same logic through a contract re-export, or receive scores from the API. Do not copy the algorithm into `src/`.

```ts
export type OutlierInput = {
  id: string;
  format: "reel" | "non_reel";
  publishedAt: string;
  value: number | null;      // see R3.2
};
export type OutlierResult = {
  id: string;
  score: number | null;      // value / baseline median
  label: "outlier" | "above" | "normal" | "below" | "too_early" | "no_data" | "small_baseline";
  baselineMedian: number | null;
  baselineSize: number;
};
export function computeOutlierScores(items: OutlierInput[], now: Date, opts?: {
  baselineSize?: number;     // default 12
  minBaseline?: number;      // default 6
  minAgeHours?: number;      // default 48
}): OutlierResult[];
```

**R3.2 Value per source:**

| source | reel | non-reel |
|---|---|---|
| own (Phase 1) | `views` | `reach` (fallback `total_interactions`) |
| competitor (Phase 2) | `view_count` | `like_count + comments_count` (`null` if `like_count` is null) |

**R3.3 Rules:**
- Group by `format`. Reels and non-reels never share a baseline.
- The baseline is the previous `baselineSize` items of the same format, **excluding the item itself** and excluding items younger than `minAgeHours`.
- Label thresholds: `score ≥ 3` outlier; `≥ 1.5` above; `≤ 0.5` below; otherwise normal. Item younger than `minAgeHours` → `too_early`. Value `null` → `no_data`. Baseline smaller than `minBaseline` → `small_baseline` with `score = null`.
- Use the latest snapshot of each media.

---

## 7. Data model (DDL sketch)

Final names and types are for the implementer. RLS is mandatory (ARCHITECTURE §23). Regenerate `src/integrations/supabase/types.ts`.

```sql
create table public.ig_media_insight_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  post_id uuid null references public.posts(id) on delete set null,
  ig_media_id text not null,
  media_product_type text null,      -- FEED | REELS | STORY | AD
  media_type text null,              -- IMAGE | VIDEO | CAROUSEL_ALBUM
  permalink text null,
  published_at timestamptz not null,
  captured_on date not null,
  views bigint null, reach bigint null, likes bigint null, comments bigint null,
  saved bigint null, shares bigint null, total_interactions bigint null,
  follows bigint null, profile_visits bigint null, replies bigint null,
  ig_reels_avg_watch_time_ms bigint null,
  like_count_public bigint null, comments_count_public bigint null,
  created_at timestamptz not null default now(),
  unique (social_account_id, ig_media_id, captured_on)
);
create index on public.ig_media_insight_snapshots (user_id, published_at desc);

create table public.ig_account_insight_daily (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  metric_date date not null,
  followers_count bigint null, media_count bigint null,
  reach bigint null, views bigint null, accounts_engaged bigint null,
  total_interactions bigint null, likes bigint null, comments bigint null,
  saves bigint null, shares bigint null, follows bigint null, unfollows bigint null,
  created_at timestamptz not null default now(),
  unique (social_account_id, metric_date)
);

create table public.competitor_watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null default 'instagram' check (platform in ('instagram')),
  username text not null,            -- lower-case, no '@'
  label text null,
  is_active boolean not null default true,
  status text not null default 'pending', -- pending | ok | unavailable | error
  last_error text null,
  last_synced_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (user_id, platform, username)
);

create table public.competitor_profile_snapshots (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.competitor_watchlist(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  captured_on date not null,
  followers_count bigint null, media_count bigint null,
  source text not null check (source in ('official','apify')),
  unique (watchlist_id, captured_on)
);

create table public.competitor_media_snapshots (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references public.competitor_watchlist(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ig_media_id text not null,
  captured_on date not null,
  media_product_type text null, media_type text null,
  published_at timestamptz not null, permalink text null, caption text null,
  like_count bigint null, comments_count bigint null, view_count bigint null,
  source text not null check (source in ('official','apify')),
  unique (watchlist_id, ig_media_id, captured_on)
);
-- RLS on all five: select using (auth.uid() = user_id); writes service-role only,
-- except competitor_watchlist insert/update/delete using (auth.uid() = user_id) + quota check.
```

`user_id` is denormalised on the snapshot tables so RLS needs no join. The sync must set it from the owning account or entry, never from a request body.

---

## 8. Test plan

Follow ARCHITECTURE §33. Deno tests sit next to the file (`*.test.ts`), SQL tests go in `supabase/tests/`, UI tests in `__tests__/`, and E2E in `e2e/`. The **Regression** column marks tests that pin the Phase 0 bugs.

### 8.1 Domain (pure, fast)

| ID | Unit | Case | Regression |
|---|---|---|---|
| D1 | `pickBusinessDiscoveryViewer` | `facebook_business` with scope granted is chosen when no `facebook_page` exists | ✅ |
| D2 | same | `business_login` (direct) account is never chosen | |
| D3 | same | recorded scopes without `instagram_manage_insights` are skipped; unknown scopes rank below granted | |
| D4 | same | inactive or `needs_reauth` accounts are skipped; ties go to the newest `connected_at` | |
| D5 | `mapBusinessDiscoveryMedia` | `media_product_type: REELS` → `REEL`, `view_count` → `videoViewCount` | ✅ |
| D6 | same | missing `like_count` → `likesCount: null`, not 0 | |
| D7 | same | `VIDEO` with `media_product_type: FEED` stays `VIDEO` | ✅ |
| D8 | `metricsFor` | each product type returns exactly the §R1.2.3 list; `AD` returns empty | |
| D9 | `shouldSnapshot` | boundaries at 7, 8, 30, 31, 90, 91 days; same-day re-run returns true (idempotent overwrite) | |
| D10 | `resolveInsightsTransport` | direct → graph.instagram.com + own token; page-linked → graph.facebook.com + page token; page token taken from metadata when `access_token` is empty | |
| D11 | `computeOutlierScores` | median baseline excludes the item itself | |
| D12 | same | reels and non-reels never mix baselines | |
| D13 | same | item younger than 48 h → `too_early`; null value → `no_data`; baseline < 6 → `small_baseline` | |
| D14 | same | thresholds 3 / 1.5 / 0.5 map to the right labels (test exact boundaries) | |
| D15 | `engagementRate` | reach 0 or null → null | |

### 8.2 Application (use case with fake ports)

| ID | Use case | Case |
|---|---|---|
| A1 | `runInsightsSync` | two media + account metrics → two snapshot upserts + one daily upsert, `insights_status = ok` |
| A2 | same | empty `data` for a metric → stored as null |
| A3 | same | Meta 190 → account marked `needs_reauth`, other accounts still processed |
| A4 | same | permission error → `insights_status = scope_missing`, **not** `needs_reauth` |
| A5 | same | usage header 85 % → run stops, remaining accounts untouched, logged once |
| A6 | same | unsupported metric → one retry without it, account still `ok` |
| A7 | same | per-run caps (25 accounts, 60 media) respected |
| A8 | same | media id that matches `platform_posts.platform_post_id` gets `post_id` linked; other media keep null |
| A9 | same | running twice on the same day produces the same rows (idempotent) |
| A10 | `runCompetitorSync` | viewer present → `source = official` rows |
| A11 | same | no viewer and Apify disabled → entry `status = error`, `last_error` set, no Apify call |
| A12 | same | no viewer and Apify enabled → `source = apify` rows |
| A13 | same | "not a business account" → `status = unavailable`, skipped until a week later |
| A14 | `handleGetPostAnalytics` | instagram account → reads tables, includes outlier fields, does not call Meta |
| A15 | same | another user's `social_account_id` → 404 (ownership) |
| A16 | same | facebook account still returns `unsupported` with the updated platform list |

### 8.3 Infrastructure (adapters with mocked fetch)

| ID | Adapter | Case | Regression |
|---|---|---|---|
| I1 | `scrapeInstagramOfficial` | request URL contains `view_count` and `media_product_type`, does **not** contain `video_view_count` | ✅ |
| I2 | same | follows `after` cursor and stops at `maxPosts` | |
| I3 | `InstagramInsightsGateway` | builds the right host per transport; `metric=` list matches `metricsFor` | |
| I4 | same | timeout → mapped retryable error; 2 retries maximum | |
| I5 | same | logs never contain `access_token` (assert on captured log lines) | |
| I6 | `brand-scrape` handler | user with only `facebook_business` account → official path used, no Apify call | ✅ |
| I7 | same | page-linked accounts all lacking the scope → `IG_INSIGHTS_SCOPE_MISSING` | |

### 8.4 Edge handlers (auth and validation)

| ID | Function | Case |
|---|---|---|
| H1 | `instagram-insights-sync` | no auth → 401; cron secret → runs `mode: all`; user JWT → `mode: account` only for own account |
| H2 | same | user on-demand twice within 15 min → 429 |
| H3 | `competitor-snapshot-sync` | same auth matrix as H1 |
| H4 | `mcp` | `toolScopes.ts` has an entry for every registered tool (existing fail-closed test must still pass with new tools) |

### 8.5 Database (`supabase/tests/*.sql`)

| ID | Case |
|---|---|
| S1 | owner can select own rows in all five tables |
| S2 | other user selects zero rows (cross-user denial) |
| S3 | authenticated user cannot insert or update snapshot tables |
| S4 | owner can insert, update and delete own `competitor_watchlist` rows; quota blocks the N+1th active entry |
| S5 | unique keys reject duplicate (account, media, day) and (watchlist, day) |
| S6 | cron migration is idempotent (running it twice creates one job) |

### 8.6 UI (Testing Library)

| ID | Component | Case |
|---|---|---|
| U1 | `InstagramPerformancePage` | renders table from fixture; type filter works |
| U2 | same | empty state before first sync shows "Sync now" |
| U3 | same | `scope_missing` and `reauth` statuses show the reconnect banner |
| U4 | `ProfileCard` | shows "Official" vs "Third-party" badge from `source` |
| U5 | Competitors tab | "Track" adds an entry; quota error message shown at the limit |
| U6 | outlier label | `too_early` and `small_baseline` render as neutral text, not as a score |

### 8.7 E2E (Playwright)

Extend `e2e/analytics.spec.ts`:
- **E1:** Performance page loads for a seeded account with snapshots.
- **E2:** Competitors tab shows a seeded watchlist with growth numbers.

---

## 9. User journeys (to write as `docs/journeys/` after implementation)

Each journey is written in Arabic after the feature ships, in the format of `docs/journeys/2026-08-30-meta-refresh-and-unsaved-guard.md`. The scenarios to cover:

| ID | Journey | Start | Expected result |
|---|---|---|---|
| J1 | See my Instagram performance | User with an IG account connected by Instagram Login opens Instagram Performance | First visit shows "first sync tonight" + Sync now. After sync: per-post table with views, reach, saves, shares, engagement rate |
| J2 | Reconnect to unlock official competitor data | User whose IG is linked through the old Facebook flow searches a competitor | Banner "Reconnect Instagram". After reconnect, the same search shows the "Official" badge and real reel views |
| J3 | Look up a competitor | User searches `@vaseline_arabia` in Brand Intelligence | Profile + last posts with reel views; source "Official" |
| J4 | Competitor not available | User searches a personal or private account | Clear message "Only Business or Creator accounts can be analysed"; no Apify call unless the admin enabled it |
| J5 | Track a competitor | User clicks Track on a profile | Entry appears in Competitors with today's snapshot; growth appears from the next day |
| J6 | Watchlist limit | User at the plan limit clicks Track | Message with the limit and upgrade path; no row created |
| J7 | Find outliers | User opens Competitors or Performance after 7+ days of data | Posts labelled outlier, above, normal or below; new posts show "too early" |
| J8 | Ask Claude through MCP | User asks Claude "how did my last 30 days on Instagram go" | `get_post_analytics` returns Instagram data with freshness note; no "not supported" error |
| J9 | Token expired | IG token revoked | Next sync marks the account for reconnect; the page shows the reconnect banner; other accounts keep syncing |
| J10 | Small account | Account with fewer than 100 followers | Account-level metrics that need 100+ followers show "needs 100+ followers", not 0 |

---

## 10. Acceptance criteria

- **Phase 0:**
  - `instagram_manage_insights` API calls become > 0 in App Dashboard after deploy and at least one competitor search.
  - Tests I1, I6 and D5 pass.
  - A search for a known Business account returns non-zero reel `view_count`.
- **Phase 1:**
  - After one cron run, every active IG account has `insights_status` set and snapshot rows for its media of the last 90 days that are due.
  - `get_post_analytics` returns Instagram data.
  - `instagram_business_manage_insights` and `instagram_manage_insights` calls appear in App Dashboard.
- **Phase 2:** a tracked competitor gets one profile snapshot and up to 30 media snapshots per day, with `source` set.
- **Phase 3:** outlier labels match the §R3.3 rules on the D11–D14 fixtures.
- **All phases:**
  - the `pnpm`/`npm` checks the repo uses pass
  - edge functions are deployed per `CLAUDE.md` step 7
  - no token appears in logs

## 11. Decisions needed from Waleed

1. **Branch:** which branch receives this work and deploys. Saved notes say the Postora manager session's current branch, never `main`.
2. **Stories:** a 4-hourly story sync (R1.4 option A), or skip stories in v1?
3. **Watchlist quota:** how many competitors per plan (R2.2)?
4. **MCP scope:** do the competitor tools use `posts:read`, or a new `analytics:read` (R2.5)?
5. **Apify:** should the competitor sync ever fall back to Apify, or only the interactive search?

## 12. Sources (Meta, read 2026-10-26)

- Business Discovery: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- IG Media fields: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- IG Media insights: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- IG User insights: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
- Insights overview: https://developers.facebook.com/docs/instagram-platform/insights
- Permissions: https://developers.facebook.com/docs/permissions
