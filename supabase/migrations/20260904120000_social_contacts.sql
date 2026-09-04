-- Audience hub: one row per (owner, platform, commenter identity). Written by the service role
-- from the comment ingest paths through touch_social_contact; read and edited by the owner.

ALTER TABLE public.whatsapp_contacts
  DROP CONSTRAINT IF EXISTS whatsapp_contacts_id_user_id_key;
ALTER TABLE public.whatsapp_contacts
  ADD CONSTRAINT whatsapp_contacts_id_user_id_key UNIQUE (id, user_id);

CREATE TABLE public.social_contacts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id         uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  social_account_id    uuid,
  platform             text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'threads', 'youtube')),
  platform_user_id     text NOT NULL,
  identity_kind        text NOT NULL DEFAULT 'id' CHECK (identity_kind IN ('id', 'username')),
  display_name         text NOT NULL DEFAULT '',
  username             text,
  profile_url          text,
  email                text,
  phone_number         text,
  company              text,
  notes                text,
  source               text NOT NULL DEFAULT 'organic_comment' CHECK (source IN ('organic_comment', 'workflow_lead')),
  tags                 text[] NOT NULL DEFAULT '{}',
  whatsapp_contact_id  uuid,
  total_comments_count integer NOT NULL DEFAULT 1 CHECK (total_comments_count >= 0),
  first_interacted_at  timestamptz NOT NULL DEFAULT now(),
  last_interacted_at   timestamptz NOT NULL DEFAULT now(),
  last_comment_text    text,
  last_post_id         text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_contacts_identity_key UNIQUE (user_id, platform, platform_user_id),
  -- Composite FKs keep an authenticated UPDATE from attaching another owner's row by guessed UUID.
  -- The column-list SET NULL form (PG15+) nulls only the reference, never user_id.
  CONSTRAINT social_contacts_social_account_tenant_fk
    FOREIGN KEY (social_account_id, user_id) REFERENCES public.social_accounts (id, user_id)
    ON DELETE SET NULL (social_account_id),
  CONSTRAINT social_contacts_whatsapp_contact_tenant_fk
    FOREIGN KEY (whatsapp_contact_id, user_id) REFERENCES public.whatsapp_contacts (id, user_id)
    ON DELETE SET NULL (whatsapp_contact_id)
);

CREATE TRIGGER update_social_contacts_updated_at
  BEFORE UPDATE ON public.social_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX social_contacts_user_last_active_idx ON public.social_contacts (user_id, last_interacted_at DESC);
CREATE INDEX social_contacts_user_platform_idx    ON public.social_contacts (user_id, platform);
CREATE INDEX social_contacts_tags_gin_idx         ON public.social_contacts USING GIN (tags);
CREATE INDEX social_contacts_social_account_idx   ON public.social_contacts (social_account_id);
CREATE INDEX social_contacts_whatsapp_contact_idx ON public.social_contacts (whatsapp_contact_id) WHERE whatsapp_contact_id IS NOT NULL;
CREATE INDEX social_contacts_threads_username_idx ON public.social_contacts (user_id, username) WHERE platform = 'threads';

