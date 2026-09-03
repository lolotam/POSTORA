-- Comment Workflow: deterministic comment-to-DM funnels.
-- Spec: docs/superpowers/specs/2026-09-03-comment-workflow-funnels.md
--
-- Three tables with three different jobs, deliberately not merged:
--   comment_workflow_rules  -- user configuration
--   comment_workflow_events -- append-only audit AND the per-comment idempotency key
--   comment_workflow_usage  -- the "send once per person" claim
-- Putting the send-once uniqueness on the audit log would have made send_once_per_user = false
-- impossible to express, and would have blocked recording a retry after a failed attempt.
--
-- Tenancy is user_id, matching messenger_auto_replies. workspace_id is deliberately NOT used:
-- social_accounts_whatsapp_needs_workspace guarantees a workspace only for WhatsApp rows, so a
-- NOT NULL workspace on a Facebook rule would reject every legitimate configuration.
--
-- Every ownership relationship below is a COMPOSITE foreign key rather than a plain column.
-- Edge Functions run under the service role, so RLS is not enforcing tenancy for the code that
-- writes these rows; only the schema is. See AGENTS.md, reviewer rule 1.

-- ---------------------------------------------------------------------------
-- 0. Validation helpers.
-- ---------------------------------------------------------------------------

-- A CHECK cannot contain a subquery, so the "every element is real text" rule needs a
-- function. Without it, ARRAY[''] satisfies cardinality(...) > 0 and a rule that claims a
-- comment and then posts an empty reply passes every constraint.
CREATE OR REPLACE FUNCTION public.comment_workflow_entries_present(p_entries TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT p_entries IS NOT NULL
     AND cardinality(p_entries) > 0
     AND cardinality(p_entries) = (
           SELECT count(*) FROM unnest(p_entries) AS entry WHERE btrim(coalesce(entry, '')) <> ''
         );
$$;

COMMENT ON FUNCTION public.comment_workflow_entries_present(TEXT[]) IS
  'True when the array is non-empty and every element is non-null, non-blank text.';


-- ---------------------------------------------------------------------------
-- 1. Composite keys this feature references.
-- ---------------------------------------------------------------------------

-- social_accounts already carries UNIQUE (id, user_id, platform)
-- (20260828190000_account_configs_prepare.sql) and UNIQUE (id, user_id)
-- (20260828140000_account_scoped_agents_expand.sql). The triple is what rules reference, so a
-- rule's denormalized `platform` cannot disagree with its account's — which is what makes the
-- "Threads rules carry no DM" constraint below actually unbypassable.
--
-- media_files has only a primary key on id, so the composite ownership key it needs is added
-- here. It is trivially satisfied (id is unique) and exists solely as an FK target.
DO $$
BEGIN
  ALTER TABLE public.media_files ADD CONSTRAINT media_files_id_user_id_key UNIQUE (id, user_id);
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;


-- ---------------------------------------------------------------------------
-- 2. Rules.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.comment_workflow_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_account_id  UUID NOT NULL,
  platform           TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'threads')),
  name               TEXT NOT NULL,
  -- NULL means every post on the account.
  target_post_id     TEXT,
  match_type         TEXT NOT NULL CHECK (match_type IN ('exact', 'contains', 'any')),
  keywords           TEXT[] NOT NULL DEFAULT '{}',
  -- Varied so a busy post does not show one canned line under twenty comments.
  public_replies     TEXT[] NOT NULL DEFAULT '{}',
  dm_message         TEXT,
  media_file_id      UUID,
  send_once_per_user BOOLEAN NOT NULL DEFAULT true,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The rule, its stated owner and its stated platform are one fact, checked by the database.
  CONSTRAINT cwr_account_owner FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform) ON DELETE CASCADE,
  -- A rule can only ever attach a file its own owner owns.
  CONSTRAINT cwr_media_owner FOREIGN KEY (media_file_id, user_id)
    REFERENCES public.media_files (id, user_id) ON DELETE SET NULL,

  CONSTRAINT cwr_name_present CHECK (btrim(name) <> '' AND length(name) <= 120),
  -- A keyword rule with no usable keywords matches nothing and reads as broken; 'any' is the
  -- explicit way to claim every comment.
  CONSTRAINT cwr_keywords_present
    CHECK (match_type = 'any' OR public.comment_workflow_entries_present(keywords)),
  -- Blank entries are not replies. An array of empty strings would otherwise let a rule claim
  -- a comment, suppress every other automation, and post nothing.
  CONSTRAINT cwr_public_replies_usable
    CHECK (cardinality(public_replies) = 0 OR public.comment_workflow_entries_present(public_replies)),
  CONSTRAINT cwr_public_replies_bounded CHECK (cardinality(public_replies) <= 5),
  CONSTRAINT cwr_dm_message_usable
    CHECK (dm_message IS NULL OR (btrim(dm_message) <> '' AND length(dm_message) <= 1000)),
  -- A rule that neither replies publicly nor sends a DM does nothing at all.
  CONSTRAINT cwr_does_something CHECK (cardinality(public_replies) > 0 OR dm_message IS NOT NULL),
  -- Threads has no private messages. With platform bound to the account above, this cannot be
  -- bypassed by mislabelling the row.
  CONSTRAINT cwr_threads_has_no_dm
    CHECK (platform <> 'threads' OR (dm_message IS NULL AND media_file_id IS NULL)),
  -- The file travels as a link inside the DM text; with no DM there is nothing to carry it.
  CONSTRAINT cwr_media_needs_dm CHECK (media_file_id IS NULL OR dm_message IS NOT NULL),
  -- An FK target for the events table below.
  CONSTRAINT cwr_id_user_key UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS cwr_active_by_account ON public.comment_workflow_rules (social_account_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS cwr_by_user           ON public.comment_workflow_rules (user_id);
CREATE INDEX IF NOT EXISTS cwr_by_media          ON public.comment_workflow_rules (media_file_id) WHERE media_file_id IS NOT NULL;

DROP TRIGGER IF EXISTS update_comment_workflow_rules_updated_at ON public.comment_workflow_rules;
CREATE TRIGGER update_comment_workflow_rules_updated_at
  BEFORE UPDATE ON public.comment_workflow_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.comment_workflow_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own comment workflow rules" ON public.comment_workflow_rules;
CREATE POLICY "Users manage own comment workflow rules"
  ON public.comment_workflow_rules FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 3. Events — the audit trail and the per-comment idempotency key.
-- ---------------------------------------------------------------------------
--
-- The unique key is per COMMENT, not per person: someone who comments twice produces two rows,
-- which is what lets send_once_per_user = false work and lets a failed attempt and a later
-- success both stay visible. The row is written before any send, so a worker killed mid-flight
-- leaves a `pending` row rather than silence.

CREATE TABLE IF NOT EXISTS public.comment_workflow_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id             UUID NOT NULL,
  user_id             UUID NOT NULL,
  social_account_id   UUID NOT NULL,
  platform            TEXT NOT NULL,
  external_post_id    TEXT,
  external_comment_id TEXT NOT NULL,
  author_key          TEXT NOT NULL,
  author_username     TEXT,
  comment_text        TEXT,
  -- `indeterminate` is not a nicety: callGraph reports a timeout as an unreachable upstream,
  -- and Meta may have accepted a send whose response never arrived. Recording that as `failed`
  -- would free the send-once claim and let the next comment produce a second DM for something
  -- the person already received.
  public_reply_status TEXT NOT NULL CHECK (public_reply_status IN ('pending', 'sent', 'failed', 'skipped', 'indeterminate')),
  public_reply_id     TEXT,
  dm_status           TEXT NOT NULL CHECK (dm_status IN ('pending', 'sent', 'failed', 'skipped', 'indeterminate', 'not_applicable')),
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cwe_one_per_comment UNIQUE (social_account_id, external_comment_id),
  -- An event belongs to its rule AND to that rule's owner: the two cannot be set independently.
  CONSTRAINT cwe_rule_owner FOREIGN KEY (rule_id, user_id)
    REFERENCES public.comment_workflow_rules (id, user_id) ON DELETE CASCADE,
  -- ... and names the account and platform the rule itself is bound to.
  CONSTRAINT cwe_account_owner FOREIGN KEY (social_account_id, user_id, platform)
    REFERENCES public.social_accounts (id, user_id, platform) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cwe_by_rule ON public.comment_workflow_events (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cwe_by_user ON public.comment_workflow_events (user_id, created_at DESC);
-- Finds the rows a killed worker left behind.
CREATE INDEX IF NOT EXISTS cwe_pending ON public.comment_workflow_events (created_at)
  WHERE public_reply_status = 'pending' OR dm_status = 'pending';

DROP TRIGGER IF EXISTS update_comment_workflow_events_updated_at ON public.comment_workflow_events;
CREATE TRIGGER update_comment_workflow_events_updated_at
  BEFORE UPDATE ON public.comment_workflow_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.comment_workflow_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own comment workflow events" ON public.comment_workflow_events;
CREATE POLICY "Users read own comment workflow events"
  ON public.comment_workflow_events FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
-- No INSERT/UPDATE/DELETE policy on purpose: only the ingestion paths (service role) write
-- here, and an audit trail a client can edit is not one.


-- ---------------------------------------------------------------------------
-- 4. Usage claims — "send once per person".
-- ---------------------------------------------------------------------------
--
-- Taken BEFORE the send. A read-then-check loses the race between two comments from the same
-- person landing in different isolates; a primary key does not. Scope is per rule x person x
-- post, so an all-posts funnel serves someone once per post rather than once forever.

CREATE TABLE IF NOT EXISTS public.comment_workflow_usage (
  rule_id          UUID NOT NULL REFERENCES public.comment_workflow_rules(id) ON DELETE CASCADE,
  author_key       TEXT NOT NULL,
  -- '' when the platform sent no post id. Every such comment for one person therefore shares a
  -- single claim, which is the conservative reading: one DM rather than one per unknown post.
  external_post_id TEXT NOT NULL DEFAULT '',
  claimed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, author_key, external_post_id)
);

ALTER TABLE public.comment_workflow_usage ENABLE ROW LEVEL SECURITY;
-- Service-role only. RLS on with no policy means no client can read or write it, which is the
-- intent: it holds claims, not user-facing information.


-- ---------------------------------------------------------------------------
-- 5. Counters for the workflow pool.
-- ---------------------------------------------------------------------------
--
-- security_invoker means the underlying table's RLS is evaluated as the caller, so a user sees
-- aggregates over their own events only. Without it the view would read as its owner and hand
-- every user everyone else's numbers.

DROP VIEW IF EXISTS public.comment_workflow_rule_stats;
CREATE VIEW public.comment_workflow_rule_stats
WITH (security_invoker = true) AS
SELECT
  rule_id,
  count(*)::int                                                                       AS triggered_count,
  count(*) FILTER (WHERE public_reply_status = 'sent')::int                           AS public_sent_count,
  count(*) FILTER (WHERE dm_status = 'sent')::int                                     AS dm_sent_count,
  count(*) FILTER (WHERE public_reply_status = 'failed' OR dm_status = 'failed')::int AS failed_count,
  count(*) FILTER (WHERE public_reply_status = 'indeterminate' OR dm_status = 'indeterminate')::int AS indeterminate_count,
  max(created_at)                                                                     AS last_triggered_at
FROM public.comment_workflow_events
GROUP BY rule_id;

GRANT SELECT ON public.comment_workflow_rule_stats TO authenticated;


-- ---------------------------------------------------------------------------
-- 6. The flag.
-- ---------------------------------------------------------------------------
--
-- Off by default. Note that admins receive every non-visibility flag regardless of this value
-- (useFeatureFlags ALL_FLAGS_ENABLED), so this hides the page from users, not from an admin.
INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_comment_workflow', 'false'::jsonb, 'Comment Workflow (comment-to-DM funnels) page')
ON CONFLICT (key) DO NOTHING;
