-- ===========================================================================
-- Task 3b - Instagram insights and competitor tracking: schema slice.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   Task 3b ("remaining schema/quota/jobs"), plan section 5.2.
-- Spec: docs/specs/2026-10-26-instagram-insights-and-competitor-tracking.md
--   Phase 1 (owner insights) and Phase 2 (competitor watchlist), section 7.
--
-- APPLY AS supabase_admin. It owns the tables and the functions below;
-- postgres is not a superuser on this stack, and a REVOKE by a non-owner is a
-- WARNING that changes nothing (same reason as 20260906130000 and
-- 20261026120000).
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   Six additive relations plus the entitlement plumbing they need:
--
--     ig_media_insight_snapshots
--       one row per (account, IG media, capture day) for the owner's own
--       media: the dated metric history the performance report reads.
--
--     ig_account_insight_daily
--       one row per (account, metric day): the account-level interaction
--       aggregation for one provider day.
--
--     ig_account_profile_observations
--       point-in-time follower / media-count observations. Deliberately NOT
--       part of the metric-day table - see "FOLLOWERS ARE NOT A METRIC DAY"
--       below.
--
--     competitor_watchlist
--       the owner's tracked competitor handles, with soft removal.
--
--     competitor_profile_snapshots
--       dated follower / media-count history for one tracked competitor.
--
--     competitor_media_snapshots
--       dated public-count history for one tracked competitor's media.
--
--   plus: max_tracked_competitors on subscription_plans and user_quotas, the
--   service-only entitlement resolver, the owner-facing watchlist RPCs, and
--   the atomic quota enforcement.
--
-- WHAT THIS IS NOT
--
--   * Not the durable job/queue tables. The plan gives those to Task 4, and
--     the trigger that would enforce them does not exist yet.
--   * Not a cron activation. No schedule is created here; the plan requires
--     new schedules to stay inactive until the workers boot.
--   * Not a collector. Nothing in this migration calls Meta, and no metric is
--     ever fabricated: a metric that the provider did not report is NULL,
--     which means "unavailable" and never 0.
--   * Not a change to effective_user_quotas(). Its return shape is
--     untouched - see "QUOTA RESOLUTION" below.
--
-- SECURITY MODEL
--
--   * Every relation: RLS enabled, explicit policies, explicit grants. The
--     default ACLs on this stack grant ALL on new tables to anon,
--     authenticated and service_role, so the REVOKEs below are load-bearing,
--     not decoration.
--   * Owners may SELECT their own rows. Nothing else is owner-writable: the
--     snapshot tables have no INSERT/UPDATE/DELETE grant for any client role
--     at all, and the watchlist is written only through the owner RPCs below.
--   * The service role bypasses RLS, so tenancy is enforced STRUCTURALLY:
--     composite foreign keys bind every snapshot row to an account (or a
--     watchlist entry) that belongs to the same owner, and the optional post
--     reference is bound to the same owner too. A cross-owner row cannot be
--     written by anyone, including the service role.
--   * Parent ownership cannot be moved out from under a snapshot. The
--     composite foreign keys are ON UPDATE NO ACTION: re-parenting an
--     account or a post while snapshots exist is refused, not cascaded.
--   * No credential, token or scope is stored in any of these relations.
--
-- DEVIATIONS FROM THE SPEC SKETCH (section 7), and why
--
--   1. The spec sketch puts followers_count and media_count in
--      ig_account_insight_daily. They are NOT there here. A follower count
--      is a point-in-time observation, and writing today's observation into a
--      historical metric_date row is exactly the mistake the plan's binding
--      clarification 3 forbids ("never copy today's observation into repair
--      rows"). They live in ig_account_profile_observations, keyed by
--      observed_at.
--
--   2. The spec sketch gives the watchlist an owner DELETE. There is none:
--      removal is soft (is_active = false, removed_at = now()) because the
--      90-day history requirement outlives the removal. A hard delete is
--      service-role only, for the retention job that does not exist yet.
--
--   3. The spec sketch lets the owner INSERT/UPDATE/DELETE watchlist rows
--      directly. The owner path here is an RPC, because a plain table write
--      cannot express "this column is the owner's, that column is the
--      server's" - and the plan requires exactly that separation.
--
--   4. The spec sketch has no provider window columns. ig_account_insight_daily
--      carries provider_date, period_start, period_end and provider_timezone,
--      because the provider's aggregation bucket is NOT verified to be the
--      Kuwait day and a row that claims a day it cannot describe is a lie.
--      Until the provider window is verified, those columns stay NULL and the
--      collector stays disabled.
--
-- QUOTA RESOLUTION
--
--   The approved entitlement (plan section 12) is Free 5 / Pro 20 /
--   Business 30 / admin unlimited, counted as CONCURRENT ACTIVE ENTRIES per
--   owner - not as a daily allowance and not as a provider-call budget.
--
--   effective_user_quotas() is NOT changed: its return shape is a contract
--   other code reads, and the plan forbids altering it. A separate resolver,
--   effective_competitor_quota(uuid), resolves the competitor entitlement
--   with the SAME precedence and the SAME deterministic plan selection
--   (override -> active/past_due subscribed plan -> free fallback), so the
--   two paths cannot disagree about which plan a user is on.
--
--   The admin bypass is NOT inside the resolver. It lives at the two places
--   where it means something: the enforcement boundary (the trigger) and the
--   owner read boundary (read_own_competitor_quota()). A resolver that
--   silently answered "unlimited" for an admin would make the stored
--   entitlement unreadable and would hide a misconfigured admin override.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. Parent prerequisites.
--
-- The composite foreign keys below need a UNIQUE (id, user_id) on their
-- parents. social_accounts already carries UNIQUE (id, user_id, platform)
-- (20261026120000 uses it), but a two-column key is what the ownership
-- contract needs here, and posts carries no such key at all - it only has
-- the primary key on id.
--
-- The keys are additive (a unique index on an already-unique id), and they
-- make re-parenting impossible while children exist, which is the point:
-- an account or a post that changes hands must not silently leave its
-- snapshots behind under the old owner.
--
-- This block is idempotent ONLY for an exact parent key: an immediate,
-- valid, non-partial unique index whose key columns are (id, user_id) in
-- that order. The match is by attribute name. indkey is an int2vector,
-- zero-based, so indkey::smallint[] = ARRAY[...] is false even when the
-- columns are the same pair (the literal is one-based). That comparison
-- must not be used here: it would try to add the constraint again.
--
-- A constraint that already uses the name this block would create, but is
-- not that exact key, is a hard error. Skipping it would hide schema drift.
--
-- The migration as a whole is NOT replayable. The six tables further down
-- are created unconditionally. A second run of this file fails there
-- instead of papering over a drifted table.
-- ===========================================================================

DO $prereq$
DECLARE
  v_table text;
  v_constraint text;
  v_exact boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['social_accounts', 'posts'] LOOP
    v_constraint := v_table || '_id_user_id_key';

    SELECT EXISTS (
             SELECT 1
               FROM pg_index i
              WHERE i.indrelid = format('public.%I', v_table)::regclass
                AND i.indisunique
                AND i.indisvalid
                AND i.indimmediate
                AND i.indnkeyatts = 2
                AND i.indpred IS NULL
                AND (
                      SELECT array_agg(a.attname::text ORDER BY k.ord)
                        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord)
                        JOIN pg_attribute a
                          ON a.attrelid = i.indrelid
                         AND a.attnum = k.attnum
                         AND a.attnum > 0
                         AND NOT a.attisdropped
                    ) = ARRAY['id', 'user_id']::text[]
           )
      INTO v_exact;

    IF v_exact THEN
      CONTINUE;
    ELSIF EXISTS (
            SELECT 1
              FROM pg_constraint
             WHERE conrelid = format('public.%I', v_table)::regclass
               AND conname = v_constraint
          ) THEN
      RAISE EXCEPTION
        '% exists but is not an immediate valid non-partial UNIQUE (id, user_id)',
        v_constraint;
    ELSE
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (id, user_id)',
        v_table, v_constraint);
    END IF;
  END LOOP;
