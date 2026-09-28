-- Media library retention: warn, claim, and (only when enabled) hand files to delete.
--
-- WHY
-- Library files age on a per-user clock (7, 30 or 90 days; NULL means never)
-- and get a 7-day warning before any delete. Files that already exist age
-- from media_retention_settings.rollout_at, written once. delete_enabled
-- stays false until an admin turns deletion on, so the job warns without
-- claiming. supabase/functions/media-retention calls media_retention_sweep,
-- media_retention_claim, media_retention_release(p_id, p_user_id, p_failed) and
-- media_retention_preview(p_user). The library calls media_set_keep and
-- reads media_retention_settings.delete_enabled with the user JWT.
--
-- Tenancy (ARCHITECTURE.md sections 23-24): the worker uses the service
-- role, which bypasses RLS, so these functions are SECURITY DEFINER with a
-- fixed search_path. media_set_keep updates only rows owned by auth.uid()
-- and returns how many of those rows changed.
-- End users cannot write the retention columns. The guard keys on
-- current_user, not auth.role(), so a SECURITY DEFINER caller still can.
--
-- The reference check is one candidate set, one address set and one used-id
-- set, reused by sweep, claim and preview. It is not a per-row LIKE.
--
-- Idempotent. The profiles default of 30 is applied only by the ADD that
-- creates the column; a re-apply does not rewrite NULLs. The settings insert
-- does nothing on conflict, so rollout_at never moves. No BEGIN/COMMIT.
--
-- Referenced tables and columns all exist in migrations (checked 2026-09-28).
-- None were missing, so none are skipped behind to_regclass:
-- posts.media_file_ids, posts.metadata, posts.user_id,
-- comment_workflow_rules.media_file_id, comment_workflow_rules.user_id,
-- workflows.nodes, workflows.thumbnail_url, workflow_versions.nodes,
-- workflow_templates.nodes, workflow_templates.preview_image_url,
-- profiles.avatar_url, app_settings.key, app_settings.value,
-- image_reference_presets.reference_images,
-- whatsapp_scheduled_messages.media_url, whatsapp_scheduled_messages.status,
-- whatsapp_scheduled_messages.user_id,
-- whatsapp_broadcasts.template_components, whatsapp_broadcasts.status,
-- whatsapp_messages.media_url, whatsapp_messages.user_id,
-- whatsapp_contacts.avatar_url, blog_posts.cover_image_url,
-- ai_knowledge_sources.file_path,
-- ai_generation_jobs.media_file_id, ai_generation_jobs.result_url,
-- ai_generation_jobs.params, ai_generation_jobs.status,
-- media_files.file_path, media_files.storage_bucket,
-- media_files.cloudinary_public_id, media_files.user_id, media_files.created_at,
-- media_files.file_type,
-- media_file_providers.provider, media_file_providers.object_key,
-- media_file_providers.delivery_url, media_file_providers.media_file_id,
-- system_logs.
-- Not protected, on purpose: media_operations_history, terminal generation
-- jobs (succeeded, failed, timeout), media_files.metadata provenance.

-- ---------------------------------------------------------------------------
-- 1. Per-user retention. DEFAULT 30 fills existing rows only when this ADD
--    creates the column. IF NOT EXISTS makes a re-apply a no-op.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS media_retention_days integer DEFAULT 30;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_media_retention_days_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_media_retention_days_check
  CHECK (media_retention_days IS NULL OR media_retention_days IN (7, 30, 90));

COMMENT ON COLUMN public.profiles.media_retention_days IS
  'Days an unused library file may age before it is warned. NULL means never. Only 7, 30 or 90.';

-- ---------------------------------------------------------------------------
-- 2. Server-managed file columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.media_files
  ADD COLUMN IF NOT EXISTS keep_forever boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_state text,
  ADD COLUMN IF NOT EXISTS retention_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retention_next_attempt_at timestamptz;

ALTER TABLE public.media_files DROP CONSTRAINT IF EXISTS media_files_retention_state_check;
ALTER TABLE public.media_files
  ADD CONSTRAINT media_files_retention_state_check
  CHECK (retention_state IS NULL OR retention_state IN ('warned', 'deleting'));

