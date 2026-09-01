-- Partner API v1, Phase 4: media ownership and storage (deliverables 4.1/4.2).
--
-- Everything here is one of the three rows the D10 control matrix found the
-- existing pipeline could not answer. See
-- docs/decisions/2026-09-01-d10-media-control-matrix.md.
--
-- Additive only: two nullable columns, one bucket, no data change.

-- ---------------------------------------------------------------------------
-- 1. Media is WORKSPACE-owned (D10 R3), and media_files only knew about users.
-- ---------------------------------------------------------------------------
--
-- D10(R3) is explicit that media is workspace-owned with the creating key
-- recorded for audit, and gives the reason: key-owned media would be orphaned
-- by rotation, which D12 makes routine. A partner who rotates a credential
-- must still be able to reach what they uploaded.
--
-- NO BACKFILL, and that is the security property, not an omission. Every
-- partner read filters `workspace_id = <the presented key's workspace>`, and
-- SQL NULL matches nothing -- so every one of the media_files rows that exists
-- today is invisible to every partner key, permanently, without a single
-- policy having to say so. Backfilling would have meant guessing which
-- workspace a user's media belonged to, and a wrong guess is a cross-tenant
-- read that nothing downstream could detect.
ALTER TABLE public.media_files
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES public.workspaces(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_by_key_id UUID;

-- Composite FK, the same shape D4 uses on partner_api_key_accounts and for the
-- same reason: two independent single-column FKs would each be satisfied while
-- the PAIR is nonsense -- workspace A's media attributed to workspace B's key.
-- Referencing (id, workspace_id) together makes that unrepresentable.
--
-- MATCH SIMPLE (the default) is load-bearing: a row with created_by_key_id
-- NULL skips the check entirely, which is what lets every existing
-- app-uploaded row keep satisfying the constraint.
--
-- ON DELETE SET NULL names its column explicitly (PG15+). Without the column
-- list, deleting a key would null workspace_id too and orphan the media out of
-- its own workspace -- turning credential rotation into data loss. Audit
-- attribution is what may be lost when a key is deleted; ownership is not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_files_created_by_key_in_workspace'
  ) THEN
    ALTER TABLE public.media_files
      ADD CONSTRAINT media_files_created_by_key_in_workspace
      FOREIGN KEY (created_by_key_id, workspace_id)
      REFERENCES public.partner_api_keys (id, workspace_id)
      ON DELETE SET NULL (created_by_key_id);
  END IF;
END $$;

-- Partner reads are always workspace-scoped and ordered newest-first.
CREATE INDEX IF NOT EXISTS media_files_workspace_created_idx
  ON public.media_files (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A private bucket for partner uploads.
-- ---------------------------------------------------------------------------
--
-- NEW, rather than the app's `media` bucket, and the reason is drift rather
-- than tidiness. The migration that creates `media`
-- (20260101204652) sets `public = true` and adds
--
--     CREATE POLICY "Public can view media" ON storage.objects
--       FOR SELECT USING (bucket_id = 'media');
--
-- which grants every authenticated caller read of every object in it.
-- Production today has public = false and no such policy: somebody tightened
-- it out of band and the repository never recorded the change. A migration
-- replay would restore the public bucket.
--
-- Partner media must not inherit a privacy property that exists only as an
-- undocumented production state. This bucket is private in committed SQL, so
-- D10's "tenant ownership" and "time-bounded URL" rows are true by
-- construction. (The `media` bucket's own drift is real, pre-existing, and
-- deserves its own change rather than a drive-by here.)
--
-- No storage policies are created, and that is deliberate: with RLS enabled
-- and no policy, every role is denied and only the service role -- which
-- bypasses RLS -- can read or write. The partner path is server-side only, so
-- the fail-closed default IS the contract. A policy would only widen it.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('partner-media', 'partner-media', false, 26214400)
ON CONFLICT (id) DO NOTHING;