END
$prereq$;

-- ===========================================================================
-- 2. The competitor entitlement columns.
--
-- NULL means INHERIT, exactly like every other limit column in this schema
-- (20260823140000 dropped the DEFAULTs for that reason: a default would
-- silently pin a user to a number that was never an admin's decision).
-- -1 means unlimited.
--
-- COALESCE on the seed UPDATEs below keeps an administrator-edited value
-- if those statements run again. That is not a replay of this migration:
-- the CREATE TABLE statements further down are unconditional, and a second
-- run of the file rolls back at the first of them.
-- ===========================================================================

DO $quota_cols_add$
DECLARE
  v_table text;
  v_type regtype;
  v_not_null boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['subscription_plans', 'user_quotas'] LOOP
    SELECT a.atttypid::regtype, a.attnotnull
      INTO v_type, v_not_null
      FROM pg_attribute a
     WHERE a.attrelid = format('public.%I', v_table)::regclass
       AND a.attname = 'max_tracked_competitors'
       AND NOT a.attisdropped;

    IF v_type IS NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN max_tracked_competitors integer',
        v_table);
    ELSIF v_type <> 'integer'::regtype OR v_not_null THEN
      RAISE EXCEPTION
        '%.max_tracked_competitors must be a nullable integer (NULL means inherit); found %',
        v_table, coalesce(v_type::text, 'missing');
    END IF;
  END LOOP;
END
$quota_cols_add$;

-- Belt and braces: a DEFAULT on the override column would invent an
-- override for every row that is inserted from here on.
ALTER TABLE public.user_quotas
  ALTER COLUMN max_tracked_competitors DROP DEFAULT;

DO $quota_cols$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'subscription_plans_max_tracked_competitors_chk'
           AND conrelid = 'public.subscription_plans'::regclass
       ) THEN
    ALTER TABLE public.subscription_plans
      ADD CONSTRAINT subscription_plans_max_tracked_competitors_chk
      CHECK (max_tracked_competitors IS NULL
             OR max_tracked_competitors = -1
             OR max_tracked_competitors >= 0);
  END IF;

  IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'user_quotas_max_tracked_competitors_chk'
           AND conrelid = 'public.user_quotas'::regclass
       ) THEN
    ALTER TABLE public.user_quotas
      ADD CONSTRAINT user_quotas_max_tracked_competitors_chk
      CHECK (max_tracked_competitors IS NULL
             OR max_tracked_competitors = -1
             OR max_tracked_competitors >= 0);
  END IF;
END
$quota_cols$;

COMMENT ON COLUMN public.subscription_plans.max_tracked_competitors IS
  'Maximum CONCURRENT ACTIVE tracked Instagram competitors per owner. '
  'NULL = inherit/unset, -1 = unlimited. Resolved through '
  'effective_competitor_quota(); never read directly.';

COMMENT ON COLUMN public.user_quotas.max_tracked_competitors IS
  'Per-owner override for the tracked-competitor limit. NULL = inherit from '
  'the plan, -1 = unlimited. A non-null value wins over the plan in both '
  'directions, like every other override in this schema.';

-- Approved defaults (plan section 12). COALESCE per column, so an
-- administrator-edited value survives if these UPDATEs run again.
UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 5)
 WHERE slug = 'free';

UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 20)
 WHERE slug = 'pro';

UPDATE public.subscription_plans
   SET max_tracked_competitors = COALESCE(max_tracked_competitors, 30)
 WHERE slug = 'business';

-- ===========================================================================
-- 3. Owner media insight snapshots.
--
-- One row per (account, IG media id, capture day). Re-running the collector
-- on the same day overwrites the row (the unique key is the natural key of
-- the upsert), so a same-day re-sync is idempotent.
--
-- The metric columns are NULLABLE and are never coerced: a metric the
-- provider did not report is NULL, which means "unavailable". A zero is a
-- real zero and stays a zero.
--
-- captured_on is the collector's capture DAY (Kuwait, the scheduler and
-- display timezone). captured_at is the actual capture instant. They are
-- separate columns because a row's day and its timestamp answer different
-- questions, and because a repair pass must never relabel one as the other.
-- ===========================================================================

