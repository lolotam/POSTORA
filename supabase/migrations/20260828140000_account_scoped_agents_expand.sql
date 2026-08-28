-- ============================================================================
-- Per-account agent tenancy and knowledge scoping -- EXPANSION half
-- ============================================================================
-- Type: additive. Nothing is dropped, no signature changes, no NOT NULL added.
-- Designed to run while the CURRENT edge functions are still live: the legacy
-- UNIQUE (user_id, platform) stays, and the three existing retrieval RPCs are
-- untouched. The contract half
-- (20260828150000_account_scoped_agents_contract.sql) runs only after the
-- account-aware functions are deployed and verified.
--
-- Why the split matters: deploying account-aware functions before this
-- migration makes ai-agent-reply query a column that does not exist and call
-- RPC signatures that do not exist. Missing config reads as `agent_not
-- configured` and a failed RAG lookup deliberately degrades to answering
-- without knowledge -- so agents would silently stop, or answer with no
-- knowledge base, with no loud error anywhere.
--
-- What this fixes (defect D4): ai_agent_configs is UNIQUE (user_id, platform),
-- so one login managing several brands gets ONE persona per platform. In
-- production one login owns 9 Instagram accounts, 6 Facebook pages and 6
-- Threads accounts for different client brands. Knowledge has the same problem
-- one step further out: retrieval filters on user_id alone, so a
-- `Business profile (facebook)` source is retrievable by the WhatsApp agent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- A. Composite keys, so "belongs to the same user" can be enforced structurally
-- ---------------------------------------------------------------------------
-- A plain FK to social_accounts(id) would let a row reference an account owned
-- by someone else and rely on RLS to catch it. RLS is bypassed by the service
-- role, which is exactly the context ai-agent-reply runs in, so the integrity
-- has to live in the key rather than the policy.

ALTER TABLE public.social_accounts
  DROP CONSTRAINT IF EXISTS social_accounts_id_user_id_key;
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_id_user_id_key UNIQUE (id, user_id);

ALTER TABLE public.ai_knowledge_sources
  DROP CONSTRAINT IF EXISTS ai_knowledge_sources_id_user_id_key;
ALTER TABLE public.ai_knowledge_sources
  ADD CONSTRAINT ai_knowledge_sources_id_user_id_key UNIQUE (id, user_id);

-- ---------------------------------------------------------------------------
-- B. ai_agent_configs gains its account
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_agent_configs
  ADD COLUMN IF NOT EXISTS social_account_id uuid;

ALTER TABLE public.ai_agent_configs
  DROP CONSTRAINT IF EXISTS ai_agent_configs_account_same_owner;
ALTER TABLE public.ai_agent_configs
  ADD CONSTRAINT ai_agent_configs_account_same_owner
  FOREIGN KEY (social_account_id, user_id)
  REFERENCES public.social_accounts (id, user_id)
  ON DELETE CASCADE;

-- Postgres treats NULLs as distinct in a unique index, so this enforces one
-- config per account while still permitting the not-yet-assigned rows the
-- backfill below cannot resolve. A full (not partial) index is deliberate:
-- upserts use ON CONFLICT (social_account_id), which cannot target a partial
-- index without repeating its predicate.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_configs_social_account_id_key
  ON public.ai_agent_configs (social_account_id);

-- Backfill only where the answer is unambiguous: exactly one active account of
-- that platform. A config is a brand voice, and an automated public-reply
-- system attaching the wrong brand's voice to an account is worse than that
-- account reading "configuration required".
UPDATE public.ai_agent_configs AS config
SET social_account_id = account.id
FROM public.social_accounts AS account
WHERE account.user_id = config.user_id
  AND account.platform = config.platform
  AND account.is_active
  AND config.social_account_id IS NULL
  AND (
    SELECT count(*) FROM public.social_accounts AS candidate
    WHERE candidate.user_id = config.user_id
      AND candidate.platform = config.platform
      AND candidate.is_active
  ) = 1;

-- ---------------------------------------------------------------------------
-- C. Knowledge sources reach accounts through a join table
-- ---------------------------------------------------------------------------
-- Asymmetric with configs on purpose. One business operating three platform
-- accounts has one knowledge base; hard per-account scoping would force three
-- uploads and three times the embedding cost. Chunks are not denormalised --
-- they already carry source_id, and authorization joins through the source.

CREATE TABLE IF NOT EXISTS public.ai_knowledge_source_accounts (
  source_id uuid NOT NULL,
  social_account_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, social_account_id),
  FOREIGN KEY (source_id, user_id)
    REFERENCES public.ai_knowledge_sources (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id) ON DELETE CASCADE
);

