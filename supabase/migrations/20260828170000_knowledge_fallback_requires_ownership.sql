-- The shared-knowledge fallback must require the account to be the caller's own.
--
-- 20260828160000 made "this account has no links" mean "read the whole corpus",
-- but it asked that question through a join on social_accounts.user_id -- so an
-- account belonging to somebody else also has no links *for this caller*, and
-- the fallback fired. The rows returned are still only the caller's own chunks,
-- so no other user's knowledge was reachable; what broke is the scoping itself.
-- Naming an account that is not yours silently turned account scoping off.
--
-- ai-agent-reply resolves the account by (id, owner) before it ever calls these,
-- so nothing in the product could reach that path. A retrieval function that
-- guards ownership only because its callers already did is one refactor away
-- from being wrong, so it guards ownership itself.

BEGIN;

CREATE OR REPLACE FUNCTION public.ai_knowledge_account_reads_whole_corpus(
  p_user_id uuid,
  p_social_account_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$
  SELECT EXISTS (
      SELECT 1
      FROM public.social_accounts AS account
      WHERE account.id = p_social_account_id
        AND account.user_id = p_user_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.ai_knowledge_source_accounts AS link
      WHERE link.social_account_id = p_social_account_id
    );
$function$;

COMMENT ON FUNCTION public.ai_knowledge_account_reads_whole_corpus(uuid, uuid) IS
  'True only for an account the caller owns that has no linked knowledge sources '
  'yet -- the state every newly connected account starts in. An account that is '
  'not the caller''s is never granted the fallback.';

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
      EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
      OR public.ai_knowledge_account_reads_whole_corpus(p_user_id, p_social_account_id)
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
      EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
      OR public.ai_knowledge_account_reads_whole_corpus(p_user_id, p_social_account_id)
    )
  ORDER BY c.embedding_bge_m3 <=> query_embedding
  LIMIT match_count;
$function$;

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
        EXISTS (
          SELECT 1
          FROM public.ai_knowledge_source_accounts AS link
          JOIN public.social_accounts AS account
            ON account.id = link.social_account_id AND account.user_id = p_user_id
          WHERE link.source_id = chunk.source_id
            AND link.social_account_id = p_social_account_id
        )
        OR public.ai_knowledge_account_reads_whole_corpus(p_user_id, p_social_account_id)
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

DROP FUNCTION IF EXISTS public.ai_knowledge_account_has_links(uuid, uuid);

COMMIT;