CREATE TABLE public.ig_media_insight_snapshots (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL,
  social_account_id          uuid NOT NULL,
  post_id                    uuid,
  ig_media_id                text NOT NULL,
  media_product_type         text,
  media_type                 text,
  product                    text,
  thumbnail_url              text,
  caption                    text,
  permalink                  text,
  published_at               timestamptz NOT NULL,
  captured_on                date NOT NULL,
  captured_at                timestamptz NOT NULL DEFAULT now(),
  capture_timezone           text NOT NULL DEFAULT 'Asia/Kuwait',
  views                      bigint,
  reach                      bigint,
  likes                      bigint,
  comments                   bigint,
  saved                      bigint,
  shares                     bigint,
  total_interactions         bigint,
  follows                    bigint,
  profile_visits             bigint,
  replies                    bigint,
  ig_reels_avg_watch_time_ms bigint,
  like_count_public          bigint,
  comments_count_public      bigint,
  status                     text NOT NULL DEFAULT 'ok',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  -- The ownership binding. A row cannot name an account that belongs to a
  -- different owner, whatever the writer's role: the service role bypasses
  -- RLS, so this constraint is the tenancy boundary.
  --
  -- ON UPDATE NO ACTION is deliberate. Re-parenting an account while
  -- snapshots exist is refused: the alternative - cascading the snapshots to
  -- the new owner - would hand one user's history to another.
  CONSTRAINT ig_media_insight_snapshots_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  -- The optional Postora post. A composite foreign key to posts(id, user_id)
  -- keeps the post and the snapshot under the same owner, and SET NULL
  -- (post_id) nulls ONLY the optional reference when the post is deleted:
  -- the required owner column is untouched, so the snapshot survives its
  -- post and keeps its history.
  CONSTRAINT ig_media_insight_snapshots_post_owner_fkey
    FOREIGN KEY (post_id, user_id)
    REFERENCES public.posts (id, user_id)
    ON DELETE SET NULL (post_id)
    ON UPDATE NO ACTION,

  CONSTRAINT ig_media_insight_snapshots_capture_key
    UNIQUE (social_account_id, ig_media_id, captured_on),

  CONSTRAINT ig_media_insight_snapshots_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT ig_media_insight_snapshots_product_type_chk
    CHECK (media_product_type IS NULL
           OR media_product_type IN ('FEED', 'REELS', 'STORY', 'AD')),
  CONSTRAINT ig_media_insight_snapshots_media_type_chk
    CHECK (media_type IS NULL
           OR media_type IN ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')),
  CONSTRAINT ig_media_insight_snapshots_media_id_chk
    CHECK (char_length(btrim(ig_media_id)) > 0 AND char_length(ig_media_id) <= 255),
  CONSTRAINT ig_media_insight_snapshots_capture_timezone_chk
    CHECK (char_length(capture_timezone) > 0 AND char_length(capture_timezone) <= 64),
  CONSTRAINT ig_media_insight_snapshots_views_chk        CHECK (views IS NULL OR views >= 0),
  CONSTRAINT ig_media_insight_snapshots_reach_chk        CHECK (reach IS NULL OR reach >= 0),
  CONSTRAINT ig_media_insight_snapshots_likes_chk        CHECK (likes IS NULL OR likes >= 0),
  CONSTRAINT ig_media_insight_snapshots_comments_chk     CHECK (comments IS NULL OR comments >= 0),
  CONSTRAINT ig_media_insight_snapshots_saved_chk        CHECK (saved IS NULL OR saved >= 0),
  CONSTRAINT ig_media_insight_snapshots_shares_chk       CHECK (shares IS NULL OR shares >= 0),
  CONSTRAINT ig_media_insight_snapshots_total_chk
    CHECK (total_interactions IS NULL OR total_interactions >= 0),
  CONSTRAINT ig_media_insight_snapshots_follows_chk      CHECK (follows IS NULL OR follows >= 0),
  CONSTRAINT ig_media_insight_snapshots_profile_visits_chk
    CHECK (profile_visits IS NULL OR profile_visits >= 0),
  CONSTRAINT ig_media_insight_snapshots_replies_chk      CHECK (replies IS NULL OR replies >= 0),
  CONSTRAINT ig_media_insight_snapshots_watch_time_chk
    CHECK (ig_reels_avg_watch_time_ms IS NULL OR ig_reels_avg_watch_time_ms >= 0),
  CONSTRAINT ig_media_insight_snapshots_like_count_chk
    CHECK (like_count_public IS NULL OR like_count_public >= 0),
  CONSTRAINT ig_media_insight_snapshots_comments_count_chk
    CHECK (comments_count_public IS NULL OR comments_count_public >= 0)
);

CREATE INDEX idx_ig_media_insight_snapshots_owner_published
  ON public.ig_media_insight_snapshots (user_id, published_at DESC);
CREATE INDEX idx_ig_media_insight_snapshots_account_captured
  ON public.ig_media_insight_snapshots (social_account_id, captured_on DESC);
CREATE INDEX idx_ig_media_insight_snapshots_owner_captured
  ON public.ig_media_insight_snapshots (user_id, captured_on DESC);
CREATE INDEX idx_ig_media_insight_snapshots_owner_media
  ON public.ig_media_insight_snapshots (user_id, ig_media_id, captured_on DESC);
CREATE INDEX idx_ig_media_insight_snapshots_post
  ON public.ig_media_insight_snapshots (post_id, user_id) WHERE post_id IS NOT NULL;

COMMENT ON TABLE public.ig_media_insight_snapshots IS
  'Dated insight snapshots for the owner''s own Instagram media, one row per '
  '(account, media, capture day). Service-write-only; the owner may SELECT '
  'their own rows. A NULL metric means the provider did not report it - '
  'never 0.';

COMMENT ON COLUMN public.ig_media_insight_snapshots.post_id IS
  'Optional link to the Postora post that published this media. Set only '
  'from an owned platform_posts lookup that resolves to exactly one post; '
  'see resolve_ig_media_post_link(). NULL for media published outside '
  'Postora.';

COMMENT ON COLUMN public.ig_media_insight_snapshots.status IS
  'pending = reserved, not captured yet; ok = captured (a NULL metric is '
  'still "the provider did not report it"); unavailable = the provider '
  'explicitly reported the data as unavailable; error = a recorded failed '
  'attempt. Only ok counts as a successful capture.';

-- ===========================================================================
-- 4. Account insight, one row per metric day.
--
-- The provider's aggregation window is stored, not assumed. period_start,
-- period_end and provider_timezone describe what the provider actually
-- returned; until the provider window is verified they stay NULL and the
-- collector stays disabled. A row must never claim a Kuwait day it cannot
-- describe.
--
-- followers_count and media_count are NOT here: they are observations, not
-- interactions, and they live in ig_account_profile_observations.
--
-- follows and unfollows are separate nullable columns because the provider
-- reports them through a follow_type breakdown. A missing breakdown stays
-- NULL; it is not summed into a total and not turned into 0.
-- ===========================================================================

CREATE TABLE public.ig_account_insight_daily (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  social_account_id  uuid NOT NULL,
  metric_date        date NOT NULL,
  provider_date      date NOT NULL,
  period_start       timestamptz,
  period_end         timestamptz,
  provider_timezone  text,
  reach              bigint,
  views              bigint,
  accounts_engaged   bigint,
  total_interactions bigint,
  likes              bigint,
  comments           bigint,
  saves              bigint,
  shares             bigint,
  follows            bigint,
  unfollows          bigint,
  status             text NOT NULL DEFAULT 'ok',
  captured_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ig_account_insight_daily_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT ig_account_insight_daily_day_key
    UNIQUE (social_account_id, metric_date),

  CONSTRAINT ig_account_insight_daily_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT ig_account_insight_daily_period_chk
    CHECK (period_start IS NULL OR period_end IS NULL OR period_end > period_start),
  CONSTRAINT ig_account_insight_daily_provider_timezone_chk
    CHECK (provider_timezone IS NULL
           OR (char_length(provider_timezone) > 0 AND char_length(provider_timezone) <= 64)),
  CONSTRAINT ig_account_insight_daily_reach_chk      CHECK (reach IS NULL OR reach >= 0),
  CONSTRAINT ig_account_insight_daily_views_chk      CHECK (views IS NULL OR views >= 0),
  CONSTRAINT ig_account_insight_daily_engaged_chk    CHECK (accounts_engaged IS NULL OR accounts_engaged >= 0),
  CONSTRAINT ig_account_insight_daily_total_chk      CHECK (total_interactions IS NULL OR total_interactions >= 0),
  CONSTRAINT ig_account_insight_daily_likes_chk      CHECK (likes IS NULL OR likes >= 0),
  CONSTRAINT ig_account_insight_daily_comments_chk   CHECK (comments IS NULL OR comments >= 0),
  CONSTRAINT ig_account_insight_daily_saves_chk      CHECK (saves IS NULL OR saves >= 0),
  CONSTRAINT ig_account_insight_daily_shares_chk     CHECK (shares IS NULL OR shares >= 0),
  CONSTRAINT ig_account_insight_daily_follows_chk    CHECK (follows IS NULL OR follows >= 0),
  CONSTRAINT ig_account_insight_daily_unfollows_chk  CHECK (unfollows IS NULL OR unfollows >= 0)
);

CREATE INDEX idx_ig_account_insight_daily_owner_date
  ON public.ig_account_insight_daily (user_id, metric_date DESC);
CREATE INDEX idx_ig_account_insight_daily_account_date
  ON public.ig_account_insight_daily (social_account_id, metric_date DESC);

COMMENT ON TABLE public.ig_account_insight_daily IS
  'Account-level Instagram interaction metrics, one row per (account, metric '
  'day). Carries the provider window that produced the row. Follower and '
  'media counts are NOT here - they are observations and live in '
  'ig_account_profile_observations.';

COMMENT ON COLUMN public.ig_account_insight_daily.metric_date IS
  'The calendar day this row describes.';
COMMENT ON COLUMN public.ig_account_insight_daily.provider_date IS
  'The provider''s own bucket label for the aggregation that produced this '
  'row. It is recorded, not assumed to equal metric_date.';
COMMENT ON COLUMN public.ig_account_insight_daily.provider_timezone IS
  'The timezone the provider window is expressed in. NULL until verified.';

-- ===========================================================================
-- 5. Point-in-time profile observations.
--
-- FOLLOWERS ARE NOT A METRIC DAY. A follower count is true at one instant,
-- so it is keyed by observed_at and never folded into a historical metric
-- day. This is the separation the plan's binding clarification 3 requires:
-- "never copy today''s observation into repair rows".
--
-- Several observations per day are allowed and are the point: growth is
-- measured between two observations, not between two day buckets.
-- ===========================================================================

CREATE TABLE public.ig_account_profile_observations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  social_account_id uuid NOT NULL,
  observed_at       timestamptz NOT NULL,
  observed_on       date NOT NULL,
  capture_timezone  text NOT NULL DEFAULT 'Asia/Kuwait',
  followers_count   bigint,
  media_count       bigint,
  status            text NOT NULL DEFAULT 'ok',
  captured_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ig_account_profile_observations_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT ig_account_profile_observations_observation_key
    UNIQUE (social_account_id, observed_at),

  CONSTRAINT ig_account_profile_observations_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT ig_account_profile_observations_followers_chk
    CHECK (followers_count IS NULL OR followers_count >= 0),
  CONSTRAINT ig_account_profile_observations_media_chk
    CHECK (media_count IS NULL OR media_count >= 0),
  CONSTRAINT ig_account_profile_observations_capture_timezone_chk
    CHECK (char_length(capture_timezone) > 0 AND char_length(capture_timezone) <= 64)
);

