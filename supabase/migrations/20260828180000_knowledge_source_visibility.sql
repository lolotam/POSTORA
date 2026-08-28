-- Knowledge visibility becomes explicit state on the source.
--
-- Until now, whether an account could read a source was inferred from the
-- SHAPE of its links: an account with zero links at all fell back to the
-- owner's whole corpus (20260828160000, ownership-guarded by 20260828170000).
-- That rule is non-monotonic, and permission-shaped state must never be:
--
--   * removing a source's LAST link GRANTS that account the entire corpus;
--   * adding a source's FIRST link SHRINKS its access from everything to one
--     document.
--
-- The fix is to make visibility a column. A source is visible to an account
-- when `visibility = 'shared'` OR an explicit ai_knowledge_source_accounts row
-- links them. Existing rows default to 'shared', which preserves today's
-- effective behaviour: the 20260828140000 backfill linked every then-existing
-- source to every active agent account, and sources created since (profile
-- text, catalogs) were only ever intended for every agent of the owner.
-- Nothing in the UI can remove a single link yet, so no live behaviour
-- changes with this migration -- it makes the invariant safe before PR C
-- makes link editing reachable.
--
-- Absence of a link now means "no access" for a restricted source, never
-- "access to everything".

BEGIN;

-- ---------------------------------------------------------------------------
-- A. The visibility column
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_knowledge_sources
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'shared';

