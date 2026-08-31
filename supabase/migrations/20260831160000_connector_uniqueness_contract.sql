-- Migration B: the per-account connector contract (forward-only).
--
-- WHY
-- ai_agent_tools shipped with UNIQUE (user_id, name). That constraint
-- prevented two accounts owned by the same login from each having a
-- connector named `woocommerce_store`. Spec §4.2 moves uniqueness to
-- UNIQUE (user_id, social_account_id, name) NULLS NOT DISTINCT (Migration A,
-- 20260831130000) so each account has its own namespace. This migration
-- CONTRACTS the old key away. It is the second half of an expand/contract:
--
--   * Migration A added the new index and kept the old one.
--   * PR-4's deployed code (messaging-api) stopped using
--     `ON CONFLICT (user_id, name)` and switched to a read-then-
--     update-or-insert shape. That deploy is live.
--
-- Dropping the constraint is safe ONLY NOW, because no deployed writer
-- still names it as an ON CONFLICT target. Dropping it before that deploy
-- breaks every connector save in the same way `SET NOT NULL` broke
-- first-time agent saves for 52 accounts on 2026-08-28. Saying so here
-- so a future reader does not reorder the two steps.
--
-- FORWARD-ONLY
-- Once two accounts of the same user hold the same name (the very thing
-- this feature enables), UNIQUE (user_id, name) can never be restored:
-- the duplicate rows would violate it. Re-adding it would require renaming
-- or deleting connectors, which is a product decision, not a migration.
-- This statement is the contract: after this migration, the old uniqueness
-- is not reclaimable without data loss, and the runbook must say so.
--
-- WHAT HAPPENS TO `secret`
-- The plaintext `secret` column backs `X-Webhook-Secret` in
-- executeCustomTool (supabase/functions/ai-agent-reply/tools.ts ~408).
-- No deployed reader looks in Vault for it. If the column is emptied
-- before such a reader exists, the header silently stops being sent:
-- no exception, no log line, just every n8n webhook rejecting requests.
--
-- So this migration COPIES any remaining secret into Vault (one JSON blob
-- per connector, keyed as `{"secret": "<value>"}` merged into the
-- existing blob if one already exists) and KEEPS the column populated.
-- A later migration may clear the column ONLY AFTER a Vault-reading
-- path is deployed and verified. Leaving the column in place is the
-- blocker this repo paid for; clearing it now is a defect, not cleanup.
--
-- HOW THE COPY WORKS
-- It reuses public.upsert_connector_credential_secret(uuid, jsonb) from
-- 20260831140000 rather than touching vault.* directly. The wrapper does
-- the decrypt-merge-encrypt inside the database so plaintext never enters
-- the Edge Function, and it derives configured_secret_fields from the
-- merged blob's keys on every write so the cache cannot drift.
--
-- Vault writes are vault-first, row-second in that wrapper, so a failure
-- between the two leaves an orphan secret rather than a dangling row.
-- Orphan is tolerable and swept later; dangling is not.
--
-- TWO RULES THIS REPO PAID FOR
-- (a) LANGUAGE sql bodies are validated at CREATE time. A LANGUAGE sql
--     function referencing vault.* fails on the CI harness whose baseline
--     has no supabase_vault extension. Any function written here that
--     touches vault must be LANGUAGE plpgsql. The DO block below touches
--     vault only through the plpgsql wrapper, so it is safe; if you add
--     a helper, make it plpgsql.
-- (b) REVOKE ALL ... FROM PUBLIC does not revoke from anon and
--     authenticated. This stack carries ALTER DEFAULT PRIVILEGES IN SCHEMA
--     public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, so both
--     hold EXECUTE explicitly from CREATE time. A REVOKE that omits them
--     ships callable with the anon key — that happened in production and
--     returned decrypted vendor credentials over HTTP 200. Any new function
--     here must REVOKE FROM PUBLIC, anon, authenticated in one statement.
--
-- APPLY AS supabase_admin, NOT postgres. Verified by rehearsal: as postgres
-- this fails with "ERROR: must be owner of function
-- upsert_connector_credential_secret" and the whole migration aborts. postgres
-- is not a superuser on this stack and supabase_admin owns the wrapper. Same
-- role rule as 20260831150100.
--
-- Rehearsed against production with ROLLBACK:
--   ALTER TABLE
--   NOTICE: plaintext_secret_rows=1 of_those_vaulted=1 old_constraint_left=0
--   NOTICE: PASS every secret copied AND column still populated
--   ROLLBACK
--
-- APPLIED BY HAND BY THE OWNER. Rehearse statement by statement with
-- ROLLBACK against production, not a scratch database: Postora migrations
-- self-commit, so an outer BEGIN does not protect anything, and a virgin
-- database hides the replay defects that bit on 2026-08-28.
-- A useful rehearsal for the merge semantics (mirrors the comment in
-- 20260831140000):
--   SELECT * FROM public.ai_agent_tools
--    WHERE secret IS NOT NULL AND secret <> '' LIMIT 1;
--   -- note the row id, its secret, and its credentials_secret_id, then:
--   -- run this migration inside BEGIN; ROLLBACK;
--   -- verify that credentials_secret_id is now set and
--   -- configured_secret_fields contains 'secret', while secret is unchanged.

BEGIN;

-- ============================================================================
-- A. Drop the legacy uniqueness contract
-- ============================================================================
-- Safe only after PR-4's code is live (see header). IF EXISTS so a replay
-- after the constraint is already gone does not error, but the header
-- remains the source of truth for ordering.
ALTER TABLE public.ai_agent_tools
  DROP CONSTRAINT IF EXISTS ai_agent_tools_user_id_name_key;

-- ============================================================================
-- B. Migrate any remaining plaintext `secret` into Vault
-- ============================================================================
-- Copy into Vault, leave the column populated (see header). No deployed
-- reader looks in Vault for this field yet; emptying the column would
-- silently stop sending X-Webhook-Secret.
DO $migrate_secret$
DECLARE
  r RECORD;
  v_secret_id uuid;
  v_fields text[];
BEGIN
  FOR r IN
    SELECT id, secret, credentials_secret_id
      FROM public.ai_agent_tools
     WHERE secret IS NOT NULL AND secret <> ''
  LOOP
    -- The wrapper merges with the existing blob when an id is supplied
    -- (jsonb || keeps unsubmitted keys), and derives configured_fields
    -- from the merged blob so the cache never drifts.
    SELECT secret_id, configured_fields
      INTO v_secret_id, v_fields
      FROM public.upsert_connector_credential_secret(
        r.credentials_secret_id,
        jsonb_build_object('secret', r.secret)
      );

    UPDATE public.ai_agent_tools
       SET credentials_secret_id = v_secret_id,
           configured_secret_fields = v_fields
     WHERE id = r.id;
  END LOOP;
END
$migrate_secret$ LANGUAGE plpgsql;

-- The `secret` column is deliberately NOT dropped and NOT nulled here.
-- A later migration may clear it only after a Vault-reading path for
-- X-Webhook-Secret is deployed and verified.

COMMIT;