ALTER TABLE public.social_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own social contacts"   ON public.social_contacts FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users can insert own social contacts" ON public.social_contacts FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own social contacts" ON public.social_contacts FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own social contacts" ON public.social_contacts FOR DELETE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Admins can view all social contacts"  ON public.social_contacts FOR SELECT USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Writer. Owner and workspace come from the account row, never from the caller. Invoker rights:
-- the only role that may execute is service_role, which bypasses RLS on its own.
CREATE OR REPLACE FUNCTION public.touch_social_contact(
  p_social_account_id uuid, p_platform text, p_author_id text, p_author_name text,
  p_author_username text, p_comment_text text, p_post_id text
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_user_id uuid; v_workspace_id uuid;
  v_author_id text := nullif(btrim(p_author_id), '');
  v_username  text := nullif(btrim(p_author_username), '');
  v_name      text := nullif(btrim(p_author_name), '');
  v_identity  text; v_kind text; v_id uuid;
BEGIN
  SELECT user_id, workspace_id INTO v_user_id, v_workspace_id
    FROM public.social_accounts WHERE id = p_social_account_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'social_account_not_found'; END IF;

  v_identity := coalesce(v_author_id, v_username);
  IF v_identity IS NULL THEN RETURN NULL; END IF;
  v_kind := CASE WHEN v_author_id IS NULL THEN 'username' ELSE 'id' END;

  -- Threads is the one platform that reports the same person two ways: a reply carries only a
  -- handle (threads-webhook/replyEvents.ts sets the id to null) while a polled mention carries
  -- an id. Both directions have to land on one row, or a commenter who does both is counted
  -- twice for good and neither row can ever absorb the other.
  IF p_platform = 'threads' AND v_username IS NOT NULL THEN
    IF v_author_id IS NOT NULL THEN
      -- An id arrived. Re-key the handle's row unless an id row already exists, in which case
      -- the two are genuinely different rows and the insert below just increments the id one.
      IF NOT EXISTS (SELECT 1 FROM public.social_contacts
                     WHERE user_id = v_user_id AND platform = 'threads'
                       AND platform_user_id = v_author_id) THEN
        UPDATE public.social_contacts
           SET platform_user_id = v_author_id, identity_kind = 'id'
         WHERE user_id = v_user_id AND platform = 'threads' AND identity_kind = 'username'
           AND platform_user_id = v_username;
      END IF;
    ELSE
      -- No id this time. If this handle is already known by id, count against that row rather
      -- than starting a handle-keyed twin that nothing would ever merge back.
      SELECT platform_user_id INTO v_identity
        FROM public.social_contacts
       WHERE user_id = v_user_id AND platform = 'threads' AND identity_kind = 'id'
         AND username = v_username
       LIMIT 1;
      IF v_identity IS NULL THEN
        v_identity := v_username;
      ELSE
        v_kind := 'id';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.social_contacts
    (user_id, workspace_id, social_account_id, platform, platform_user_id, identity_kind,
     display_name, username, last_comment_text, last_post_id)
  VALUES
    (v_user_id, v_workspace_id, p_social_account_id, p_platform, v_identity, v_kind,
     coalesce(v_name, v_username, ''), v_username, left(p_comment_text, 500), p_post_id)
  ON CONFLICT (user_id, platform, platform_user_id) DO UPDATE SET
    total_comments_count = public.social_contacts.total_comments_count + 1,
    last_interacted_at   = now(),
    last_comment_text    = EXCLUDED.last_comment_text,
    last_post_id         = EXCLUDED.last_post_id,
    social_account_id    = EXCLUDED.social_account_id,
    workspace_id         = coalesce(EXCLUDED.workspace_id, public.social_contacts.workspace_id),
    display_name         = CASE WHEN v_name IS NULL THEN public.social_contacts.display_name ELSE v_name END,
    username             = coalesce(EXCLUDED.username, public.social_contacts.username)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.touch_social_contact(uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.touch_social_contact(uuid, text, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_social_contacts_stats()
RETURNS TABLE (total bigint, workflow_leads bigint, enriched bigint, top_platform text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE source = 'workflow_lead'),
    count(*) FILTER (WHERE phone_number IS NOT NULL OR email IS NOT NULL),
    (SELECT platform FROM public.social_contacts
      WHERE user_id = auth.uid() GROUP BY platform ORDER BY count(*) DESC, platform LIMIT 1)
  FROM public.social_contacts WHERE user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_social_contacts_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_social_contacts_stats() TO authenticated;

-- Search. The term is a bound parameter; wildcard characters are escaped here so the frontend
-- never assembles a PostgREST filter string. row_count is the unpaged total for pagination.
-- `contact` is jsonb, not social_contacts. Returning the table's composite type from a
-- RETURNS TABLE function segfaults PostgreSQL 17.6 at CREATE time -- reproduced on a stock
-- supabase/postgres:17.6.1.138 with a two-column table and no Postora code:
--   CREATE FUNCTION f() RETURNS TABLE(n bigint, rec t) LANGUAGE sql STABLE AS
--     $x$ WITH m AS (SELECT * FROM t) SELECT (SELECT count(*) FROM m), x FROM m x; $x$;
--   -> server process was terminated by signal 11: Segmentation fault
-- to_jsonb() also spares supabase-js a nested composite it decodes awkwardly.
CREATE OR REPLACE FUNCTION public.search_social_contacts(
  p_query text, p_platform text, p_source text, p_tags text[], p_limit int, p_offset int
) RETURNS TABLE (row_count bigint, contact jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH term AS (
    SELECT CASE WHEN nullif(btrim(p_query), '') IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' END AS pattern
  ),
  matched AS (
    SELECT c.* FROM public.social_contacts c, term
    WHERE c.user_id = auth.uid()
      AND (p_platform IS NULL OR c.platform = p_platform)
      AND (p_source IS NULL OR c.source = p_source)
      AND (p_tags IS NULL OR cardinality(p_tags) = 0 OR c.tags @> p_tags)
      AND (term.pattern IS NULL
           OR c.display_name ILIKE term.pattern OR c.username ILIKE term.pattern
           OR c.email ILIKE term.pattern OR c.phone_number ILIKE term.pattern)
  )
  SELECT (SELECT count(*) FROM matched), to_jsonb(m)
  FROM matched m
  ORDER BY m.last_interacted_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0));
$$;
REVOKE ALL ON FUNCTION public.search_social_contacts(text, text, text, text[], int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_social_contacts(text, text, text, text[], int, int) TO authenticated;

INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_audience_hub', 'false'::jsonb, 'Show Audience & Contacts under Automation for non-admin users')
ON CONFLICT (key) DO NOTHING;

-- Seed from the comment history already on disk. Three payload shapes reach this table:
--   Meta          -- the whole `change`, so the author is at value.from
--   Threads webhook -- `change.value`, so a mention's author is at from.id and a reply carries
--                      only a top-level username (replyEvents.ts sets the id to null)
--   Threads poller  -- the raw mention, whose author is at user.id
-- Idempotent: a rerun only re-counts.
INSERT INTO public.social_contacts
  (user_id, workspace_id, social_account_id, platform, platform_user_id, identity_kind,
   display_name, username, total_comments_count, first_interacted_at, last_interacted_at)
SELECT a.user_id,
       (array_agg(a.workspace_id) FILTER (WHERE a.workspace_id IS NOT NULL))[1],
       (array_agg(e.social_account_id) FILTER (WHERE e.social_account_id IS NOT NULL))[1],
       e.platform,
       coalesce(e.author_id, e.author_username),
       CASE WHEN e.author_id IS NULL THEN 'username' ELSE 'id' END,
       coalesce(max(e.author_name), max(e.author_username), ''),
       max(e.author_username),
       count(*), min(e.created_at), max(e.created_at)
FROM (
  SELECT s.user_id, s.social_account_id, s.platform, s.created_at,
         nullif(coalesce(s.payload->'value'->'from'->>'id',
                         s.payload->'from'->>'id',
                         s.payload->'user'->>'id'), '')                                            AS author_id,
         nullif(coalesce(s.payload->'value'->'from'->>'username',
                         s.payload->>'username',
                         s.payload->'from'->>'username',
                         s.payload->'user'->>'username'), '')                                    AS author_username,
         nullif(s.payload->'value'->'from'->>'name', '')                                         AS author_name
  FROM public.social_inbox_events s
  WHERE s.event_type = 'comment'
) e
JOIN public.social_accounts a ON a.id = e.social_account_id
WHERE coalesce(e.author_id, e.author_username) IS NOT NULL
  -- The account's own comments are excluded at ingest by isOwnComment; do the same here.
  AND (e.author_id IS NULL OR e.author_id IS DISTINCT FROM a.platform_user_id)
  AND (e.author_username IS NULL OR lower(e.author_username) IS DISTINCT FROM lower(a.platform_username))
-- Group by the unique key only. The same commenter reached through two of the owner's accounts
-- is one row; grouping by account would make the second group collide and DO NOTHING drop it.
GROUP BY a.user_id, e.platform, coalesce(e.author_id, e.author_username), (e.author_id IS NULL)
ON CONFLICT (user_id, platform, platform_user_id) DO NOTHING;
