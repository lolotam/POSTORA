-- ============================================================================
-- Phase 8 (first tranche) — the partner posts surface and post.scheduled
--
--   1. partner_api_posts       the workspace binding that makes a post
--                              ADDRESSABLE from /v1 (Decision A, 2026-09-02)
--   2. events CHECK widening   + 'post.scheduled' ONLY -- post.published /
--                              post.failed wait for the Phase 7 observation
--                              gate (one real publish through the seam)
--   3. partner_post_scheduled_emit + trigger    the transactional producer
--                              for post.scheduled, covering EVERY writer --
--                              /v1 and all six browser writers -- without
--                              touching the frontend (Decision B)
--   4. partner_create_post     atomic create: posts row + binding row (+ the
--                              schedule emit, via the trigger) in ONE
--                              transaction
--
-- WHY A BINDING TABLE AND NOT A COLUMN ON posts
-- ---------------------------------------------
-- posts predates workspaces and carries only user_id. A workspace_id column
-- would need a backfill policy for 1,300+ existing rows, and any backfill is
-- a GUESS about tenancy -- a guessed tenant in a webhook is a cross-tenant
-- delivery nothing downstream can detect. The binding table makes
-- addressability EXPLICIT: a row exists iff a partner key created the post,
-- so /v1 can never serve a post whose tenant was inferred. UI posts stay
-- unaddressable from /v1, which is the fail-closed direction binding.ts
-- already argues for on the messaging side.
--
-- Decision record: docs/decisions/2026-09-02-phase8-posts-scheduling.md
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The addressability binding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_api_posts (
  post_id      UUID PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Audit only: which key created the post. SET NULL so revoking a key does
  -- not delete the record of what it created.
  key_id       UUID REFERENCES public.partner_api_keys(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_api_posts_workspace
  ON public.partner_api_posts (workspace_id);

-- Service-role only, like every partner_* table: the edge function is the
-- sole reader and writer, and RLS-with-no-policies denies everything else.
ALTER TABLE public.partner_api_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_api_posts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_api_posts TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Certify post.scheduled -- and ONLY post.scheduled
-- ---------------------------------------------------------------------------
-- post.published / post.failed have a live producer since Phase 7
-- (partner_settle_platform_post) but stay uncertified until the seam has
-- settled at least one real publish -- the owner's observation gate,
-- 2026-09-02. Certifying an event whose producer has never fired in
-- production would advertise exactly the promise D6 exists to prevent.
--
-- The paired TypeScript edit is CERTIFIED_EVENT_TYPES in
-- _shared/partnerWebhookEvents.ts -- two enforcement points, two deliberate
-- acts, same commit.
DO $widen$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'partner_webhooks_events_certified is missing -- apply 20260902130000 first';
  END IF;
  IF v_def LIKE '%post.scheduled%' THEN
    RETURN;  -- already widened; re-running is a no-op
  END IF;

  ALTER TABLE public.partner_webhooks
    DROP CONSTRAINT partner_webhooks_events_certified;
  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_certified
    CHECK (
      cardinality(events) > 0
      AND events <@ ARRAY[
        'webhook.test',
        'message.received',
        'message.accepted',
        'message.delivered',
        'message.read',
        'message.failed',
        'account.reauthorization_required',
        'post.scheduled'
      ]
    );
END
$widen$;

-- ---------------------------------------------------------------------------
-- 3. The post.scheduled producer -- a trigger, so every writer is covered
-- ---------------------------------------------------------------------------
-- Six browser code paths write schedule rows and none of them can be asked to
-- enqueue anything (7.5's deferral). A trigger on the TABLE covers all of
-- them plus /v1 plus any future writer, transactionally, with zero frontend
-- changes -- the mechanism the account.* ledger entry already names as
-- correct for many-writer transitions.
--
-- ⚠ BLAST RADIUS, stated plainly: this trigger runs inside EVERY schedule
-- write, including the browser's. It deliberately does NOT swallow
-- exceptions -- a transactional producer that catches its own failure is the
-- silent event loss D5 exists to prevent -- so a defect here blocks
-- scheduling for the whole product, not just for partners. That is why the
-- SQL suite (supabase/tests/partner_posts.sql) exercises the UI-shaped
-- write, the /v1-shaped write, AND the unattributable write, not just the
-- happy path.
--
-- ATTRIBUTION -- who is this post's tenant?
--   1. A partner_api_posts binding row is authoritative (a /v1 post).
--   2. Otherwise, resolve each account in metadata.selected_account_ids via
--      partner_workspace_of_account. All non-null resolutions must agree on
--      ONE workspace; any disagreement means the tenant would be a guess,
--      and a guessed tenant is a cross-tenant delivery -- so emit NOTHING.
--      (In production every scheduled post's targets resolve to a single
--      workspace today; the ambiguous case is defensive.)
--   3. No binding, no resolvable accounts: the post commits normally and no
--      event is emitted. Unattributable is silent BY DESIGN, and documented.
--
-- OCCURRENCE ID: post.scheduled:<post id>:<scheduled_at, UTC micro-second
-- ISO>. A reschedule to a NEW time is a new transition and a new occurrence;
-- a rewrite of the SAME time is not a transition and emits nothing (the
-- IS NOT DISTINCT FROM guard); and the timestamp is rendered explicitly in
-- UTC because ::text output follows the session timezone, which would make
-- the same transition two occurrences under two timezones.
--
-- SECURITY DEFINER because browser writes reach this trigger as
-- `authenticated`, which has no rights on partner_webhook_deliveries -- and
-- must not gain any.
CREATE OR REPLACE FUNCTION public.partner_post_scheduled_emit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ws  UUID;
  v_occ TEXT;
  v_when TEXT;
  v_distinct_ws UUID[];
BEGIN
  IF NEW.scheduled_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.scheduled_at IS NOT DISTINCT FROM OLD.scheduled_at THEN
    RETURN NEW;  -- not a transition: some other column changed
  END IF;

  SELECT p.workspace_id INTO v_ws
    FROM public.partner_api_posts p
   WHERE p.post_id = NEW.id;

  IF v_ws IS NULL THEN
    SELECT array_agg(DISTINCT ws) INTO v_distinct_ws
      FROM (
        SELECT public.partner_workspace_of_account(aid::uuid) AS ws
          FROM jsonb_array_elements_text(
                 coalesce(NEW.metadata->'selected_account_ids', '[]'::jsonb)
               ) AS aid
         WHERE aid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ) t
     WHERE t.ws IS NOT NULL;

    IF v_distinct_ws IS NULL OR cardinality(v_distinct_ws) <> 1 THEN
      RETURN NEW;  -- unattributable or ambiguous: commit, emit nothing
    END IF;
    v_ws := v_distinct_ws[1];
  END IF;

  v_when := to_char(NEW.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  v_occ  := 'post.scheduled:' || NEW.id || ':' || v_when;

  -- platform / social_account_id are NULL: a post can span platforms, so no
  -- single-account subscription filter can be honestly matched against it.
  -- A filtered subscription therefore never receives post.* events, which is
  -- the filter contract ("a filter may only ever REMOVE") applied here.
  PERFORM public.partner_emit_webhook_event(
    v_ws,
    'post.scheduled',
    v_occ,
    jsonb_build_object(
      'post_id',      'post_' || NEW.id,
      'scheduled_at', v_when,
      'platforms',    to_jsonb(coalesce(NEW.platforms, ARRAY[]::text[])),
      'status',       NEW.status
    ),
    NULL,
    NULL,
    now()
  );

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_post_scheduled_emit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_partner_post_scheduled ON public.posts;
CREATE TRIGGER trg_partner_post_scheduled
  AFTER INSERT OR UPDATE OF scheduled_at ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.partner_post_scheduled_emit();

-- ---------------------------------------------------------------------------
-- 4. Atomic create: the posts row and its addressability in one transaction
-- ---------------------------------------------------------------------------
-- Two client-side inserts would leave a crash window in which the post
-- exists, is charged to quota, and is INVISIBLE to the partner -- whose
-- retry (the idempotency claim never settled) then creates and bills a
-- second one.
--
-- The scheduled_at two-step is deliberate: the posts INSERT carries
-- scheduled_at NULL, the binding row is written, and only then is
-- scheduled_at set -- so the trigger above always sees the binding and
-- attributes a /v1 post by its authoritative row, never by the metadata
-- fallback. Within one transaction the intermediate state is invisible.
--
-- The quota trigger (trg_enforce_post_quota_on_insert) fires inside this
-- function and its POST_QUOTA_* exception bubbles out intact; the route maps
-- that message prefix to `quota_exceeded`. Do not catch it here.
CREATE OR REPLACE FUNCTION public.partner_create_post(
  p_workspace_id         UUID,
  p_key_id               UUID,
  p_user_id              UUID,
  p_caption              TEXT,
  p_platforms            TEXT[],
  p_media_file_ids       UUID[],
  p_selected_account_ids UUID[],
  p_scheduled_at         TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_row JSONB;
BEGIN
  INSERT INTO public.posts (
    user_id, caption, platforms, media_file_ids, status, scheduled_at,
    metadata, source
  ) VALUES (
    p_user_id,
    coalesce(p_caption, ''),
    coalesce(p_platforms, ARRAY[]::text[]),
    coalesce(p_media_file_ids, ARRAY[]::uuid[]),
    CASE WHEN p_scheduled_at IS NULL THEN 'pending' ELSE 'scheduled' END,
    NULL,  -- set below, after the binding row exists
    jsonb_build_object(
      'selected_account_ids',
      to_jsonb(coalesce(p_selected_account_ids, ARRAY[]::uuid[]))
    ),
    'partner_api'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.partner_api_posts (post_id, workspace_id, key_id)
  VALUES (v_id, p_workspace_id, p_key_id);

  IF p_scheduled_at IS NOT NULL THEN
    -- Fires trg_partner_post_scheduled with the binding row visible; the
    -- create and the post.scheduled enqueue commit or roll back together.
    UPDATE public.posts SET scheduled_at = p_scheduled_at WHERE id = v_id;
  END IF;

  SELECT to_jsonb(p) INTO v_row FROM public.posts p WHERE p.id = v_id;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_create_post(UUID, UUID, UUID, TEXT, TEXT[], UUID[], UUID[], TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_create_post(UUID, UUID, UUID, TEXT, TEXT[], UUID[], UUID[], TIMESTAMPTZ)
  TO service_role;