-- The primary key serves lookups by source; retrieval walks the other way.
CREATE INDEX IF NOT EXISTS ai_knowledge_source_accounts_account_idx
  ON public.ai_knowledge_source_accounts (social_account_id, source_id);

ALTER TABLE public.ai_knowledge_source_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own knowledge source links"
  ON public.ai_knowledge_source_accounts;
CREATE POLICY "Users manage their own knowledge source links"
  ON public.ai_knowledge_source_accounts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Backfill every existing source to all of that user's active agent-capable
-- accounts. This reproduces today's retrieval behaviour exactly -- every source
-- is currently reachable from every one of the user's agents -- so the
-- expansion window carries zero regression. New uploads require an explicit
-- account selection.
INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
SELECT source.id, account.id, source.user_id
FROM public.ai_knowledge_sources AS source
JOIN public.social_accounts AS account
  ON account.user_id = source.user_id
 AND account.is_active
 AND account.platform IN ('whatsapp', 'facebook', 'instagram', 'threads')
ON CONFLICT (source_id, social_account_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- D. Account-scoped retrieval
-- ---------------------------------------------------------------------------
-- New names rather than overloads of the existing three. An overload whose
-- extra parameter has a DEFAULT makes a three-argument PostgREST call match
-- both candidates ("could not choose best candidate"), which would break the
-- live callers during exactly the window this expansion exists to protect. The
-- legacy functions stay untouched and are dropped in a later cleanup.
--
-- A source linked to zero accounts is excluded: the EXISTS predicate is simply
-- false. That is the intended fail-closed behaviour -- an unlinked source
-- answers nothing rather than answering everything.

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
      FROM public.ai_knowledge_source_accounts AS link
      JOIN public.social_accounts AS account
        ON account.id = link.social_account_id AND account.user_id = p_user_id
      WHERE link.source_id = c.source_id
        AND link.social_account_id = p_social_account_id
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
      FROM public.ai_knowledge_source_accounts AS link
      JOIN public.social_accounts AS account
        ON account.id = link.social_account_id AND account.user_id = p_user_id
      WHERE link.source_id = c.source_id
        AND link.social_account_id = p_social_account_id
    )
  ORDER BY c.embedding_bge_m3 <=> query_embedding
  LIMIT match_count;
$function$;

-- Graph expansion filters by RELATION PROVENANCE, not by entity. Entities are
-- deliberately shared across a user's sources, so filtering on the entity would
-- let a linked source's entity pull in relations extracted from an unlinked
-- one -- the leak this whole migration is closing, arriving through the back
-- door. Both the seed set and the returned relations are therefore restricted
-- to relations whose originating chunk belongs to a linked source.
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
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = chunk.source_id
          AND link.social_account_id = p_social_account_id
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

-- ---------------------------------------------------------------------------
-- E. Creating a source and its links must be one transaction
-- ---------------------------------------------------------------------------
-- Inserting the source from the browser and the links separately leaves a
-- window where a source exists with no links. Retrieval fails closed on such a
-- row, so the user sees an uploaded file in the list that silently answers
-- nothing. The caller is derived from auth.uid(); supplied account ids are
-- verified to belong to that caller rather than trusted.

CREATE OR REPLACE FUNCTION public.create_ai_knowledge_source(
  p_source_type text,
  p_file_name text,
  p_file_path text,
  p_social_account_ids uuid[]
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
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_social_account_ids IS NULL OR array_length(p_social_account_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'A knowledge source must be assigned to at least one account';
  END IF;

  SELECT count(*) INTO v_owned
  FROM public.social_accounts
  WHERE id = ANY(p_social_account_ids) AND user_id = v_user_id;

  IF v_owned <> array_length(p_social_account_ids, 1) THEN
    RAISE EXCEPTION 'One or more accounts do not belong to the caller';
  END IF;

  INSERT INTO public.ai_knowledge_sources (user_id, source_type, file_name, file_path, status)
  VALUES (v_user_id, p_source_type, p_file_name, p_file_path, 'pending')
  RETURNING id INTO v_source_id;

  INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
  SELECT v_source_id, account_id, v_user_id
  FROM unnest(p_social_account_ids) AS account_id;

  RETURN v_source_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_ai_knowledge_source(text, text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_ai_knowledge_source(text, text, text, uuid[]) TO authenticated;

COMMIT;