CREATE INDEX idx_ig_account_profile_observations_owner_observed
  ON public.ig_account_profile_observations (user_id, observed_at DESC);
CREATE INDEX idx_ig_account_profile_observations_account_observed
  ON public.ig_account_profile_observations (social_account_id, observed_at DESC);
CREATE INDEX idx_ig_account_profile_observations_account_day
  ON public.ig_account_profile_observations (social_account_id, observed_on);

COMMENT ON TABLE public.ig_account_profile_observations IS
  'Point-in-time follower and media-count observations for the owner''s own '
  'Instagram account. Keyed by observed_at so a follower count is never '
  'written into a historical metric day.';

-- ===========================================================================
-- 6. The competitor watchlist.
--
-- The owner tracks competitor handles. The handle is the identity: it is
-- normalised (trim, no @, lower case) and validated in the database, it is
-- unique per (owner, platform, username), and it is immutable afterwards.
-- A different handle is a different row with its own history - relabelling
-- a tracked handle would silently rewrite what the old snapshots observed.
--
-- Removal is soft. There is no owner DELETE at all, because the snapshot
-- history has to outlive the removal by 90 days.
-- ===========================================================================

CREATE TABLE public.competitor_watchlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  platform        text NOT NULL DEFAULT 'instagram',
  username        text NOT NULL,
  label           text,
  is_active       boolean NOT NULL DEFAULT true,
  removed_at      timestamptz,
  status          text NOT NULL DEFAULT 'pending',
  last_error      text,
  last_error_code text,
  last_synced_at  timestamptz,
  next_retry_at   timestamptz,
  source          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT competitor_watchlist_user_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,

  CONSTRAINT competitor_watchlist_platform_chk
    CHECK (platform = 'instagram'),

  -- The Instagram handle rules: 1-30 characters, letters / digits /
  -- periods / underscores, no consecutive periods. The provider stays the
  -- authority on whether the handle EXISTS and is analysable; this only
  -- rejects a shape the provider could never have issued.
  CONSTRAINT competitor_watchlist_username_chk
    CHECK (username ~ '^[a-z0-9._]{1,30}$' AND username !~ '\.\.'),

  CONSTRAINT competitor_watchlist_label_chk
    CHECK (label IS NULL OR char_length(label) <= 120),
  CONSTRAINT competitor_watchlist_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT competitor_watchlist_source_chk
    CHECK (source IS NULL OR source IN ('official', 'apify')),
  CONSTRAINT competitor_watchlist_last_error_chk
    CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT competitor_watchlist_last_error_code_chk
    CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 100),

  -- Active rows are not removed. Inactive rows always carry the removal
  -- instant the retention job keys on. The guard trigger fills a missing
  -- marker with now() on insert and on a fresh deactivation; it does not
  -- invent an earlier time, and it does not move the first marker on a
  -- later label or bookkeeping update.
  CONSTRAINT competitor_watchlist_removal_chk
    CHECK ((is_active AND removed_at IS NULL)
           OR ((NOT is_active) AND removed_at IS NOT NULL)),

  -- Uniqueness is per owner and per platform: two owners may track the same
  -- competitor, and the same owner may not track it twice.
  CONSTRAINT competitor_watchlist_owner_handle_key
    UNIQUE (user_id, platform, username),

  -- Needed by the composite foreign key from the snapshot tables, so a
  -- snapshot row cannot name a watchlist entry owned by somebody else.
  CONSTRAINT competitor_watchlist_id_owner_key
    UNIQUE (id, user_id)
);

CREATE INDEX idx_competitor_watchlist_owner_active
  ON public.competitor_watchlist (user_id, is_active);
CREATE INDEX idx_competitor_watchlist_owner_username
  ON public.competitor_watchlist (user_id, username);

COMMENT ON TABLE public.competitor_watchlist IS
  'Instagram competitor handles an owner tracks. Owner SELECT only; every '
  'write goes through the owner RPCs or the service role. Removal is soft '
  '(is_active = false, removed_at = now()) so the snapshot history survives '
  'the removal.';

COMMENT ON COLUMN public.competitor_watchlist.username IS
  'Normalised Instagram handle: trimmed, no leading @, lower case. '
  'Immutable after insert - a different handle is a different row.';
COMMENT ON COLUMN public.competitor_watchlist.status IS
  'pending = never captured; ok = captured; unavailable = the provider '
  'reported the target as not analysable; error = the last attempt failed. '
  'Server-owned: the owner cannot set it.';
COMMENT ON COLUMN public.competitor_watchlist.source IS
  'Where the last successful capture came from: official (the Graph API) or '
  'apify (the admin-controlled fallback). Server-owned.';

-- ===========================================================================
-- 7. Competitor profile snapshots.
--
-- Dated follower / media-count history per tracked competitor. One row per
-- (watchlist entry, capture day).
-- ===========================================================================

CREATE TABLE public.competitor_profile_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id    uuid NOT NULL,
  user_id         uuid NOT NULL,
  captured_on     date NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  capture_timezone text NOT NULL DEFAULT 'Asia/Kuwait',
  followers_count bigint,
  media_count     bigint,
  source          text NOT NULL,
  status          text NOT NULL DEFAULT 'ok',
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT competitor_profile_snapshots_owner_fkey
    FOREIGN KEY (watchlist_id, user_id)
    REFERENCES public.competitor_watchlist (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT competitor_profile_snapshots_capture_key
    UNIQUE (watchlist_id, captured_on),

  CONSTRAINT competitor_profile_snapshots_source_chk
    CHECK (source IN ('official', 'apify')),
  CONSTRAINT competitor_profile_snapshots_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT competitor_profile_snapshots_followers_chk
    CHECK (followers_count IS NULL OR followers_count >= 0),
  CONSTRAINT competitor_profile_snapshots_media_chk
    CHECK (media_count IS NULL OR media_count >= 0),
  CONSTRAINT competitor_profile_snapshots_capture_timezone_chk
    CHECK (char_length(capture_timezone) > 0 AND char_length(capture_timezone) <= 64)
);

CREATE INDEX idx_competitor_profile_snapshots_owner_captured
  ON public.competitor_profile_snapshots (user_id, captured_on DESC);
CREATE INDEX idx_competitor_profile_snapshots_watchlist_captured
  ON public.competitor_profile_snapshots (watchlist_id, captured_on DESC);

COMMENT ON TABLE public.competitor_profile_snapshots IS
  'Dated follower and media-count history for tracked competitors. '
  'Service-write-only; the owner may SELECT their own rows. The public '
  'counts are nullable and are never coerced to 0.';

-- ===========================================================================
-- 8. Competitor media snapshots.
--
-- Dated public-count history per tracked competitor's media. The public
-- counts (like_count, comments_count, view_count) are what Business
-- Discovery reports: paid + organic, which is NOT the same population as
-- the owner's organic insight metrics. Keeping them in separate tables is
-- what stops a report from comparing the two as if they were equal.
-- ===========================================================================

