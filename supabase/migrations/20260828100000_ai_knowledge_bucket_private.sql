-- Re-privatise the ai-knowledge bucket. Production drifted from
-- 20260712010000_ai_knowledge_bucket.sql (which creates the bucket private):
-- the blanket "Public can view ai-knowledge files" policy plus public = true
-- served every user's knowledge-graph export to unauthenticated readers,
-- making the per-owner policies decorative.
--
-- Graph exports are now served through short-TTL signed URLs minted by the
-- ai-knowledge-ingest resolve_export_urls action, so the public read path can
-- go. The per-owner policies from the 2026-07-12 migration are untouched.
--
-- APPLY ONLY AFTER the updated ai-knowledge-ingest edge function is deployed
-- and verified: flipping the bucket first would break the graph viewer for
-- every existing export row until the signed-URL code is live. This file is
-- NOT applied automatically by this branch.

UPDATE storage.buckets SET public = false WHERE id = 'ai-knowledge';

DROP POLICY IF EXISTS "Public can view ai-knowledge files" ON storage.objects;
