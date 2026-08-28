-- An account with no knowledge links reads the owner's whole corpus.
--
-- The expansion migration linked every existing source to every account that
-- existed at that moment, so scoping worked for accounts present at backfill and
-- for nobody after. An account connected later -- which on WhatsApp is every QR
-- reconnect, because relinking inserts a NEW social_accounts row -- started with
-- zero links, and the account-scoped retrieval RPCs read that as "this account
-- may see nothing". The agent answered with no knowledge at all and logged a
-- perfectly successful reply while doing it.
--
-- Absent links is not a scoping decision, it is the absence of one. Until the
-- UI can assign documents to channels, the honest default is the one the plan
-- specified: shared. Once a source is linked to this account, the links become
-- the whole truth for it and the fallback stops applying.

BEGIN;

CREATE OR REPLACE FUNCTION public.ai_knowledge_account_has_links(
  p_user_id uuid,
  p_social_account_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.ai_knowledge_source_accounts AS link
    JOIN public.social_accounts AS account
      ON account.id = link.social_account_id AND account.user_id = p_user_id
    WHERE link.social_account_id = p_social_account_id
  );
$function$;

COMMENT ON FUNCTION public.ai_knowledge_account_has_links(uuid, uuid) IS
  'True when the account has at least one explicitly linked knowledge source. '
  'False makes the account-scoped retrieval functions fall back to the owner''s '
  'whole corpus rather than to nothing.';

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
    AND (
      NOT public.ai_knowledge_account_has_links(p_user_id, p_social_account_id)
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
    AND (
      NOT public.ai_knowledge_account_has_links(p_user_id, p_social_account_id)
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

-- Graph expansion still filters by RELATION PROVENANCE, not by entity: entities
-- are deliberately shared across a user's sources, so filtering on the entity
-- would let a linked source's entity pull in relations extracted from an
-- unlinked one. The fallback widens which sources count as visible; it does not
-- change what "visible" means.
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
      AND (
        NOT public.ai_knowledge_account_has_links(p_user_id, p_social_account_id)
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

COMMIT;