-- NOT NULL DEFAULT backfills existing rows to 'shared' in the same statement,
-- so no separate UPDATE is needed (and none would be safe to skip: a NULL
-- visibility would have to be interpreted as something, and both candidate
-- meanings -- shared or restricted -- silently change someone's corpus).
ALTER TABLE public.ai_knowledge_sources
  DROP CONSTRAINT IF EXISTS ai_knowledge_sources_visibility_check;
ALTER TABLE public.ai_knowledge_sources
  ADD CONSTRAINT ai_knowledge_sources_visibility_check
  CHECK (visibility IN ('shared', 'restricted'));

-- ---------------------------------------------------------------------------
-- B. Retrieval: shared-or-explicitly-linked, replacing the zero-link fallback
-- ---------------------------------------------------------------------------
-- The link branch is unchanged from 20260828170000: it still verifies the
-- linked account belongs to p_user_id, because these functions are called by
-- Edge Functions under the service role and cannot rely on RLS. The
-- ai_knowledge_account_reads_whole_corpus fallback is replaced by the
-- source's own visibility, read through the ownership join the query already
-- performs.
--
-- The shared branch is gated the same way: a source being shared says every
-- ACCOUNT OF THE CALLER may read it, so retrieval first proves the named
-- account belongs to p_user_id. Without that gate, naming somebody else's
-- account id (or a nonexistent one) switched per-account scoping off for the
-- whole shared corpus -- the exact defect class 20260828170000 closed for
-- the old fallback, reopened through the new branch. The ownership EXISTS
-- references only the constant parameters, so Postgres evaluates it as an
-- InitPlan: once per call, not per row.

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks_for_account(
  query_embedding vector,
  p_user_id uuid,
  p_social_account_id uuid,
  match_count integer DEFAULT 6
)
RETURNS TABLE (id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
LANGUAGE sql
STABLE
AS $function$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks AS c
  JOIN public.ai_knowledge_sources AS s
    ON s.id = c.source_id AND s.user_id = p_user_id
  WHERE c.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS owned
      WHERE owned.id = p_social_account_id
        AND owned.user_id = p_user_id
    )
    AND (
      s.visibility = 'shared'
      OR EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$function$;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_chunks_bge_m3_for_account(
  query_embedding vector,
  p_user_id uuid,
  p_social_account_id uuid,
  match_count integer DEFAULT 6
)
RETURNS TABLE (id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
LANGUAGE sql
STABLE
AS $function$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding_bge_m3 <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks AS c
  JOIN public.ai_knowledge_sources AS s
    ON s.id = c.source_id AND s.user_id = p_user_id
  WHERE c.user_id = p_user_id
    AND c.embedding_bge_m3 IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS owned
      WHERE owned.id = p_social_account_id
        AND owned.user_id = p_user_id
    )
    AND (
      s.visibility = 'shared'
      OR EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
    )
  ORDER BY c.embedding_bge_m3 <=> query_embedding
  LIMIT match_count;
$function$;

-- Graph expansion still filters by RELATION PROVENANCE, not by entity:
-- entities are shared across a user's sources, so an entity-level filter
-- would let a linked source's entity pull in relations extracted from an
-- unlinked one. The shared branch therefore reads the visibility of the
-- chunk's OWN source, ownership-scoped, exactly as the chunk matchers do.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_graph_relations_for_account(
  p_user_id uuid,
  p_social_account_id uuid,
  p_source_chunk_ids uuid[],
  match_count integer DEFAULT 12
)
RETURNS TABLE (source_name text, source_type text, relation text, target_name text, target_type text)
LANGUAGE sql
STABLE
AS $function$
  WITH visible_relations AS (
    SELECT relation.*
    FROM public.ai_knowledge_relations AS relation
    JOIN public.ai_knowledge_chunks AS chunk
      ON chunk.id = relation.source_chunk_id
    WHERE relation.user_id = p_user_id
      AND EXISTS (
        SELECT 1
        FROM public.social_accounts AS owned
        WHERE owned.id = p_social_account_id
          AND owned.user_id = p_user_id
      )
      AND (
        EXISTS (
          SELECT 1
          FROM public.ai_knowledge_sources AS source
          WHERE source.id = chunk.source_id
            AND source.user_id = p_user_id
            AND source.visibility = 'shared'
        )
        OR EXISTS (
          SELECT 1
          FROM public.ai_knowledge_source_accounts AS link
          JOIN public.social_accounts AS account
            ON account.id = link.social_account_id AND account.user_id = p_user_id
          WHERE link.source_id = chunk.source_id
            AND link.social_account_id = p_social_account_id
        )
      )
  ),
  seed_entities AS (
    SELECT source_entity_id AS entity_id FROM visible_relations
    WHERE source_chunk_id = ANY(p_source_chunk_ids)
    UNION
    SELECT target_entity_id FROM visible_relations
    WHERE source_chunk_id = ANY(p_source_chunk_ids)
  )
  SELECT source.name, source.type, relation.relation, target.name, target.type
  FROM visible_relations AS relation
  JOIN public.ai_knowledge_entities AS source ON source.id = relation.source_entity_id
  JOIN public.ai_knowledge_entities AS target ON target.id = relation.target_entity_id
  WHERE relation.source_entity_id IN (SELECT entity_id FROM seed_entities)
     OR relation.target_entity_id IN (SELECT entity_id FROM seed_entities)
  ORDER BY relation.weight DESC, relation.created_at DESC
  LIMIT match_count;
$function$;

-- Nothing references the zero-link predicate any more: the three functions
-- above were its only callers, and no Edge Function invokes it directly.
DROP FUNCTION IF EXISTS public.ai_knowledge_account_reads_whole_corpus(uuid, uuid);

-- ---------------------------------------------------------------------------
-- C. create_ai_knowledge_source learns visibility
-- ---------------------------------------------------------------------------
-- The 4-argument signature is dropped rather than overloaded: an extra
-- defaulted parameter leaves PostgREST unable to disambiguate a 4-argument
-- call ("could not choose best candidate"). There are no callers today (the
-- function has existed unused since 20260828140000), so replacing the
-- signature outright breaks nothing.
--
-- 'restricted' requires at least one account id -- a restricted source no
-- account can read would be indistinguishable from deleted knowledge.
-- 'shared' accepts an empty or null array and writes no links: every account
-- reads it, which is what "shared" means now that absence of a link no
-- longer implies access.

DROP FUNCTION IF EXISTS public.create_ai_knowledge_source(text, text, text, uuid[]);

CREATE OR REPLACE FUNCTION public.create_ai_knowledge_source(
  p_source_type text,
  p_file_name text,
  p_file_path text,
  p_social_account_ids uuid[],
  p_visibility text DEFAULT 'shared'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_source_id uuid;
  v_owned integer;
  v_account_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_visibility IS DISTINCT FROM 'shared' AND p_visibility IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'visibility must be ''shared'' or ''restricted''';
  END IF;

  -- Distinct on both sides of the comparison, exactly as
  -- set_ai_knowledge_source_visibility collapses duplicates: [A, A] for an
  -- account the caller genuinely owns is a legal input, not an ownership
  -- failure, and re-inserting it would hit the link table's primary key.
  SELECT count(DISTINCT account_id) INTO v_account_count
  FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id;
  IF p_visibility = 'restricted' AND v_account_count = 0 THEN
    RAISE EXCEPTION 'A restricted knowledge source must be assigned to at least one account';
  END IF;

  IF v_account_count > 0 THEN
    SELECT count(DISTINCT id) INTO v_owned
    FROM public.social_accounts
    WHERE id = ANY(p_social_account_ids) AND user_id = v_user_id;

    IF v_owned <> v_account_count THEN
      RAISE EXCEPTION 'One or more accounts do not belong to the caller';
    END IF;
  END IF;

  INSERT INTO public.ai_knowledge_sources (user_id, source_type, file_name, file_path, status, visibility)
  VALUES (v_user_id, p_source_type, p_file_name, p_file_path, 'pending', p_visibility)
  RETURNING id INTO v_source_id;

  IF v_account_count > 0 THEN
    INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
    SELECT v_source_id, account_id, v_user_id
    FROM (SELECT DISTINCT account_id FROM unnest(p_social_account_ids) AS account_id) AS ids;
  END IF;

  RETURN v_source_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_ai_knowledge_source(text, text, text, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_ai_knowledge_source(text, text, text, uuid[], text) TO authenticated;

-- ---------------------------------------------------------------------------
-- D. set_ai_knowledge_source_visibility: one transaction for visibility+links
-- ---------------------------------------------------------------------------
-- Called by the ai-knowledge-ingest Edge Function, which authenticates the
-- bearer itself and then runs under the service role -- the same contract as
-- prune_ai_knowledge_entities(p_user_id). The caller's identity therefore
-- arrives as a parameter and every write below is scoped to it; execution is
-- granted to service_role only, so a browser cannot invoke it directly with
-- someone else's user id.
--
-- 'shared' deletes every link: shared means shared, and stale links left
-- behind are exactly what would make a later flip back to 'restricted'
-- behave unexpectedly. 'restricted' REPLACES the link set with the supplied
-- ids -- an empty list is legal and means "no account can read this", the
-- monotonic behaviour the whole migration exists to establish. Visibility
-- and links change in one transaction so a failure can never leave them
-- disagreeing.

CREATE OR REPLACE FUNCTION public.set_ai_knowledge_source_visibility(
  p_user_id uuid,
  p_source_id uuid,
  p_visibility text,
  p_social_account_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_owned integer;
  v_requested integer;
BEGIN
  -- IS DISTINCT FROM, not <>: a NULL visibility must fail HERE with a named
  -- message rather than slipping through to the check constraint.
  IF p_visibility IS DISTINCT FROM 'shared' AND p_visibility IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'visibility must be ''shared'' or ''restricted''';
  END IF;

  -- Row lock first, so a concurrent visibility change serialises behind this
  -- one instead of interleaving with the link rewrite below. NOT FOUND (not
  -- a silent zero-row UPDATE) so a source the caller does not own is a loud
  -- refusal rather than a no-op that reports success.
  PERFORM 1
  FROM public.ai_knowledge_sources
  WHERE id = p_source_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Knowledge source not found for caller';
  END IF;

  -- Duplicate ids are collapsed rather than trusted: counting distinct rows
  -- against a duplicated array would misfire the ownership check, and the
  -- insert would hit the (source_id, social_account_id) primary key anyway.
  SELECT count(DISTINCT account_id) INTO v_requested
  FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id;
  IF v_requested > 0 THEN
    SELECT count(DISTINCT id) INTO v_owned
    FROM public.social_accounts
    WHERE id = ANY(p_social_account_ids) AND user_id = p_user_id;
    IF v_owned <> v_requested THEN
      RAISE EXCEPTION 'One or more accounts do not belong to the caller';
    END IF;
  END IF;

  UPDATE public.ai_knowledge_sources
  SET visibility = p_visibility
  WHERE id = p_source_id AND user_id = p_user_id;

  DELETE FROM public.ai_knowledge_source_accounts
  WHERE source_id = p_source_id;

  IF p_visibility = 'restricted' THEN
    INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
    SELECT p_source_id, account_id, p_user_id
    FROM (SELECT DISTINCT account_id FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id) AS ids;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_ai_knowledge_source_visibility(uuid, uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ai_knowledge_source_visibility(uuid, uuid, text, uuid[]) TO service_role;

COMMIT;