CREATE INDEX IF NOT EXISTS idx_media_files_expires_at
  ON public.media_files (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_files_file_path
  ON public.media_files (file_path);

CREATE INDEX IF NOT EXISTS idx_media_file_providers_delivery_url
  ON public.media_file_providers (delivery_url)
  WHERE delivery_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_file_providers_object_identity
  ON public.media_file_providers (provider, object_key);

-- Table-level UPDATE would cover the new columns. Revoke it and grant every
-- other column back so owner edits of folder_path, metadata and file_path
-- keep working.
DO $grant_media_file_updates$
DECLARE
  v_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'media_files'
    AND column_name NOT IN (
      'keep_forever', 'last_used_at', 'expires_at', 'retention_state',
      'retention_claimed_at', 'retention_attempts', 'retention_next_attempt_at'
    );
  REVOKE UPDATE ON TABLE public.media_files FROM PUBLIC, anon, authenticated;
  IF v_cols IS NOT NULL THEN
    EXECUTE format(
      'GRANT UPDATE (%s) ON public.media_files TO authenticated, anon',
      v_cols
    );
  END IF;
END $grant_media_file_updates$;

-- ---------------------------------------------------------------------------
-- 3. Singleton. rollout_at is inserted once. delete_enabled is the typed
--    warn-only switch. Authenticated may read that one column and nothing else.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.media_retention_settings (
  id int PRIMARY KEY DEFAULT 1,
  rollout_at timestamptz NOT NULL DEFAULT now(),
  delete_enabled boolean NOT NULL DEFAULT false,
  CONSTRAINT media_retention_settings_singleton CHECK (id = 1)
);

ALTER TABLE public.media_retention_settings
  ADD COLUMN IF NOT EXISTS rollout_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.media_retention_settings
  ADD COLUMN IF NOT EXISTS delete_enabled boolean NOT NULL DEFAULT false;

INSERT INTO public.media_retention_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.media_retention_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_retention_settings_select_delete_enabled
  ON public.media_retention_settings;
CREATE POLICY media_retention_settings_select_delete_enabled
  ON public.media_retention_settings
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS media_retention_settings_service_all
  ON public.media_retention_settings;
CREATE POLICY media_retention_settings_service_all
  ON public.media_retention_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE public.media_retention_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT (delete_enabled) ON public.media_retention_settings TO authenticated;
GRANT ALL ON TABLE public.media_retention_settings TO service_role;

COMMENT ON TABLE public.media_retention_settings IS
  'One row (id = 1). rollout_at is the age floor for files that predate retention. delete_enabled false means warn only.';

-- ---------------------------------------------------------------------------
-- 4. Set-based in-use load. Returns false when the settings row is missing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_prepare(p_now timestamptz, p_user uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;

  DROP TABLE IF EXISTS pg_temp.mret_used;
  DROP TABLE IF EXISTS pg_temp.mret_addr;
  DROP TABLE IF EXISTS pg_temp.mret_blob;
  DROP TABLE IF EXISTS pg_temp.mret_cand;
  DROP TABLE IF EXISTS pg_temp.mret_cfg;

  CREATE TEMP TABLE mret_cfg AS
  SELECT s.rollout_at, s.delete_enabled
  FROM public.media_retention_settings AS s
  WHERE s.id = 1;

  IF NOT EXISTS (SELECT 1 FROM pg_temp.mret_cfg) THEN
    RETURN false;
  END IF;

  CREATE TEMP TABLE mret_cand AS
  SELECT
    m.id,
    m.user_id,
    m.file_type,
    m.cloudinary_public_id,
    m.file_path,
    m.created_at,
    m.last_used_at,
    m.expires_at,
    m.retention_state,
    m.retention_claimed_at,
    m.retention_attempts,
    m.retention_next_attempt_at,
    m.keep_forever,
    m.storage_bucket,
    pr.media_retention_days AS retention_days,
    greatest(
      coalesce(m.created_at, cfg.rollout_at),
      coalesce(m.last_used_at, m.created_at, cfg.rollout_at),
      cfg.rollout_at
    ) AS age_basis,
    (
      m.storage_bucket IS NOT NULL
      AND m.storage_bucket NOT IN ('partner-media', 'media', 'supabase')
    ) AS in_scope,
    (
      (m.cloudinary_public_id IS NOT NULL AND btrim(m.cloudinary_public_id) <> '')
      OR EXISTS (
        SELECT 1 FROM public.media_file_providers AS p
        WHERE p.media_file_id = m.id
      )
    ) AS has_object
  FROM public.media_files AS m
  CROSS JOIN pg_temp.mret_cfg AS cfg
  LEFT JOIN public.profiles AS pr ON pr.id = m.user_id
  WHERE (p_user IS NULL OR m.user_id = p_user)
    AND (
      m.expires_at IS NOT NULL
      OR m.retention_state IS NOT NULL
      OR (
        m.keep_forever = false
        AND m.storage_bucket IS NOT NULL
        AND m.storage_bucket NOT IN ('partner-media', 'media', 'supabase')
        AND pr.media_retention_days IS NOT NULL
        AND greatest(
          coalesce(m.created_at, cfg.rollout_at),
          coalesce(m.last_used_at, m.created_at, cfg.rollout_at),
          cfg.rollout_at
        ) < p_now - make_interval(days => pr.media_retention_days)
        AND (
          (m.cloudinary_public_id IS NOT NULL AND btrim(m.cloudinary_public_id) <> '')
          OR EXISTS (
            SELECT 1 FROM public.media_file_providers AS p
            WHERE p.media_file_id = m.id
          )
        )
      )
    );

  ALTER TABLE pg_temp.mret_cand ADD PRIMARY KEY (id);

  CREATE TEMP TABLE mret_addr (
    id uuid NOT NULL,
    address text NOT NULL
  );

  INSERT INTO pg_temp.mret_addr (id, address)
  SELECT c.id, c.file_path
  FROM pg_temp.mret_cand AS c
  WHERE c.file_path IS NOT NULL AND btrim(c.file_path) <> ''
  UNION
  SELECT c.id, c.cloudinary_public_id
  FROM pg_temp.mret_cand AS c
  WHERE c.cloudinary_public_id IS NOT NULL AND btrim(c.cloudinary_public_id) <> ''
  UNION
  SELECT c.id, c.id::text
  FROM pg_temp.mret_cand AS c
  UNION
  SELECT c.id, p.delivery_url
  FROM pg_temp.mret_cand AS c
  JOIN public.media_file_providers AS p ON p.media_file_id = c.id
  WHERE p.delivery_url IS NOT NULL AND btrim(p.delivery_url) <> '';

  CREATE INDEX mret_addr_address_idx ON pg_temp.mret_addr (address);

  CREATE TEMP TABLE mret_blob (
    body text NOT NULL
  );

  INSERT INTO pg_temp.mret_blob (body)
  SELECT leaf.val
  FROM public.workflows AS w
  CROSS JOIN LATERAL jsonb_path_query(w.nodes, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE w.nodes IS NOT NULL AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.workflow_versions AS w
  CROSS JOIN LATERAL jsonb_path_query(w.nodes, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE w.nodes IS NOT NULL AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.workflow_templates AS w
  CROSS JOIN LATERAL jsonb_path_query(w.nodes, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE w.nodes IS NOT NULL AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.posts AS p
  CROSS JOIN LATERAL jsonb_path_query(p.metadata, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE p.metadata IS NOT NULL AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.image_reference_presets AS r
  CROSS JOIN LATERAL jsonb_path_query(r.reference_images, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.whatsapp_broadcasts AS b
  CROSS JOIN LATERAL jsonb_path_query(b.template_components, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE b.status NOT IN ('completed', 'failed')
    AND b.template_components IS NOT NULL
    AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT leaf.val
  FROM public.ai_generation_jobs AS j
  CROSS JOIN LATERAL jsonb_path_query(j.params, '$.** ? (@.type() == "string")') AS q(leaf)
  CROSS JOIN LATERAL (SELECT q.leaf #>> '{}') AS leaf(val)
  WHERE j.status NOT IN ('succeeded', 'failed', 'timeout')
    AND leaf.val IS NOT NULL AND length(leaf.val) >= 8
  UNION ALL
  SELECT s.value::text
  FROM public.app_settings AS s
  WHERE s.key IN ('app_logo', 'app_favicon')
    AND s.value IS NOT NULL
    AND length(s.value::text) >= 8;

  CREATE TEMP TABLE mret_used (
    id uuid PRIMARY KEY
  );

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT c.id
  FROM pg_temp.mret_cand AS c
  JOIN (
    SELECT x.mid
    FROM public.posts AS p
    CROSS JOIN LATERAL unnest(p.media_file_ids) AS x(mid)
    WHERE x.mid IS NOT NULL
  ) AS refs ON refs.mid = c.id
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT c.id
  FROM pg_temp.mret_cand AS c
  JOIN public.comment_workflow_rules AS r ON r.media_file_id = c.id
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT c.id
  FROM pg_temp.mret_cand AS c
  JOIN public.ai_generation_jobs AS j ON j.media_file_id = c.id
  WHERE j.status NOT IN ('succeeded', 'failed', 'timeout')
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.profiles AS pr ON pr.avatar_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.whatsapp_scheduled_messages AS m
    ON m.media_url = a.address
   AND m.status IN ('pending', 'claimed', 'sending')
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.whatsapp_messages AS m ON m.media_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.whatsapp_contacts AS ct ON ct.avatar_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.ai_knowledge_sources AS k ON k.file_path = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.workflows AS w ON w.thumbnail_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.workflow_templates AS t ON t.preview_image_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.blog_posts AS b ON b.cover_image_url = a.address
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.ai_generation_jobs AS j
    ON j.result_url = a.address
   AND j.status NOT IN ('succeeded', 'failed', 'timeout')
  ON CONFLICT DO NOTHING;

  -- Document text. strpos, not LIKE, so "%" in an address is not a pattern.
  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN pg_temp.mret_blob AS b ON strpos(b.body, a.address) > 0
  WHERE length(a.address) >= 8
  ON CONFLICT DO NOTHING;

  -- Shared (provider, object_key) on any other row, including rows this
  -- sweep will never delete.
  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT c.id
  FROM pg_temp.mret_cand AS c
  JOIN public.media_file_providers AS mine ON mine.media_file_id = c.id
  JOIN public.media_file_providers AS other
    ON other.provider = mine.provider
   AND other.object_key = mine.object_key
   AND other.media_file_id <> c.id
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.media_files AS other
    ON other.file_path = a.address
   AND other.id <> a.id
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.mret_used (id)
  SELECT DISTINCT a.id
  FROM pg_temp.mret_addr AS a
  JOIN public.media_file_providers AS other
    ON other.delivery_url = a.address
   AND other.media_file_id <> a.id
  ON CONFLICT DO NOTHING;

  ANALYZE pg_temp.mret_cand;
  ANALYZE pg_temp.mret_addr;
  ANALYZE pg_temp.mret_used;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_prepare(timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_prepare(timestamptz, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Sweep. Clear, then stale deleting -> warned, then warn.
--    Does not claim and does not look at delete_enabled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_sweep(
  p_now timestamptz DEFAULT now(),
  p_limit int DEFAULT 50
)
RETURNS TABLE (phase text, count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cleared int := 0;
  v_stale int := 0;
  v_warned int := 0;
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    p_limit := 50;
  ELSIF p_limit > 500 THEN
    p_limit := 500;
  END IF;

  IF NOT public.media_retention_prepare(p_now, NULL) THEN
    RETURN;
  END IF;

  UPDATE public.media_files AS m
  SET expires_at = NULL,
      retention_state = NULL,
      retention_claimed_at = NULL,
      retention_attempts = 0,
      retention_next_attempt_at = NULL
  FROM (
    SELECT c.id
    FROM pg_temp.mret_cand AS c
    WHERE (c.expires_at IS NOT NULL OR c.retention_state IS NOT NULL)
      AND (
        EXISTS (SELECT 1 FROM pg_temp.mret_used AS u WHERE u.id = c.id)
        OR c.keep_forever
        OR c.retention_days IS NULL
        OR NOT c.in_scope
        OR NOT c.has_object
        OR (
          c.retention_days IS NOT NULL
          AND c.age_basis >= p_now - make_interval(days => c.retention_days)
        )
      )
    ORDER BY c.expires_at NULLS LAST, c.id
    LIMIT p_limit
  ) AS picked
  WHERE m.id = picked.id;
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  UPDATE public.media_files AS m
  SET retention_state = 'warned',
      retention_claimed_at = NULL
  FROM (
    SELECT c.id
    FROM pg_temp.mret_cand AS c
    WHERE c.retention_state = 'deleting'
      AND (c.retention_claimed_at IS NULL OR c.retention_claimed_at < p_now - interval '1 hour')
      AND NOT EXISTS (SELECT 1 FROM pg_temp.mret_used AS u WHERE u.id = c.id)
      AND NOT c.keep_forever
      AND c.retention_days IS NOT NULL
      AND c.in_scope
      AND c.has_object
      AND c.age_basis < p_now - make_interval(days => c.retention_days)
    ORDER BY c.retention_claimed_at NULLS FIRST, c.id
    LIMIT p_limit
  ) AS picked
  WHERE m.id = picked.id
    AND m.retention_state = 'deleting';
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  DROP TABLE IF EXISTS pg_temp.mret_warned;
  CREATE TEMP TABLE mret_warned (user_id uuid);

  WITH picked AS (
    SELECT c.id
    FROM pg_temp.mret_cand AS c
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.mret_used AS u WHERE u.id = c.id)
      AND NOT c.keep_forever
      AND c.retention_days IS NOT NULL
      AND c.in_scope
      AND c.has_object
      AND c.expires_at IS NULL
      AND c.retention_state IS DISTINCT FROM 'deleting'
      AND c.age_basis < p_now - make_interval(days => c.retention_days)
    ORDER BY c.age_basis, c.id
    LIMIT p_limit
  ),
  upd AS (
    UPDATE public.media_files AS m
    SET expires_at = p_now + interval '7 days',
        retention_state = 'warned',
        retention_claimed_at = NULL,
        retention_attempts = 0,
        retention_next_attempt_at = NULL
    FROM picked
    WHERE m.id = picked.id
      AND m.expires_at IS NULL
      AND m.retention_state IS DISTINCT FROM 'deleting'
    RETURNING m.user_id
  )
  INSERT INTO pg_temp.mret_warned (user_id)
  SELECT upd.user_id FROM upd;

  SELECT coalesce(sum(1), 0)::int INTO v_warned FROM pg_temp.mret_warned;

  INSERT INTO public.system_logs (source, category, level, message, user_id, metadata)
  SELECT 'media-retention',
         'system',
         'info',
         'Media retention warned unused files',
         w.user_id,
         jsonb_build_object('warned_count', sum(1)::int)
  FROM pg_temp.mret_warned AS w
  GROUP BY w.user_id;

  phase := 'clear';
  count := v_cleared + v_stale;
  RETURN NEXT;
  phase := 'warn';
  count := v_warned;
  RETURN NEXT;
  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_sweep(timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_sweep(timestamptz, int) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Claim. Returns nothing while delete_enabled is false or the settings
--    row is missing. Locked rows are rechecked before the stamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_claim(
  p_now timestamptz DEFAULT now(),
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  media_file_id uuid,
  user_id uuid,
  file_type text,
  cloudinary_public_id text,
  file_path text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_now IS NULL THEN
    p_now := now();
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    p_limit := 50;
  ELSIF p_limit > 500 THEN
    p_limit := 500;
  END IF;

  IF NOT public.media_retention_prepare(p_now, NULL) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_temp.mret_cfg AS cfg WHERE cfg.delete_enabled IS TRUE) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.media_files AS m
  SET retention_state = 'deleting',
      retention_claimed_at = now()
  WHERE m.id IN (
    SELECT m2.id
    FROM public.media_files AS m2
    JOIN pg_temp.mret_cand AS c ON c.id = m2.id
    WHERE NOT EXISTS (SELECT 1 FROM pg_temp.mret_used AS u WHERE u.id = m2.id)
      AND c.keep_forever = false
      AND c.retention_days IS NOT NULL
      AND c.in_scope
      AND c.has_object
      AND m2.expires_at IS NOT NULL
      AND m2.expires_at <= p_now
      AND m2.retention_state = 'warned'
      AND (m2.retention_next_attempt_at IS NULL OR m2.retention_next_attempt_at <= p_now)
      AND m2.retention_attempts < 5
      AND c.age_basis < p_now - make_interval(days => c.retention_days)
    ORDER BY m2.retention_next_attempt_at NULLS FIRST, m2.expires_at, m2.id
    LIMIT p_limit
    FOR UPDATE OF m2 SKIP LOCKED
  )
  RETURNING m.id, m.user_id, m.file_type, m.cloudinary_public_id, m.file_path;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_claim(timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_claim(timestamptz, int) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. Release. Scoped to the claim's owner: a release can only ever touch the
--    row it claimed for that user, never another tenant's id collision.
--    p_failed true counts an attempt and backs off from the previous
--    attempt count (first failure waits 15 minutes, then 30, 60, 120). The
--    5th failure stays warned, is not claimable, and writes one log row.
--    p_failed false puts an unstarted claim back to warned with no attempt
--    and no backoff (the worker ran out of time before touching the file).
--    Drop first: the prior signature (p_id, p_failed) had no owner scope.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.media_retention_release(uuid, boolean);
CREATE OR REPLACE FUNCTION public.media_retention_release(p_id uuid, p_user_id uuid, p_failed boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user uuid;
  v_attempts int;
BEGIN
  IF p_id IS NULL OR p_user_id IS NULL OR p_failed IS NULL THEN
    RAISE EXCEPTION 'media_retention_release: p_id, p_user_id and p_failed are required'
      USING ERRCODE = '22023';
  END IF;

  IF NOT p_failed THEN
    UPDATE public.media_files AS m
    SET retention_state = 'warned',
        retention_claimed_at = NULL
    WHERE m.id = p_id
      AND m.user_id = p_user_id
      AND m.retention_state = 'deleting';
    RETURN;
  END IF;

  UPDATE public.media_files AS m
  SET retention_state = 'warned',
      retention_claimed_at = NULL,
      retention_attempts = m.retention_attempts + 1,
      retention_next_attempt_at = CASE
        WHEN m.retention_attempts + 1 >= 5 THEN 'infinity'::timestamptz
        ELSE now() + least(
          interval '24 hours',
          interval '15 minutes' * power(2, m.retention_attempts)
        )
      END
  WHERE m.id = p_id
    AND m.user_id = p_user_id
    AND m.retention_state = 'deleting'
  RETURNING m.user_id, m.retention_attempts INTO v_user, v_attempts;

  IF NOT FOUND OR v_attempts < 5 THEN
    RETURN;
  END IF;

  INSERT INTO public.system_logs (source, category, level, message, user_id, metadata)
  VALUES (
    'media-retention',
    'system',
    'warn',
    'Media retention stopped retrying a file delete',
    v_user,
    jsonb_build_object(
      'reason', 'attempts_exhausted',
      'attempts', v_attempts,
      'media_file_id', p_id
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_release(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_release(uuid, uuid, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Preview. Same eligibility, no library or log writes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_preview(p_user uuid DEFAULT NULL)
RETURNS TABLE (
  media_file_id uuid,
  user_id uuid,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.media_retention_prepare(now(), p_user) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.user_id,
    CASE
      WHEN c.expires_at IS NOT NULL AND c.expires_at <= now() THEN 'due'::text
      ELSE 'would_warn'::text
    END
  FROM pg_temp.mret_cand AS c
  WHERE NOT EXISTS (SELECT 1 FROM pg_temp.mret_used AS u WHERE u.id = c.id)
    AND c.keep_forever = false
    AND c.retention_days IS NOT NULL
    AND c.in_scope
    AND c.has_object
    AND c.retention_state IS DISTINCT FROM 'deleting'
    AND c.age_basis < now() - make_interval(days => c.retention_days)
    AND (
      c.expires_at IS NULL
      OR (
        c.retention_state = 'warned'
        AND c.expires_at <= now()
        AND c.retention_attempts < 5
        AND (c.retention_next_attempt_at IS NULL OR c.retention_next_attempt_at <= now())
      )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_preview(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_retention_preview(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Owner keep. A row in 'deleting' is refused. Other users' ids are ignored.
--    Returns the number of rows updated. Drop first so a re-apply can change
--    the return type from an earlier draft of this file.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.media_set_keep(uuid[], boolean);
CREATE FUNCTION public.media_set_keep(p_ids uuid[], p_keep boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'media_set_keep: not authenticated'
      USING ERRCODE = '42501';
  END IF;
  IF p_keep IS NULL THEN
    RAISE EXCEPTION 'media_set_keep: p_keep is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.media_files AS m
    WHERE m.id = ANY (p_ids)
      AND m.user_id = v_uid
      AND m.retention_state = 'deleting'
  ) THEN
    RAISE EXCEPTION 'This file is being deleted from your library'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.media_files AS m
  SET keep_forever = p_keep,
      expires_at = NULL,
      retention_state = NULL,
      retention_claimed_at = NULL,
      retention_attempts = 0,
      retention_next_attempt_at = NULL
  WHERE m.id = ANY (p_ids)
    AND m.user_id = v_uid;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_set_keep(uuid[], boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.media_set_keep(uuid[], boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. Column guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_files_retention_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.keep_forever IS TRUE
      OR NEW.last_used_at IS NOT NULL
      OR NEW.expires_at IS NOT NULL
      OR NEW.retention_state IS NOT NULL
      OR NEW.retention_claimed_at IS NOT NULL
      OR NEW.retention_attempts IS DISTINCT FROM 0
      OR NEW.retention_next_attempt_at IS NOT NULL THEN
      RAISE EXCEPTION 'media_files: clients cannot set retention columns'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.keep_forever IS DISTINCT FROM OLD.keep_forever
    OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.retention_state IS DISTINCT FROM OLD.retention_state
    OR NEW.retention_claimed_at IS DISTINCT FROM OLD.retention_claimed_at
    OR NEW.retention_attempts IS DISTINCT FROM OLD.retention_attempts
    OR NEW.retention_next_attempt_at IS DISTINCT FROM OLD.retention_next_attempt_at THEN
    RAISE EXCEPTION 'media_files: clients cannot set retention columns'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_files_retention_column_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS media_files_retention_column_guard ON public.media_files;
CREATE TRIGGER media_files_retention_column_guard
  BEFORE INSERT OR UPDATE ON public.media_files
  FOR EACH ROW EXECUTE FUNCTION public.media_files_retention_column_guard();

-- ---------------------------------------------------------------------------
-- 11. Reference guard. PK or indexed url lookup, row-locked, scoped to the
--     writing row's own owner: every table this trigger fires on carries
--     user_id, so a match against another tenant's deleting file must never
--     abort this write. (The in-use protection used by sweep/claim/preview
--     stays cross-tenant on purpose -- it is not this trigger.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_reference_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'posts' THEN
    IF NEW.media_file_ids IS NULL OR cardinality(NEW.media_file_ids) = 0 THEN
      RETURN NEW;
    END IF;
    PERFORM 1
    FROM public.media_files AS m
    WHERE m.id = ANY (NEW.media_file_ids)
      AND m.retention_state = 'deleting'
      AND m.user_id = NEW.user_id
    FOR UPDATE OF m;
  ELSIF TG_TABLE_NAME = 'comment_workflow_rules' THEN
    IF NEW.media_file_id IS NULL THEN
      RETURN NEW;
    END IF;
    PERFORM 1
    FROM public.media_files AS m
    WHERE m.id = NEW.media_file_id
      AND m.retention_state = 'deleting'
      AND m.user_id = NEW.user_id
    FOR UPDATE OF m;
  ELSE
    IF NEW.media_url IS NULL OR btrim(NEW.media_url) = '' THEN
      RETURN NEW;
    END IF;
    PERFORM 1
    FROM public.media_files AS m
    WHERE m.retention_state = 'deleting'
      AND m.user_id = NEW.user_id
      AND (
        m.file_path = NEW.media_url
        OR m.cloudinary_public_id = NEW.media_url
        OR EXISTS (
          SELECT 1
          FROM public.media_file_providers AS p
          WHERE p.media_file_id = m.id
            AND p.delivery_url = NEW.media_url
        )
      )
    FOR UPDATE OF m;
  END IF;

  IF FOUND THEN
    RAISE EXCEPTION 'This file is being deleted from your library'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_reference_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS media_retention_guard_posts ON public.posts;
CREATE TRIGGER media_retention_guard_posts
  BEFORE INSERT OR UPDATE OF media_file_ids ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_reference_guard();

DROP TRIGGER IF EXISTS media_retention_guard_comment_rules ON public.comment_workflow_rules;
CREATE TRIGGER media_retention_guard_comment_rules
  BEFORE INSERT OR UPDATE OF media_file_id ON public.comment_workflow_rules
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_reference_guard();

DROP TRIGGER IF EXISTS media_retention_guard_wa_scheduled ON public.whatsapp_scheduled_messages;
CREATE TRIGGER media_retention_guard_wa_scheduled
  BEFORE INSERT OR UPDATE OF media_url ON public.whatsapp_scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_reference_guard();

DROP TRIGGER IF EXISTS media_retention_guard_wa_messages ON public.whatsapp_messages;
CREATE TRIGGER media_retention_guard_wa_messages
  BEFORE INSERT OR UPDATE OF media_url ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_reference_guard();

-- ---------------------------------------------------------------------------
-- 12. last_used_at bookkeeping. Best-effort, owner-scoped, skips 'deleting'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_retention_touch_used()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  BEGIN
    IF TG_TABLE_NAME = 'posts' THEN
      IF NEW.media_file_ids IS NULL OR cardinality(NEW.media_file_ids) = 0 THEN
        RETURN NEW;
      END IF;
      UPDATE public.media_files AS m
      SET last_used_at = now(),
          expires_at = NULL,
          retention_state = NULL,
          retention_claimed_at = NULL
      WHERE m.user_id = NEW.user_id
        AND m.id = ANY (NEW.media_file_ids)
        AND m.retention_state IS DISTINCT FROM 'deleting';
    ELSIF TG_TABLE_NAME = 'comment_workflow_rules' THEN
      IF NEW.media_file_id IS NULL THEN
        RETURN NEW;
      END IF;
      UPDATE public.media_files AS m
      SET last_used_at = now(),
          expires_at = NULL,
          retention_state = NULL,
          retention_claimed_at = NULL
      WHERE m.user_id = NEW.user_id
        AND m.id = NEW.media_file_id
        AND m.retention_state IS DISTINCT FROM 'deleting';
    ELSE
      IF NEW.media_url IS NULL OR btrim(NEW.media_url) = '' THEN
        RETURN NEW;
      END IF;
      UPDATE public.media_files AS m
      SET last_used_at = now(),
          expires_at = NULL,
          retention_state = NULL,
          retention_claimed_at = NULL
      WHERE m.user_id = NEW.user_id
        AND m.retention_state IS DISTINCT FROM 'deleting'
        AND (
          m.file_path = NEW.media_url
          OR m.cloudinary_public_id = NEW.media_url
          OR EXISTS (
            SELECT 1
            FROM public.media_file_providers AS p
            WHERE p.media_file_id = m.id
              AND p.delivery_url = NEW.media_url
          )
        );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'media_retention last_used_at skipped on %: %', TG_TABLE_NAME, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.media_retention_touch_used() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS media_retention_touch_posts ON public.posts;
CREATE TRIGGER media_retention_touch_posts
  AFTER INSERT OR UPDATE OF media_file_ids ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_touch_used();

DROP TRIGGER IF EXISTS media_retention_touch_comment_rules ON public.comment_workflow_rules;
CREATE TRIGGER media_retention_touch_comment_rules
  AFTER INSERT OR UPDATE OF media_file_id ON public.comment_workflow_rules
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_touch_used();

DROP TRIGGER IF EXISTS media_retention_touch_wa_scheduled ON public.whatsapp_scheduled_messages;
CREATE TRIGGER media_retention_touch_wa_scheduled
  AFTER INSERT OR UPDATE OF media_url ON public.whatsapp_scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_touch_used();

DROP TRIGGER IF EXISTS media_retention_touch_wa_messages ON public.whatsapp_messages;
CREATE TRIGGER media_retention_touch_wa_messages
  AFTER INSERT OR UPDATE OF media_url ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.media_retention_touch_used();

-- ---------------------------------------------------------------------------
-- 13. Cron every 15 minutes. cleanup-media is removed. The new job is
--     scheduled only when pg_cron, pg_net and get_cron_secret() are present
--     and the name is absent. A missing guard is a NOTICE.
-- ---------------------------------------------------------------------------
DO $do_media_retention_cron$
DECLARE
  v_jobid bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-media') THEN
      PERFORM cron.unschedule('cleanup-media');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-retention') THEN
      SELECT cron.schedule(
        'media-retention',
        '*/15 * * * *',
        $cron$
        SELECT net.http_post(
          url := 'https://api.postora.cloud/functions/v1/media-retention',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || get_cron_secret()
          ),
          body := '{}'::jsonb
        );
        $cron$
      ) INTO v_jobid;
    END IF;
  ELSE
    RAISE NOTICE 'media-retention cron skipped: pg_cron, pg_net, or get_cron_secret() unavailable';
  END IF;
END $do_media_retention_cron$;