CREATE TABLE public.competitor_media_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id       uuid NOT NULL,
  user_id            uuid NOT NULL,
  ig_media_id        text NOT NULL,
  captured_on        date NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  capture_timezone   text NOT NULL DEFAULT 'Asia/Kuwait',
  media_product_type text,
  media_type         text,
  thumbnail_url      text,
  caption            text,
  permalink          text,
  published_at       timestamptz NOT NULL,
  like_count         bigint,
  comments_count     bigint,
  view_count         bigint,
  source             text NOT NULL,
  status             text NOT NULL DEFAULT 'ok',
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT competitor_media_snapshots_owner_fkey
    FOREIGN KEY (watchlist_id, user_id)
    REFERENCES public.competitor_watchlist (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT competitor_media_snapshots_capture_key
    UNIQUE (watchlist_id, ig_media_id, captured_on),

  CONSTRAINT competitor_media_snapshots_source_chk
    CHECK (source IN ('official', 'apify')),
  CONSTRAINT competitor_media_snapshots_status_chk
    CHECK (status IN ('pending', 'ok', 'unavailable', 'error')),
  CONSTRAINT competitor_media_snapshots_product_type_chk
    CHECK (media_product_type IS NULL
           OR media_product_type IN ('FEED', 'REELS', 'STORY', 'AD')),
  CONSTRAINT competitor_media_snapshots_media_type_chk
    CHECK (media_type IS NULL
           OR media_type IN ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM')),
  CONSTRAINT competitor_media_snapshots_media_id_chk
    CHECK (char_length(btrim(ig_media_id)) > 0 AND char_length(ig_media_id) <= 255),
  CONSTRAINT competitor_media_snapshots_like_chk
    CHECK (like_count IS NULL OR like_count >= 0),
  CONSTRAINT competitor_media_snapshots_comments_chk
    CHECK (comments_count IS NULL OR comments_count >= 0),
  CONSTRAINT competitor_media_snapshots_view_chk
    CHECK (view_count IS NULL OR view_count >= 0),
  CONSTRAINT competitor_media_snapshots_capture_timezone_chk
    CHECK (char_length(capture_timezone) > 0 AND char_length(capture_timezone) <= 64)
);

CREATE INDEX idx_competitor_media_snapshots_owner_published
  ON public.competitor_media_snapshots (user_id, published_at DESC);
CREATE INDEX idx_competitor_media_snapshots_watchlist_published
  ON public.competitor_media_snapshots (watchlist_id, published_at DESC);
CREATE INDEX idx_competitor_media_snapshots_watchlist_captured
  ON public.competitor_media_snapshots (watchlist_id, captured_on DESC);

COMMENT ON TABLE public.competitor_media_snapshots IS
  'Dated public-count history for tracked competitors'' media. '
  'Service-write-only; the owner may SELECT their own rows. The counts are '
  'the provider''s PUBLIC counts (paid + organic) and are not comparable to '
  'the owner''s organic insight metrics.';

-- ===========================================================================
-- 9. updated_at triggers (the helper the rest of the schema uses).
-- ===========================================================================

CREATE TRIGGER update_ig_media_insight_snapshots_updated_at
  BEFORE UPDATE ON public.ig_media_insight_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ig_account_insight_daily_updated_at
  BEFORE UPDATE ON public.ig_account_insight_daily
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ig_account_profile_observations_updated_at
  BEFORE UPDATE ON public.ig_account_profile_observations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_competitor_watchlist_updated_at
  BEFORE UPDATE ON public.competitor_watchlist
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 10. RLS and grants.
--
-- House convention: RLS on, explicit policies, explicit grants that do not
-- depend on environment-specific default privileges. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated,
-- service_role, so the REVOKEs below are load-bearing.
--
-- Owners get SELECT on their own rows and NOTHING else. The snapshot tables
-- have no client write path at all - not a restricted one, none: a browser
-- must never be able to write a metric, a capture date, a status or an
-- owner id.
-- ===========================================================================

ALTER TABLE public.ig_media_insight_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_account_insight_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_account_profile_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_profile_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_media_snapshots ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE
  v_owner_readable TEXT[] := ARRAY[
    'ig_media_insight_snapshots',
    'ig_account_insight_daily',
    'ig_account_profile_observations',
    'competitor_watchlist',
    'competitor_profile_snapshots',
    'competitor_media_snapshots'
  ];
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY v_owner_readable LOOP
    -- CREATE POLICY has no IF NOT EXISTS. A missing policy is created.
    -- A policy of this name whose command, role or predicate differs is a
    -- hard error: skipping it would hide a drifted owner-read rule. This
    -- does not make the migration replayable; the tables above are created
    -- unconditionally.
    IF NOT EXISTS (
          SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = v_table
             AND policyname = 'Owners can read their own rows'
         ) THEN
      EXECUTE format(
        'CREATE POLICY "Owners can read their own rows" ON public.%I '
        'FOR SELECT TO authenticated USING (auth.uid() = user_id)', v_table);
    ELSIF EXISTS (
          SELECT 1 FROM pg_policies
           WHERE schemaname = 'public'
             AND tablename = v_table
             AND policyname = 'Owners can read their own rows'
             AND NOT (
                   cmd = 'SELECT'
                   AND roles::text = '{authenticated}'
                   AND qual = '(auth.uid() = user_id)'
                   AND permissive = 'PERMISSIVE'
                 )
         ) THEN
      RAISE EXCEPTION
        'policy "Owners can read their own rows" on % does not match the owner-read contract',
        v_table;
    END IF;
  END LOOP;
END
$policies$;

-- The snapshot relations: owner reads, service role writes.
REVOKE ALL ON public.ig_media_insight_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ig_account_insight_daily FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ig_account_profile_observations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.competitor_profile_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.competitor_media_snapshots FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.ig_media_insight_snapshots TO authenticated;
GRANT SELECT ON public.ig_account_insight_daily TO authenticated;
GRANT SELECT ON public.ig_account_profile_observations TO authenticated;
GRANT SELECT ON public.competitor_profile_snapshots TO authenticated;
GRANT SELECT ON public.competitor_media_snapshots TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ig_media_insight_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ig_account_insight_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ig_account_profile_observations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitor_profile_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitor_media_snapshots TO service_role;

-- The watchlist: owner reads only. Every owner write goes through the owner
-- RPCs below, which is what keeps the server-owned columns server-owned.
-- DELETE is service-role only (the retention job that does not exist yet);
-- an owner never physically deletes a tracked competitor.
REVOKE ALL ON public.competitor_watchlist FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.competitor_watchlist TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitor_watchlist TO service_role;

-- ===========================================================================
-- 11. The entitlement resolver.
--
-- effective_competitor_quota(uuid) mirrors effective_user_quotas() exactly:
-- override -> active/past_due subscribed plan -> free literal. The plan
-- selection uses the same three-part tie-breaker (current_period_end DESC
-- NULLS LAST, created_at DESC, id DESC), because there is no uniqueness
-- constraint on active subscriptions and two arbiter implementations that
-- disagree about the winning plan are worse than one.
--
-- 'past_due' still entitles: dunning is a payment-collection state, not an
-- entitlement state, and downgrading a paying customer the moment a card
-- fails is the invariant 20260823140400 exists to prevent.
--
-- NO ADMIN BYPASS HERE, ON PURPOSE. This function answers "what does the
-- stored entitlement say". The admin exemption is applied where it means
-- something: the enforcement trigger and the owner read boundary.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.effective_competitor_quota(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  WITH plan AS (
    SELECT sp.max_tracked_competitors
    FROM public.subscription_plans sp
    WHERE sp.id = (
      SELECT us.plan_id FROM public.user_subscriptions us
      WHERE us.user_id = p_user_id AND us.status IN ('active', 'past_due')
      ORDER BY us.current_period_end DESC NULLS LAST, us.created_at DESC, us.id DESC
      LIMIT 1
    )
    UNION ALL
    -- Fallback branch: no active/past_due subscription -> the free plan row.
    SELECT sp.max_tracked_competitors
    FROM public.subscription_plans sp
    WHERE sp.slug = 'free'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_subscriptions us
        WHERE us.user_id = p_user_id AND us.status IN ('active', 'past_due')
      )
    LIMIT 1
  ),
  override AS (
    SELECT uq.max_tracked_competitors FROM public.user_quotas uq
    WHERE uq.user_id = p_user_id
  )
  SELECT COALESCE((SELECT o.max_tracked_competitors FROM override o),
                  (SELECT p.max_tracked_competitors FROM plan p), 5);
$function$;

COMMENT ON FUNCTION public.effective_competitor_quota(uuid) IS
  'Canonical tracked-competitor entitlement: override -> active/past_due plan '
  '-> free literal (5). -1 = unlimited. Service-role only. Carries no admin '
  'bypass: the exemption lives at the enforcement and read boundaries.';

-- The owner read boundary. There is no owner parameter on purpose: a
-- normal caller can only ask about itself, so no foreign owner's quota is
-- readable through this path.
CREATE OR REPLACE FUNCTION public.read_own_competitor_quota()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owner   uuid;
  v_limit   integer;
  v_active  integer;
BEGIN
  v_owner := auth.uid();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'authentication is required to read a competitor quota'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF public.has_role(v_owner, 'admin'::public.app_role) THEN
    v_limit := -1;
  ELSE
    v_limit := public.effective_competitor_quota(v_owner);
  END IF;

  SELECT count(*)::integer INTO v_active
    FROM public.competitor_watchlist
   WHERE user_id = v_owner AND is_active;

  RETURN jsonb_build_object(
    'max_tracked_competitors', v_limit,
    'unlimited', (v_limit = -1),
    'tracked_active', v_active,
    'remaining', CASE WHEN v_limit IS NULL OR v_limit = -1 THEN NULL
                      ELSE GREATEST(0, v_limit - v_active) END
  );
END;
$function$;

COMMENT ON FUNCTION public.read_own_competitor_quota() IS
  'The caller''s own tracked-competitor entitlement and usage. No owner '
  'parameter: a normal caller can only read its own quota. An admin reads '
  'unlimited (-1) here.';

-- ===========================================================================
-- 12. Username normalisation.
--
-- One place, so that every writer - the owner RPC, the service role, a
-- future admin tool - stores the same shape. The database is the authority
-- on the handle's identity: trimmed, no leading @, lower case.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.normalize_competitor_username(p_username text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
DECLARE
  v_username text;
BEGIN
  IF p_username IS NULL THEN
    RETURN NULL;
  END IF;

  v_username := btrim(p_username);
  v_username := regexp_replace(v_username, '^@+', '', 'g');
  v_username := btrim(v_username);
  v_username := lower(v_username);

  RETURN v_username;
END;
$function$;

COMMENT ON FUNCTION public.normalize_competitor_username(text) IS
  'Normalises an Instagram handle: trimmed, leading @ removed, lower case. '
  'The normalised value is what the uniqueness constraint compares.';

-- ===========================================================================
-- 13. The quota enforcement helper.
--
-- Called from the watchlist trigger, on the two transitions that consume a
-- slot: inserting an active entry, and moving an inactive entry back to
-- active. Label edits and removals never reach it, so an owner who is over
-- the limit can still tidy up their list - and, after a downgrade, can
-- still free slots.
--
-- The lock is the owner's quota row, not auth.users: every activation for
-- one owner serialises on it, so two concurrent adds cannot both see the
-- same count and both pass.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.assert_competitor_watchlist_quota(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_max    integer;
  v_active integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_QUOTA_DENIED: the competitor quota needs an owner'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The admin exemption lives HERE, at the enforcement boundary, and not in
  -- effective_competitor_quota(): the resolver reports the stored
  -- entitlement, this decides what to do about it.
  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN;
  END IF;

  -- The count below is valid only under READ COMMITTED. PostgREST uses that
  -- level. Under REPEATABLE READ or SERIALIZABLE the quota-row lock still
  -- serialises waiters, but the count keeps the transaction snapshot and
  -- misses a row committed after the snapshot started, so two activations
  -- can both pass. Locking the existing watchlist rows does not close that
  -- gap: a row inserted by the other transaction is not in this snapshot.
  -- Fail closed instead of promising the limit at a level that cannot see it.
  IF lower(current_setting('transaction_isolation')) IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION
      'COMPETITOR_QUOTA_ISOLATION: competitor quota enforcement requires READ COMMITTED'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The quota row exists to be locked. Its limit columns stay NULL: NULL
  -- means "inherit from the plan", and inventing a number here would be an
  -- accidental override that silently outranks the plan.
  INSERT INTO public.user_quotas (user_id, max_tracked_competitors)
  VALUES (p_user_id, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize every activation for this owner on this row, after the
  -- watchlist row lock when the caller is an UPDATE. Do not FOR UPDATE the
  -- watchlist rows here: the owner RPCs already hold one of those locks and
  -- then enter this function, so locking them again from the quota side
  -- deadlocks with the other order.
  PERFORM 1 FROM public.user_quotas WHERE user_id = p_user_id FOR UPDATE;

  SELECT public.effective_competitor_quota(p_user_id) INTO v_max;

  -- NULL or -1 means unlimited.
  IF v_max IS NULL OR v_max = -1 THEN
    RETURN;
  END IF;

  -- The row being activated is not counted: on INSERT it does not exist
  -- yet, and on an inactive -> active UPDATE it is still inactive.
  SELECT count(*)::integer INTO v_active
    FROM public.competitor_watchlist
   WHERE user_id = p_user_id AND is_active;

  IF v_active >= v_max THEN
    RAISE EXCEPTION
      'COMPETITOR_QUOTA_EXCEEDED: You are tracking % of the % competitors your plan allows. Remove one or upgrade your plan to track more.',
      v_active, v_max
      USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_competitor_watchlist_quota(uuid) IS
  'Enforces the tracked-competitor limit for one owner. Called from the '
  'watchlist trigger on insert-active and inactive->active only. The count '
  'is valid under READ COMMITTED; any other isolation level is refused.';

-- ===========================================================================
-- 14. The watchlist guard trigger.
--
-- One trigger, one function, so the order of the checks cannot drift:
--
--   1. normalise the handle (before the immutability check, so that
--      re-writing "FOO" over an existing "foo" is not seen as a rename);
--   2. the handle and the owner are immutable - a tracked competitor is
--      identified by the handle it was tracked under, and the snapshots
--      belong to the handle they observed;
--   3. the removal marker follows the active flag, on INSERT and on UPDATE;
--   4. a browser role may not set the status, the error, the sync stamp or
--      the source. The one allowed status change is not a value the caller
--      supplies: on a real inactive -> active transition this trigger sets
--      status to pending itself, and only after it has rejected a
--      caller-supplied change to those columns. No GUC authorises a status
--      write. A service-role write is not forced back to pending.
--   5. the quota, on the two transitions that consume a slot.
--
-- The browser check reads the `role` GUC, not current_user. This function
-- is SECURITY DEFINER, so current_user is the owner. PostgREST's SET ROLE
-- leaves `role` as anon / authenticated / service_role inside this function
-- too, which is why an owner RPC cannot smuggle a status change merely by
-- being security definer. That check stays. Nothing beside it trusts a
-- caller-controlled setting.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.enforce_competitor_watchlist_guards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_browser boolean;
  v_caller_changed_state boolean;
BEGIN
  -- `role` is 'none' when nobody has SET ROLE (a superuser session, or the
  -- function owner). That is not a browser. PostgREST sets it to the JWT
  -- role, and that value is still visible here.
  v_browser := coalesce(current_setting('role', true), current_user)
               IN ('anon', 'authenticated');

  -- 1. Normalise the handle. Done first, and for every writer, so that the
  --    stored identity is the normalised one.
  NEW.username := public.normalize_competitor_username(NEW.username);

  IF TG_OP = 'UPDATE' THEN
    -- 2. Immutable identity.
    IF NEW.username IS DISTINCT FROM OLD.username THEN
      RAISE EXCEPTION
        'COMPETITOR_IDENTITY_IMMUTABLE: A tracked competitor handle cannot be changed. Remove this entry and add the new handle instead.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION
        'COMPETITOR_IDENTITY_IMMUTABLE: A tracked competitor cannot be moved to another account.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 3. The removal marker, for every writer, on INSERT and on UPDATE.
  --    Retention keys on removed_at. An inactive row with no marker would
  --    never be cleaned up. now() is the statement's transaction time, not
  --    a backdated guess. A service writer may supply the instant on the
  --    insert or on the deactivating update; a later edit keeps the first
  --    one. A browser writer does not get to choose the instant.
  IF NEW.is_active THEN
    NEW.removed_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NULL OR v_browser THEN
      NEW.removed_at := now();
    END IF;
  ELSIF OLD.is_active THEN
    IF NEW.removed_at IS NULL OR v_browser THEN
      NEW.removed_at := now();
    END IF;
  ELSE
    NEW.removed_at := OLD.removed_at;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 4. Server-owned columns. Compared before this trigger assigns
    --    status, so the image under test is the one the caller wrote.
    v_caller_changed_state :=
         NEW.status IS DISTINCT FROM OLD.status
      OR NEW.last_error IS DISTINCT FROM OLD.last_error
      OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
      OR NEW.last_synced_at IS DISTINCT FROM OLD.last_synced_at
      OR NEW.next_retry_at IS DISTINCT FROM OLD.next_retry_at
      OR NEW.source IS DISTINCT FROM OLD.source;

    IF v_browser AND v_caller_changed_state THEN
      RAISE EXCEPTION
        'COMPETITOR_STATE_PROTECTED: Tracking status and sync details are managed by the server.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The only browser status write: this trigger, on a real reactivation,
    -- after the caller-change check. Setting the same value from the
    -- statement is still a caller change and was rejected above when it
    -- differed from the stored status.
    IF v_browser AND NOT OLD.is_active AND NEW.is_active THEN
      NEW.status := 'pending';
    END IF;

    -- 5. Quota, only on the transition that consumes a slot.
    IF NOT OLD.is_active AND NEW.is_active THEN
      PERFORM public.assert_competitor_watchlist_quota(NEW.user_id);
    END IF;
  ELSE
    -- A browser insert may only start at pending, with no sync details.
    -- The owner RPC inserts exactly that. A widened grant cannot seed
    -- status = ok or a source.
    IF v_browser AND (
         NEW.status IS DISTINCT FROM 'pending'
         OR NEW.last_error IS NOT NULL
         OR NEW.last_error_code IS NOT NULL
         OR NEW.last_synced_at IS NOT NULL
         OR NEW.next_retry_at IS NOT NULL
         OR NEW.source IS NOT NULL
       ) THEN
      RAISE EXCEPTION
        'COMPETITOR_STATE_PROTECTED: Tracking status and sync details are managed by the server.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.is_active THEN
      PERFORM public.assert_competitor_watchlist_quota(NEW.user_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_competitor_watchlist_guards
  BEFORE INSERT OR UPDATE ON public.competitor_watchlist
  FOR EACH ROW EXECUTE FUNCTION public.enforce_competitor_watchlist_guards();

COMMENT ON FUNCTION public.enforce_competitor_watchlist_guards() IS
  'Trigger fn: normalises the handle, refuses a rename or a re-parent, keeps '
  'the removal marker in step with the active flag on insert and update, '
  'protects server-owned columns from a browser write, resets status to '
  'pending itself on a browser inactive->active transition, and enforces the '
  'tracked-competitor quota on insert-active and inactive->active.';

-- ===========================================================================
-- 15. The owner watchlist RPCs.
--
-- The owner path. Both functions derive the owner from auth.uid() - never
-- from a parameter - so a caller can only ever act on its own list.
--
-- add_competitor_watchlist is the add/reactivate path. An already-active
-- handle is label-only: no second slot and no status reset. A removed
-- handle reactivates the same row, which is quota-checked; the trigger,
-- not this function, sets status back to pending. A new handle is an
-- insert, also quota-checked.
--
-- Lock order, for both owner RPCs: the watchlist row, then the quota row
-- (the quota row is locked inside the trigger, and only on a real
-- activation). A new insert has no watchlist row yet, so its quota lock
-- is held only for that insert statement. unique_violation and
-- COMPETITOR_QUOTA_EXCEEDED are caught in a subtransaction, which releases
-- that quota lock before the handler locks the watchlist row. That is the
-- same order as update_competitor_watchlist and as a direct UPDATE.
--
-- The unlocked read this used to do was racy. A handle inserted by a
-- transaction that had not committed yet was invisible, so this function
-- inserted, the BEFORE INSERT quota check ran before the unique index, and
-- a caller already at the cap was rejected even when the concurrent winner
-- was the same active handle. Under the cap, the unique_violation handler
-- then wrote status = pending onto that active row. Both are wrong. The
-- handler now re-reads under FOR UPDATE and treats an active row as
-- already tracked. A sequential call cannot prove the two-session race;
-- it can prove the committed-row outcome the race must land on.
--
-- update_competitor_watchlist is the label / activate / remove path. The
-- owner controls the label and the active flag. It does not write status.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.add_competitor_watchlist(
  p_username text,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner uuid;
  v_username text;
  v_label text;
  v_row public.competitor_watchlist%ROWTYPE;
  v_quota_message text;
BEGIN
  v_owner := auth.uid();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_ADD_DENIED: you must be signed in to track a competitor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_username := public.normalize_competitor_username(p_username);
  IF v_username IS NULL OR v_username = '' THEN
    RAISE EXCEPTION 'COMPETITOR_USERNAME_INVALID: Enter the competitor handle without the @.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_label IS NOT NULL AND char_length(p_label) > 120 THEN
    RAISE EXCEPTION 'COMPETITOR_LABEL_INVALID: The label must be at most 120 characters.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_label := p_label;

  -- Watchlist row first, when one is visible. The trigger takes the quota
  -- lock only if the branch below actually activates.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.user_id = v_owner
     AND w.platform = 'instagram'
     AND w.username = v_username
   FOR UPDATE;

  IF FOUND AND v_row.is_active THEN
    UPDATE public.competitor_watchlist
       SET label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', true
    );
  END IF;

  IF FOUND THEN
    -- Removed, and we hold the row. History stays on this row. Status is
    -- left for the trigger to reset; this statement does not write it.
    UPDATE public.competitor_watchlist
       SET is_active = true,
           removed_at = NULL,
           label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', v_row.is_active,
      'status', v_row.status,
      'reactivated', true,
      'already_tracked', false,
      'quota', public.read_own_competitor_quota()
    );
  END IF;

  BEGIN
    INSERT INTO public.competitor_watchlist
      (user_id, platform, username, label, is_active, status)
    VALUES
      (v_owner, 'instagram', v_username, v_label, true, 'pending')
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', false,
      'quota', public.read_own_competitor_quota()
    );
  EXCEPTION
    WHEN unique_violation THEN
      v_quota_message := NULL;
    WHEN check_violation THEN
      -- Quota is checked in the BEFORE INSERT trigger, before the unique
      -- index. A same-handle row that committed while we waited on the
      -- quota lock therefore surfaces as COMPETITOR_QUOTA_EXCEEDED when
      -- the owner is already at the cap, not as unique_violation. Any
      -- other check failure (the handle shape, for one) is not that race.
      IF SQLERRM LIKE 'COMPETITOR_QUOTA_EXCEEDED:%' THEN
        v_quota_message := SQLERRM;
      ELSE
        RAISE;
      END IF;
  END;

  -- The failed insert's subtransaction released its quota lock. Lock the
  -- watchlist row next, then decide from that locked image.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.user_id = v_owner
     AND w.platform = 'instagram'
     AND w.username = v_username
   FOR UPDATE;

  IF NOT FOUND THEN
    IF v_quota_message IS NOT NULL THEN
      RAISE EXCEPTION '%', v_quota_message
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'COMPETITOR_ADD_FAILED: the competitor could not be tracked'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_row.is_active THEN
    UPDATE public.competitor_watchlist
       SET label = COALESCE(v_label, label),
           updated_at = now()
     WHERE id = v_row.id
       AND user_id = v_owner
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
      'watchlist_id', v_row.id,
      'username', v_row.username,
      'is_active', true,
      'status', v_row.status,
      'reactivated', false,
      'already_tracked', true
    );
  END IF;

  -- Inactive, and the insert was refused because the cap is full.
  -- Reactivation needs a slot as well.
  IF v_quota_message IS NOT NULL THEN
    RAISE EXCEPTION '%', v_quota_message
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.competitor_watchlist
     SET is_active = true,
         removed_at = NULL,
         label = COALESCE(v_label, label),
         updated_at = now()
   WHERE id = v_row.id
     AND user_id = v_owner
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'watchlist_id', v_row.id,
    'username', v_row.username,
    'is_active', v_row.is_active,
    'status', v_row.status,
    'reactivated', true,
    'already_tracked', false,
    'quota', public.read_own_competitor_quota()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_competitor_watchlist(
  p_watchlist_id uuid,
  p_label text DEFAULT NULL,
  p_is_active boolean DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner  uuid;
  v_row    public.competitor_watchlist%ROWTYPE;
BEGIN
  v_owner := auth.uid();
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'COMPETITOR_UPDATE_DENIED: you must be signed in to manage a competitor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_label IS NOT NULL AND char_length(p_label) > 120 THEN
    RAISE EXCEPTION 'COMPETITOR_LABEL_INVALID: The label must be at most 120 characters.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Watchlist row first. A reactivation then locks the quota row inside
  -- the trigger. add_competitor_watchlist locks in this same order.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.id = p_watchlist_id
     AND w.user_id = v_owner
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPETITOR_NOT_FOUND: that competitor is not on your list'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_is_active IS TRUE AND NOT v_row.is_active THEN
    -- Reactivation. Quota and the pending reset belong to the trigger.
    -- Writing status here is a browser change of a server column, and the
    -- trigger rejects it.
    UPDATE public.competitor_watchlist
       SET is_active = true,
           removed_at = NULL,
           label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id
       AND user_id = v_owner;

  ELSIF p_is_active IS FALSE AND v_row.is_active THEN
    -- A soft removal. The history stays: the snapshots outlive the removal.
    UPDATE public.competitor_watchlist
       SET is_active = false,
           removed_at = now(),
           label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id;

  ELSE
    -- Label only, or a no-op activation of an already active entry.
    UPDATE public.competitor_watchlist
       SET label = COALESCE(p_label, label),
           updated_at = now()
     WHERE id = p_watchlist_id;
  END IF;

  -- The updated row, so the caller does not have to read it back. The
  -- removal marker is normalised by the trigger, so the row that is
  -- returned is the row that is stored.
  SELECT * INTO v_row
    FROM public.competitor_watchlist AS w
   WHERE w.id = p_watchlist_id
     AND w.user_id = v_owner;

  RETURN jsonb_build_object(
    'watchlist_id', v_row.id,
    'username', v_row.username,
    'label', v_row.label,
    'is_active', v_row.is_active,
    'removed_at', v_row.removed_at,
    'status', v_row.status,
    -- The caller's own entitlement and usage, so the UI does not have to
    -- make a second call to find out whether a slot was consumed.
    'quota', public.read_own_competitor_quota()
  );
END;
$function$;

COMMENT ON FUNCTION public.add_competitor_watchlist(text, text) IS
  'Owner path: track a competitor handle. Normalises the handle, adds it, '
  'or reactivates the existing row. An already-active handle does not take '
  'another slot and does not reset status. The returned status is the stored '
  'status. already_tracked responses omit quota.';
COMMENT ON FUNCTION public.update_competitor_watchlist(uuid, text, boolean) IS
  'Owner path: relabel, (re)activate or soft-remove a tracked competitor. '
  'The handle and the owner cannot be changed. This function does not write '
  'status; a browser reactivation is reset to pending by the watchlist guard.';

-- ===========================================================================
-- 16. The post-link contract for media snapshots.
--
-- A media snapshot may point at the Postora post that published the media.
-- That link must be unambiguous: exactly one owned post published that media
-- id on that account. Anything else - no match, or two different posts -
-- leaves post_id NULL.
--
-- The trigger makes that structural: no writer, the service role included,
-- can attach an arbitrary post id. The resolver RPC is the same rule as a
-- read, and is what the collector should call.
--
-- Two collector rules are intentionally not table constraints. A future
-- writer must store only Instagram-owned accounts and finite timestamps
-- (not infinity). That is a writer contract. Rejecting infinity, or
-- requiring platform = instagram on every insight row, is not a hole in
-- the ownership keys below. The resolver already ignores a non-Instagram
-- account; the trigger refuses a missing or ambiguous owned post.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.guard_ig_media_insight_post_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_matches integer;
  v_linked  boolean;
BEGIN
  IF NEW.post_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT pp.post_id)::integer INTO v_matches
    FROM public.platform_posts AS pp
    JOIN public.posts AS p ON p.id = pp.post_id
   WHERE pp.social_account_id = NEW.social_account_id
     AND pp.platform_post_id = NEW.ig_media_id
     AND p.user_id = NEW.user_id;

  SELECT EXISTS (
           SELECT 1 FROM public.platform_posts AS pp
            WHERE pp.social_account_id = NEW.social_account_id
              AND pp.platform_post_id = NEW.ig_media_id
              AND pp.post_id = NEW.post_id
         ) INTO v_linked;

  IF v_matches <> 1 OR NOT v_linked THEN
    RAISE EXCEPTION
      'IG_MEDIA_POST_LINK_INVALID: the post link for this media is missing or ambiguous, so it is not stored'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_ig_media_insight_snapshots_post_link
  BEFORE INSERT OR UPDATE ON public.ig_media_insight_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.guard_ig_media_insight_post_link();

COMMENT ON FUNCTION public.guard_ig_media_insight_post_link() IS
  'Trigger fn: a media snapshot may only point at the single owned '
  'platform_posts row that published that media id on that account.';

CREATE OR REPLACE FUNCTION public.resolve_ig_media_post_link(
  p_social_account_id uuid,
  p_ig_media_id text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_matches integer;
  v_post_id  uuid;
BEGIN
  IF p_social_account_id IS NULL OR p_ig_media_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(DISTINCT pp.post_id)::integer INTO v_matches
    FROM public.platform_posts AS pp
    JOIN public.posts AS p ON p.id = pp.post_id
    JOIN public.social_accounts AS sa ON sa.id = pp.social_account_id
   WHERE pp.social_account_id = p_social_account_id
     AND pp.platform_post_id = p_ig_media_id
     AND sa.platform = 'instagram'
     AND p.user_id = sa.user_id;

  -- Ambiguous is not "pick one". Two candidate posts means no link.
  IF v_matches <> 1 THEN
    RETURN NULL;
  END IF;

  SELECT DISTINCT pp.post_id INTO v_post_id
    FROM public.platform_posts AS pp
    JOIN public.posts AS p ON p.id = pp.post_id
    JOIN public.social_accounts AS sa ON sa.id = pp.social_account_id
   WHERE pp.social_account_id = p_social_account_id
     AND pp.platform_post_id = p_ig_media_id
     AND sa.platform = 'instagram'
     AND p.user_id = sa.user_id;

  RETURN v_post_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_ig_media_post_link(uuid, text) IS
  'Resolves the Postora post that published an IG media id on an account. '
  'Returns NULL when there is no owned match or more than one - never an '
  'arbitrary first match. Service-role only.';

-- ===========================================================================
-- 17. Function grants.
--
-- Named EXPLICITLY. This stack carries ALTER DEFAULT PRIVILEGES ... GRANT
-- ALL ON FUNCTIONS TO anon, authenticated, so "REVOKE ... FROM PUBLIC"
-- alone leaves both roles holding EXECUTE (see 20260831150000 for the
-- incident). The anon key alone must not be able to call any of these.
--
-- The owner RPCs are reachable by 'authenticated' and by nobody else: they
-- read the owner from auth.uid(), so they cannot be pointed at another
-- account. The service role reaches the data through the tables.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.effective_competitor_quota(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_own_competitor_quota() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.normalize_competitor_username(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_competitor_watchlist_quota(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_competitor_watchlist_guards() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_competitor_watchlist(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_competitor_watchlist(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_ig_media_insight_post_link() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_ig_media_post_link(uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.effective_competitor_quota(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_own_competitor_quota() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_competitor_watchlist(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_competitor_watchlist(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ig_media_post_link(uuid, text) TO service_role;

-- The normalisation helper is called by the owner RPCs and by the trigger,
-- both of which run as the definer, so the definer keeps EXECUTE. It stays
-- revoked for the browser roles: it is an internal detail of the handle
-- contract, not an API.

COMMIT;
