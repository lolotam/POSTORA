# Social Audience Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every Facebook, Instagram and Threads commenter into a per-user `social_contacts` table at ingest time, and ship an "Audience & Contacts" page under Automation that lists, searches, tags, edits and exports them.

**Architecture:** One migration adds the table with tenant-preserving composite FKs, a `touch_social_contact` writer that derives the owner from the social account (service-role only, `SECURITY INVOKER`), two `SECURITY INVOKER` read RPCs (stats, search) and the feature flag. One `_shared` module calls the writer from the two existing comment ingest paths inside `runInBackground`. The frontend gets `src/features/audience/{domain,infrastructure,ui/hooks}` (the `src/features/connectors/` shape); pages and components consume hooks only.

**Tech Stack:** Postgres 17.6 + RLS, Deno edge functions, React 18 + TanStack Query + shadcn/ui, vitest, Deno test, `scripts/db-harness.sh` SQL suites.

**Spec:** `docs/superpowers/specs/2026-09-04-social-audience-hub.md`

**Feature branch:** `feat/social-audience-hub` (create with `git worktree add ../Postora-audience -b feat/social-audience-hub` — another CLI drives this checkout's HEAD; never stash here).

## Global Constraints

- Read `ARCHITECTURE.md` before editing `src/**` or `supabase/functions/**`. Delegation briefs must name it, plus §3 (hooks are **ui**), §4 (dependency direction), §12–13 (edge function shape), §23 (tables), §24 (service role).
- Tenancy key is `user_id` (`= auth.uid()` in RLS); `workspace_id` is nullable and copied from the account by the writer RPC. Callers never pass a user id.
- Every new SQL function: `REVOKE ALL ... FROM PUBLIC, anon, authenticated` first, then grant only what it needs (baseline default privileges grant functions to `anon` and `authenticated`).
- Ingest never blocks a webhook response and never logs comment text.
- `platform` CHECK is `('facebook','instagram','threads','youtube')`; ingest only sends the first three.
- No new table joins `supabase_realtime`. No client-built PostgREST `or=` filters; search is an RPC.
- Flag key `feature_audience_hub`; hook property `audienceHub`; nav label "Audience & Contacts"; route `/automation/audience`.
- Migrations go to the OpenCode Muse Spark lane; code slices to Codex gpt-5.6-sol medium. The orchestrator reviews every diff, runs `clean-code-guard` / `test-guard`, and commits scoped files.
- Migrations run on the Contabo box as `supabase_admin`, never `postgres`.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/`, `deno check` on every new `_shared` module, `bash scripts/db-harness.sh`. Run Deno first, then `bun install` (the Deno node-modules dir breaks vitest).

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/migrations/20260904120000_social_contacts.sql` | table, composite FKs, indexes, trigger, RLS, `touch_social_contact`, `get_social_contacts_stats`, `search_social_contacts`, privilege revokes, flag seed, inbox-history seed |
| `supabase/tests/social_contacts.sql` | harness suite |
| `supabase/functions/_shared/socialContactIngest.ts` (+ `.test.ts`) | `touchSocialContact` |
| `supabase/functions/facebook-instagram-webhook/index.ts` | Meta call site |
| `supabase/functions/_shared/threadsCommentIngest.ts` (+ `.test.ts`) | Threads call site |
| `src/hooks/useFeatureFlags.tsx` | `audienceHub` flag |
| `src/features/audience/domain/socialContact.ts` (+ `.test.ts`) | row/filter types, `contactLabel`, CSV builders (no Supabase import) |
| `src/features/audience/infrastructure/socialContactsRepository.ts` (+ `.test.ts`) | every Supabase call |
| `src/features/audience/infrastructure/downloadBlob.ts` | copy of `src/features/whatsapp-inbox/infrastructure/downloadBlob.ts` |
| `src/features/audience/ui/hooks/useSocialContacts.ts` (+ `.test.tsx`) | TanStack hooks over the repository |
| `src/features/audience/index.ts` | public exports |
| `src/pages/automation/AudiencePage.tsx` (+ `__tests__/AudiencePage.test.tsx`) | page |
| `src/components/audience/ContactFilters.tsx`, `ContactsTable.tsx`, `ContactDetailsDrawer.tsx`, `ExportMenu.tsx` (+ tests) | UI pieces |
| `src/components/layout/DashboardLayout.tsx`, `src/components/AnimatedRoutes.tsx` | nav + route |
| `src/integrations/supabase/types.ts` | regenerated |

---

## Slice 1 — Database (Muse Spark lane)

### Task 1: Migration, harness suite, types

**Files:**
- Create: `supabase/migrations/20260904120000_social_contacts.sql`
- Create: `supabase/tests/social_contacts.sql`
- Modify: `scripts/db-harness.sh:101` (`SUITES=(` — add `social_contacts.sql`)
- Modify: `src/integrations/supabase/types.ts` (regenerated)

**Interfaces:**
- Produces:
  - table `public.social_contacts` (spec §3.2)
  - `public.touch_social_contact(p_social_account_id uuid, p_platform text, p_author_id text, p_author_name text, p_author_username text, p_comment_text text, p_post_id text) RETURNS uuid` — `service_role` only
  - `public.get_social_contacts_stats() RETURNS TABLE(total bigint, workflow_leads bigint, enriched bigint, top_platform text)` — `authenticated`
  - `public.search_social_contacts(p_query text, p_platform text, p_source text, p_tags text[], p_limit int, p_offset int) RETURNS TABLE(row_count bigint, contact public.social_contacts)` — `authenticated`
  - `app_settings` row `feature_audience_hub`

- [ ] **Step 1: Write the harness suite first**

```sql
-- ============================================================================
-- social_contacts.sql — Audience hub contact table, writer and read RPCs
--
-- Run only as a superuser against the disposable database created by
-- scripts/db-harness.sh. The suite commits its assertions and cleans its rows.
-- ============================================================================
\set ON_ERROR_STOP on
\echo '=== social_contacts: start ==='

CREATE TEMP TABLE sc_ids (k TEXT PRIMARY KEY, id UUID NOT NULL);
INSERT INTO sc_ids VALUES
  ('owner_a', '88888888-8888-4888-8888-888888888801'),
  ('owner_b', '88888888-8888-4888-8888-888888888802'),
  ('acct_a',  '88888888-8888-4888-8888-888888888811'),
  ('acct_b',  '88888888-8888-4888-8888-888888888812'),
  ('acct_t',  '88888888-8888-4888-8888-888888888813');
GRANT SELECT ON sc_ids TO authenticated, service_role, anon;

CREATE OR REPLACE FUNCTION pg_temp.sc_cleanup() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_users UUID[] := ARRAY(SELECT id FROM sc_ids WHERE k IN ('owner_a','owner_b'));
BEGIN
  DELETE FROM public.social_contacts WHERE user_id = ANY(v_users);
  DELETE FROM public.social_accounts WHERE user_id = ANY(v_users);
  DELETE FROM auth.users WHERE id = ANY(v_users);
END $$;
CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', p_user::text, false)::void;
$$;
CREATE OR REPLACE FUNCTION pg_temp.must(p BOOLEAN, label TEXT) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %', label; END IF; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refused(p_sql TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN false; EXCEPTION WHEN insufficient_privilege THEN RETURN true; END $$;

SELECT pg_temp.sc_cleanup();

DO $seed$
DECLARE
  v_a UUID := (SELECT id FROM sc_ids WHERE k='owner_a');
  v_b UUID := (SELECT id FROM sc_ids WHERE k='owner_b');
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_a, 'sc-owner-a@example.invalid'), (v_b, 'sc-owner-b@example.invalid')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.social_accounts (id, user_id, platform, platform_user_id, platform_username, access_token, is_active) VALUES
    ((SELECT id FROM sc_ids WHERE k='acct_a'), v_a, 'instagram', 'sc-ig-a', 'sc-a', 'seed', true),
    ((SELECT id FROM sc_ids WHERE k='acct_b'), v_b, 'instagram', 'sc-ig-b', 'sc-b', 'seed', true),
    ((SELECT id FROM sc_ids WHERE k='acct_t'), v_a, 'threads',   'sc-th-a', 'sc-th', 'seed', true)
  ON CONFLICT (id) DO NOTHING;
END $seed$;

-- (1) writer: insert, then increment; owner derived from the account
SET ROLE service_role;
DO $t$
DECLARE v_id1 UUID; v_id2 UUID; v_count INT; v_name TEXT; v_owner UUID;
BEGIN
  v_id1 := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', '17841400000001', NULL, 'dana.kw', 'price?', 'post-1');
  v_id2 := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', '17841400000001', '', NULL, 'still waiting', 'post-2');
  PERFORM pg_temp.must(v_id1 = v_id2, 'second touch returns the same row');
  SELECT total_comments_count, display_name, user_id INTO v_count, v_name, v_owner FROM public.social_contacts WHERE id = v_id1;
  PERFORM pg_temp.must(v_count = 2, 'count incremented to 2');
  PERFORM pg_temp.must(v_name = 'dana.kw', 'display_name fell back to username and an empty name did not erase it');
  PERFORM pg_temp.must(v_owner = (SELECT id FROM sc_ids WHERE k='owner_a'), 'owner derived from social_accounts');
END $t$;

-- (2) writer: no identity writes nothing; unknown account raises
DO $t$
BEGIN
  PERFORM pg_temp.must(public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'facebook', NULL, 'Someone', NULL, 'x', 'p') IS NULL, 'no identity returns null');
  PERFORM pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform='facebook') = 0, 'no identity wrote nothing');
  BEGIN
    PERFORM public.touch_social_contact('00000000-0000-4000-8000-000000000000', 'facebook', '1', 'A', NULL, 'x', 'p');
    RAISE EXCEPTION 'ASSERTION FAILED: unknown account accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%social_account_not_found%' THEN RAISE; END IF;
  END;
END $t$;

-- (3) Threads promotion: username row is re-keyed when an id arrives
DO $t$
DECLARE v_u UUID; v_i UUID; v_kind TEXT; v_count INT;
BEGIN
  v_u := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', NULL, NULL, 'vigrox.kw', 'hi', 'th-1');
  v_i := public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', '28097456199906', NULL, 'vigrox.kw', 'again', 'th-2');
  PERFORM pg_temp.must(v_u = v_i, 'username row promoted to id row');
  SELECT identity_kind, total_comments_count INTO v_kind, v_count FROM public.social_contacts WHERE id = v_i;
  PERFORM pg_temp.must(v_kind = 'id' AND v_count = 2, 'promoted row keeps the count');
  -- collision: a fresh username row next to an existing id row is left alone
  PERFORM public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', NULL, NULL, 'vigrox.kw', 'x', 'th-3');
  PERFORM public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_t'), 'threads', '28097456199906', NULL, 'vigrox.kw', 'y', 'th-4');
  PERFORM pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform='threads' AND username='vigrox.kw') = 2, 'collision leaves two rows without error');
END $t$;
RESET ROLE;

-- (4) privileges: authenticated and anon cannot execute the writer; anon cannot read
SET ROLE authenticated;
SELECT pg_temp.must(pg_temp.refused($$SELECT public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', 'z', NULL, NULL, NULL, NULL)$$), 'authenticated cannot call the writer');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.must(pg_temp.refused($$SELECT public.touch_social_contact((SELECT id FROM sc_ids WHERE k='acct_a'), 'instagram', 'z', NULL, NULL, NULL, NULL)$$), 'anon cannot call the writer');
SELECT pg_temp.must(pg_temp.refused($$SELECT * FROM public.get_social_contacts_stats()$$), 'anon cannot call stats');
SELECT pg_temp.must(pg_temp.refused($$SELECT * FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 10, 0)$$), 'anon cannot call search');
RESET ROLE;

-- (5) RLS: owner reads/updates own row; other user sees nothing and cannot update or delete
SET ROLE authenticated;
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_a'));
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 1, 'owner reads own contact');
UPDATE public.social_contacts SET tags = ARRAY['lead'] WHERE platform_user_id='17841400000001';
SELECT pg_temp.must((SELECT tags FROM public.social_contacts WHERE platform_user_id='17841400000001') = ARRAY['lead'], 'owner updates own contact');
-- composite FK: owner cannot attach another user's account
DO $t$
BEGIN
  UPDATE public.social_contacts SET social_account_id = (SELECT id FROM sc_ids WHERE k='acct_b') WHERE platform_user_id='17841400000001';
  RAISE EXCEPTION 'ASSERTION FAILED: foreign account attached';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END $t$;

SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_b'));
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 0, 'other user cannot read');
UPDATE public.social_contacts SET notes = 'stolen' WHERE platform_user_id='17841400000001';
DELETE FROM public.social_contacts WHERE platform_user_id='17841400000001';
RESET ROLE;
SELECT pg_temp.must((SELECT notes IS NULL FROM public.social_contacts WHERE platform_user_id='17841400000001'), 'other user update was a no-op');
SELECT pg_temp.must((SELECT count(*) FROM public.social_contacts WHERE platform_user_id='17841400000001') = 1, 'other user delete was a no-op');

-- (6) read RPCs under RLS
SET ROLE authenticated;
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_a'));
SELECT pg_temp.must((SELECT total FROM public.get_social_contacts_stats()) = 3, 'stats total counts owner rows only');
SELECT pg_temp.must((SELECT top_platform FROM public.get_social_contacts_stats()) = 'threads', 'top platform');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts('dana', NULL, NULL, NULL, 50, 0)) = 1, 'search by username');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts('%', NULL, NULL, NULL, 50, 0)) = 0, 'a literal % is escaped, not a wildcard');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, 'threads', NULL, NULL, 50, 0)) = 2, 'platform filter');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, NULL, ARRAY['lead'], 50, 0)) = 1, 'tag filter');
SELECT pg_temp.must((SELECT row_count FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 1, 0)) = 3, 'row_count reports the unpaged total');
SELECT pg_temp.act_as((SELECT id FROM sc_ids WHERE k='owner_b'));
SELECT pg_temp.must((SELECT total FROM public.get_social_contacts_stats()) = 0, 'stats total = 0 for other');
SELECT pg_temp.must((SELECT count(*) FROM public.search_social_contacts(NULL, NULL, NULL, NULL, 50, 0)) = 0, 'search returns nothing for other');
RESET ROLE;

-- (7) flag seeded
SELECT pg_temp.must((SELECT value = 'false'::jsonb FROM public.app_settings WHERE key='feature_audience_hub'), 'flag seeded false');

SELECT pg_temp.sc_cleanup();
\echo '=== social_contacts: PASS ==='
```

- [ ] **Step 2: Register the suite and run the harness to see it fail**

Add `social_contacts.sql` to `SUITES=(` in `scripts/db-harness.sh` (line 101). Run `bash scripts/db-harness.sh`.
Expected: FAIL at `social_contacts.sql` with `function public.touch_social_contact(...) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- Audience hub: one row per (owner, platform, commenter identity). Written by the service role
-- from the comment ingest paths through touch_social_contact; read and edited by the owner.

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
  -- The column-list SET NULL form (PG15+; this stack runs 17.6) nulls only the reference, never user_id.
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
CREATE INDEX social_contacts_threads_username_idx ON public.social_contacts (user_id, username) WHERE platform = 'threads' AND identity_kind = 'username';

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

  -- Threads replies arrive without an id; polled mentions carry one. Re-key the username row
  -- the first time an id shows up, unless an id row already exists (then both are left as-is).
  IF p_platform = 'threads' AND v_author_id IS NOT NULL AND v_username IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.social_contacts
                     WHERE user_id = v_user_id AND platform = 'threads' AND platform_user_id = v_author_id) THEN
    UPDATE public.social_contacts
       SET platform_user_id = v_author_id, identity_kind = 'id'
     WHERE user_id = v_user_id AND platform = 'threads' AND identity_kind = 'username'
       AND platform_user_id = v_username;
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
CREATE OR REPLACE FUNCTION public.search_social_contacts(
  p_query text, p_platform text, p_source text, p_tags text[], p_limit int, p_offset int
) RETURNS TABLE (row_count bigint, contact public.social_contacts)
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
  SELECT (SELECT count(*) FROM matched), m
  FROM matched m
  ORDER BY m.last_interacted_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 50), 200)) OFFSET greatest(0, coalesce(p_offset, 0));
$$;
REVOKE ALL ON FUNCTION public.search_social_contacts(text, text, text, text[], int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_social_contacts(text, text, text, text[], int, int) TO authenticated;

INSERT INTO public.app_settings (key, value, description)
VALUES ('feature_audience_hub', 'false'::jsonb, 'Show Audience & Contacts under Automation for non-admin users')
ON CONFLICT (key) DO NOTHING;

-- Seed from the comment history already on disk. Meta rows carry value.from; Threads rows carry
-- username and, for polled mentions, user.id. Idempotent: a rerun only re-counts.
INSERT INTO public.social_contacts
  (user_id, workspace_id, social_account_id, platform, platform_user_id, identity_kind,
   display_name, username, total_comments_count, first_interacted_at, last_interacted_at)
SELECT e.user_id, max(a.workspace_id), max(e.social_account_id), e.platform,
       coalesce(e.author_id, e.author_username),
       CASE WHEN e.author_id IS NULL THEN 'username' ELSE 'id' END,
       coalesce(max(e.author_name), max(e.author_username), ''),
       max(e.author_username),
       count(*), min(e.created_at), max(e.created_at)
FROM (
  SELECT s.user_id, s.social_account_id, s.platform, s.created_at,
         nullif(coalesce(s.payload->'value'->'from'->>'id', s.payload->'user'->>'id'), '')         AS author_id,
         nullif(coalesce(s.payload->'value'->'from'->>'username', s.payload->>'username'), '')  AS author_username,
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
GROUP BY e.user_id, e.platform, coalesce(e.author_id, e.author_username), (e.author_id IS NULL)
ON CONFLICT (user_id, platform, platform_user_id) DO NOTHING;
```

Before writing the seed, read the Threads raw payload shape stored by `threadsCommentIngest.ts` (`rawPayload`) with `SELECT payload FROM social_inbox_events WHERE platform='threads' LIMIT 3` on the throwaway DB and adjust the two Threads JSON paths if they differ. Table privileges need no explicit `GRANT`: migrations run as `supabase_admin`, whose default privileges already cover `authenticated` and `service_role` (`20260903120000_hybrid_connectors_tracking.sql` grants only function EXECUTE, never table rights).

- [ ] **Step 4: Run the harness to see it pass**

Run: `bash scripts/db-harness.sh`
Expected: `=== social_contacts: PASS ===`, every other suite unchanged. (Check `\d whatsapp_contacts` on the harness DB first so the new unique constraint name does not collide.)

- [ ] **Step 5: Regenerate TypeScript types**

Rehearse on a throwaway DB in the prod Postgres container (local `supabase start` is broken), then
`npx supabase gen types typescript --db-url "$THROWAWAY_URL" --schema public > src/integrations/supabase/types.ts`.
Confirm: `grep -n "social_contacts\|touch_social_contact\|get_social_contacts_stats\|search_social_contacts" src/integrations/supabase/types.ts | head`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260904120000_social_contacts.sql supabase/tests/social_contacts.sql scripts/db-harness.sh src/integrations/supabase/types.ts
git commit -m "feat(audience): social_contacts table, writer/search/stats RPCs and flag seed"
```

---

## Slice 2 — Ingest (Codex lane)

### Task 2: `touchSocialContact` shared module

**Files:**
- Create: `supabase/functions/_shared/socialContactIngest.ts`
- Create: `supabase/functions/_shared/socialContactIngest.test.ts`

**Interfaces:**
- Consumes: RPC `touch_social_contact` (Task 1).
- Produces:
  ```ts
  export interface SocialContactTouch {
    platform: "facebook" | "instagram" | "threads";
    author: { id: string | null; name: string | null; username: string | null };
    comment: { id: string; text: string };
    post: { id: string | null };
  }
  export type SocialContactTouchOutcome = "upserted" | "no_identity" | "failed";
  export async function touchSocialContact(admin: any, socialAccountId: string, touch: SocialContactTouch): Promise<SocialContactTouchOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { touchSocialContact } from "./socialContactIngest.ts";

function fakeAdmin(result: { data?: unknown; error?: { message: string } | null } = { data: "row-1", error: null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
  };
}

Deno.test("passes the account id and author fields through; never a user id", async () => {
  const admin = fakeAdmin();
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "instagram",
    author: { id: "1784140001", name: null, username: "dana.kw" },
    comment: { id: "c1", text: "price?" },
    post: { id: "p1" },
  });
  assertEquals(outcome, "upserted");
  assertEquals(admin.calls[0].fn, "touch_social_contact");
  assertEquals(admin.calls[0].args, {
    p_social_account_id: "acc-1", p_platform: "instagram", p_author_id: "1784140001", p_author_name: null,
    p_author_username: "dana.kw", p_comment_text: "price?", p_post_id: "p1",
  });
});

Deno.test("no id and no username short-circuits without an rpc call", async () => {
  const admin = fakeAdmin();
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "facebook",
    author: { id: null, name: "Someone", username: "  " },
    comment: { id: "c3", text: "x" },
    post: { id: "p3" },
  });
  assertEquals(outcome, "no_identity");
  assertEquals(admin.calls.length, 0);
});

Deno.test("a null rpc result (writer declined) is reported as no_identity", async () => {
  const admin = fakeAdmin({ data: null, error: null });
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "threads", author: { id: null, name: null, username: "v" }, comment: { id: "c", text: "t" }, post: { id: null },
  });
  assertEquals(outcome, "no_identity");
});

Deno.test("rpc error is reported as failed, never thrown", async () => {
  const admin = fakeAdmin({ error: { message: "boom" } });
  const outcome = await touchSocialContact(admin, "acc-1", {
    platform: "facebook", author: { id: "10", name: "A", username: null }, comment: { id: "c4", text: "x" }, post: { id: "p4" },
  });
  assertEquals(outcome, "failed");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test --allow-env --allow-read --no-check --node-modules-dir=auto supabase/functions/_shared/socialContactIngest.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */
// Turns one inbound public comment into a durable audience row. Called off the response path
// by every comment ingest after the own-comment check; a failure is logged and dropped because
// the comment itself is already recorded in social_inbox_events.

export interface SocialContactTouch {
  platform: "facebook" | "instagram" | "threads";
  author: { id: string | null; name: string | null; username: string | null };
  comment: { id: string; text: string };
  post: { id: string | null };
}

export type SocialContactTouchOutcome = "upserted" | "no_identity" | "failed";

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function touchSocialContact(
  admin: any,
  socialAccountId: string,
  touch: SocialContactTouch,
): Promise<SocialContactTouchOutcome> {
  const id = clean(touch.author.id);
  const username = clean(touch.author.username);
  if (!id && !username) return "no_identity";

  const { data, error } = await admin.rpc("touch_social_contact", {
    p_social_account_id: socialAccountId,
    p_platform: touch.platform,
    p_author_id: id,
    p_author_name: clean(touch.author.name),
    p_author_username: username,
    p_comment_text: touch.comment.text,
    p_post_id: touch.post.id,
  });
  if (error) {
    // Comment text is deliberately absent from this line.
    console.error(`[social-contacts] touch failed for ${touch.platform} comment ${touch.comment.id} on account ${socialAccountId}: ${error.message}`);
    return "failed";
  }
  return data ? "upserted" : "no_identity";
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `deno test --allow-env --allow-read --no-check --node-modules-dir=auto supabase/functions/_shared/socialContactIngest.test.ts` → 4 passed.
Run: `deno check supabase/functions/_shared/socialContactIngest.ts` → no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/socialContactIngest.ts supabase/functions/_shared/socialContactIngest.test.ts
git commit -m "feat(audience): touchSocialContact shared ingest helper"
```

### Task 3: Wire the two ingest paths

**Files:**
- Modify: `supabase/functions/facebook-instagram-webhook/index.ts` (after the `isOwnComment(account, normalized.author)` block, before `resolveCommentAutomationHandler`)
- Modify: `supabase/functions/_shared/threadsCommentIngest.ts` (after its `isOwnComment` return, **before** `if (options.dispatch === false) return "seeded";`)
- Modify: `supabase/functions/_shared/threadsCommentIngest.test.ts`

The webhook has no entrypoint test to extend: `facebook-instagram-webhook/` holds only
`attachments.test.ts` and `commentEvents.test.ts`, and the latter exercises the pure normalizer.
The Meta call site is covered by Task 2's unit tests plus manual verification against a real
delivery after deploy. Do not build a webhook harness for it in this task.

**Interfaces:**
- Consumes: `touchSocialContact(admin, account.id, touch)` (Task 2); `runInBackground(label, fn)` from `_shared/background.ts`.

- [ ] **Step 1: Extend the Threads test**

Add to the existing `fakeAdmin` in `threadsCommentIngest.test.ts`:

```ts
    rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    rpc(fn: string, args: Record<string, unknown>) {
      this.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: "row-1", error: null });
    },
```

and three tests (`ingestThreadsComment`, `account`, `reply`, `commentSubscription` are the file's existing exports/fixtures; keep its existing `fetch` stubbing for n8n):

```ts
Deno.test("a dispatched Threads comment touches the audience contact with the account id", async () => {
  const admin = fakeAdmin({ subscriptions: [commentSubscription] });
  await ingestThreadsComment(admin, account, reply, { rawPayload: {} });
  const touch = admin.rpcCalls.find((c) => c.fn === "touch_social_contact");
  assertEquals(touch?.args.p_social_account_id, "acc-1");
  assertEquals(touch?.args.p_platform, "threads");
  assertEquals(touch?.args.p_author_username, "vigrox.kw");
});

Deno.test("seeded history (dispatch=false) still records the contact", async () => {
  const admin = fakeAdmin();
  const outcome = await ingestThreadsComment(admin, account, reply, { rawPayload: {}, dispatch: false });
  assertEquals(outcome, "seeded");
  assertEquals(admin.rpcCalls.filter((c) => c.fn === "touch_social_contact").length, 1);
});

Deno.test("an own Threads comment never touches the audience contact", async () => {
  const admin = fakeAdmin();
  await ingestThreadsComment(admin, account, { ...reply, author: { id: null, name: null, username: "danatfuture" } }, { rawPayload: {} });
  assertEquals(admin.rpcCalls.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test --allow-env --allow-net --allow-read --no-check --node-modules-dir=auto supabase/functions/_shared/threadsCommentIngest.test.ts`
Expected: the first two new tests FAIL.

- [ ] **Step 3: Wire Threads**

Import `touchSocialContact` from `./socialContactIngest.ts`. Insert directly after the `isOwnComment` early return (before the seeding guard):

```ts
  // Capturing who commented is not automation, so it runs even for seeded history.
  await runInBackground("threads audience touch", () =>
    touchSocialContact(admin, account.id, {
      platform: "threads",
      author: comment.author,
      comment: { id: comment.comment.id, text: comment.comment.text },
      post: { id: comment.post.id },
    }));
```

- [ ] **Step 4: Wire Meta**

Import `touchSocialContact` from `../_shared/socialContactIngest.ts`. Immediately after the `isOwnComment(account, normalized.author)` `continue` block:

```ts
          await runInBackground("facebook-instagram audience touch", () => touchSocialContact(
            adminClient,
            account.id,
            {
              platform,
              author: normalized.author,
              comment: { id: normalized.comment.id, text: normalized.comment.text },
              post: { id: normalized.post.id },
            },
          ));
```

No account select changes: the writer derives owner and workspace from `account.id`.

- [ ] **Step 5: Run the whole edge suite and type-check**

Run: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/` → all pass, "ignored" counts unchanged from `main`.
Run: `deno check supabase/functions/_shared/threadsCommentIngest.ts supabase/functions/facebook-instagram-webhook/index.ts` → no new errors versus `main`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/facebook-instagram-webhook/index.ts supabase/functions/_shared/threadsCommentIngest.ts supabase/functions/_shared/threadsCommentIngest.test.ts
git commit -m "feat(audience): touch social contacts from Meta webhook and Threads ingest"
```

---

## Slice 3 — Frontend (Codex lane)

### Task 4: Feature flag plumbing

**Files:**
- Modify: `src/hooks/useFeatureFlags.tsx` (seven places: interface, `DEFAULT_FLAGS`, `FLAG_KEYS`, `FLAG_KEY_MAP`, label map, `ALL_FLAGS_ENABLED`, the `globalFlagMap[...]` build line — each next to its `leadsCrm` sibling)

**Interfaces:** Produces `flags.audienceHub: boolean`.

- [ ] **Step 1: Add the flag**

```ts
  audienceHub: boolean;                       // interface
  audienceHub: false,                         // DEFAULT_FLAGS
  "feature_audience_hub",                     // FLAG_KEYS
  feature_audience_hub: "audienceHub",        // FLAG_KEY_MAP
  audienceHub: "Audience & Contacts",         // label map
  audienceHub: true,                          // ALL_FLAGS_ENABLED
  audienceHub: globalFlagMap["feature_audience_hub"] ?? DEFAULT_FLAGS.audienceHub,
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npx vitest run src/hooks` → pass (update any test that asserts the `FLAG_KEYS` length).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useFeatureFlags.tsx
git commit -m "feat(audience): feature_audience_hub flag"
```

### Task 5: Domain — types, label, CSV

**Files:**
- Create: `src/features/audience/domain/socialContact.ts`
- Create: `src/features/audience/domain/socialContact.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SocialContact { /* the social_contacts row, declared without importing Supabase types */ }
  export type ContactPlatform = "facebook" | "instagram" | "threads" | "youtube";
  export type ContactSource = "organic_comment" | "workflow_lead";
  export interface ContactFilters { search: string; platform: ContactPlatform | "all"; source: ContactSource | "all"; tags: string[]; }
  export const EMPTY_FILTERS: ContactFilters;
  export function contactLabel(row: Pick<SocialContact, "display_name" | "username" | "platform_user_id">): string;
  export function csvCell(value: unknown): string;
  export function buildContactsCsv(rows: SocialContact[]): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildContactsCsv, contactLabel, type SocialContact } from "./socialContact";

const row = {
  id: "1", user_id: "u", workspace_id: null, social_account_id: null, platform: "instagram",
  platform_user_id: "178", identity_kind: "id", display_name: "Dana, KW", username: "dana.kw",
  profile_url: null, email: "Dana@Example.com", phone_number: "96550000000", company: null,
  notes: 'says "hi"', source: "organic_comment", tags: ["lead", "vip"], whatsapp_contact_id: null,
  total_comments_count: 3, first_interacted_at: "2026-09-01T00:00:00Z", last_interacted_at: "2026-09-04T00:00:00Z",
  last_comment_text: "price?", last_post_id: "p1", metadata: {}, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-04T00:00:00Z",
} as SocialContact;

describe("contactLabel", () => {
  it("prefers display name, then username, then id", () => {
    expect(contactLabel(row)).toBe("Dana, KW");
    expect(contactLabel({ ...row, display_name: "" })).toBe("dana.kw");
    expect(contactLabel({ ...row, display_name: "", username: null })).toBe("178");
  });
});

describe("buildContactsCsv", () => {
  it("quotes commas and quotes, joins tags with |, omits metadata", () => {
    const [header, line] = buildContactsCsv([row]).split("\r\n");
    expect(header).toBe("platform,display_name,username,platform_user_id,email,phone_number,company,source,tags,total_comments_count,first_interacted_at,last_interacted_at,notes");
    expect(line).toBe('instagram,"Dana, KW",dana.kw,178,Dana@Example.com,96550000000,,organic_comment,lead|vip,3,2026-09-01T00:00:00Z,2026-09-04T00:00:00Z,"says ""hi"""');
  });
  it("returns only the header for no rows", () => {
    expect(buildContactsCsv([]).split("\r\n")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/audience/domain` → module not found.

- [ ] **Step 3: Implement**

```ts
// ARCHITECTURE.md §4 forbids `domain -> Supabase`, and no other feature's domain imports the
// generated types. The row shape is declared here; infrastructure asserts it against
// Tables<"social_contacts"> so a schema change still breaks the build.
export interface SocialContact {
  id: string;
  user_id: string;
  workspace_id: string | null;
  social_account_id: string | null;
  platform: string;
  platform_user_id: string;
  identity_kind: string;
  display_name: string;
  username: string | null;
  profile_url: string | null;
  email: string | null;
  phone_number: string | null;
  company: string | null;
  notes: string | null;
  source: string;
  tags: string[];
  whatsapp_contact_id: string | null;
  total_comments_count: number;
  first_interacted_at: string;
  last_interacted_at: string;
  last_comment_text: string | null;
  last_post_id: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export type ContactPlatform = "facebook" | "instagram" | "threads" | "youtube";
export type ContactSource = "organic_comment" | "workflow_lead";

export interface ContactFilters {
  search: string;
  platform: ContactPlatform | "all";
  source: ContactSource | "all";
  tags: string[];
}

export const EMPTY_FILTERS: ContactFilters = { search: "", platform: "all", source: "all", tags: [] };

export function contactLabel(row: Pick<SocialContact, "display_name" | "username" | "platform_user_id">): string {
  return row.display_name || row.username || row.platform_user_id;
}

const CSV_COLUMNS = [
  "platform", "display_name", "username", "platform_user_id", "email", "phone_number", "company",
  "source", "tags", "total_comments_count", "first_interacted_at", "last_interacted_at", "notes",
] as const;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildContactsCsv(rows: SocialContact[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n");
}
```

- [ ] **Step 4: Run** — `npx vitest run src/features/audience/domain` → 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/features/audience/domain
git commit -m "feat(audience): domain types, label and CSV builder"
```

### Task 6: Infrastructure repository + ui hooks

**Files:**
- Create: `src/features/audience/infrastructure/socialContactsRepository.ts` (+ `.test.ts`)
- Create: `src/features/audience/infrastructure/downloadBlob.ts` (copy the WhatsApp helper verbatim)
- Create: `src/features/audience/ui/hooks/useSocialContacts.ts` (+ `.test.tsx`)
- Create: `src/features/audience/index.ts`

**Interfaces:**
- Consumes: `SocialContact`, `ContactFilters` (Task 5); RPCs `search_social_contacts`, `get_social_contacts_stats` (Task 1).
- Produces:
  ```ts
  export const CONTACTS_PAGE_SIZE = 50;
  export interface ContactsPage { rows: SocialContact[]; total: number; }
  export interface ContactStats { total: number; workflow_leads: number; enriched: number; top_platform: string | null; }
  export type ContactPatch = Partial<Pick<SocialContact, "display_name" | "email" | "phone_number" | "company" | "notes" | "tags" | "whatsapp_contact_id">>;
  export function listContacts(filters: ContactFilters, page: number): Promise<ContactsPage>;
  export function fetchAllContacts(filters: ContactFilters): Promise<SocialContact[]>;   // export path, 200-row pages up to 5000
  export function fetchContactStats(): Promise<ContactStats>;
  export function fetchDistinctTags(): Promise<string[]>;
  export function updateContact(id: string, patch: ContactPatch): Promise<void>;
  export function deleteContact(id: string): Promise<void>;
  // hooks
  export function useSocialContacts(filters: ContactFilters, page: number);
  export function useSocialContactStats();
  export function useSocialContactTags();
  export function useUpdateSocialContact();   // mutate({ id, patch })
  export function useDeleteSocialContact();   // mutate(id)
  ```

- [ ] **Step 1: Write the failing repository test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const from = vi.fn();
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) } }));

import { listContacts, fetchContactStats, fetchAllContacts, updateContact } from "./socialContactsRepository";
import { EMPTY_FILTERS } from "../domain/socialContact";

function chain(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "limit", "update", "delete"]) q[m] = vi.fn(() => q);
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q as Record<string, ReturnType<typeof vi.fn>> & { then: unknown };
}

beforeEach(() => { from.mockReset(); rpc.mockReset(); });

describe("listContacts", () => {
  it("calls the search RPC with nulls for 'all', the raw term, and a 50-row window", async () => {
    rpc.mockResolvedValue({ data: [{ row_count: 120, contact: { id: "1" } }], error: null });
    const page = await listContacts({ search: "da,na%", platform: "instagram", source: "all", tags: ["lead"] }, 2);
    expect(rpc).toHaveBeenCalledWith("search_social_contacts", {
      p_query: "da,na%", p_platform: "instagram", p_source: null, p_tags: ["lead"], p_limit: 50, p_offset: 100,
    });
    expect(page).toEqual({ rows: [{ id: "1" }], total: 120 });
  });
  it("sends null for an empty search and empty tags", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const page = await listContacts(EMPTY_FILTERS, 0);
    expect(rpc).toHaveBeenCalledWith("search_social_contacts", { p_query: null, p_platform: null, p_source: null, p_tags: null, p_limit: 50, p_offset: 0 });
    expect(page).toEqual({ rows: [], total: 0 });
  });
  it("throws the Supabase error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(listContacts(EMPTY_FILTERS, 0)).rejects.toMatchObject({ message: "nope" });
  });
});

describe("fetchAllContacts", () => {
  it("pages through the RPC until a short page", async () => {
    rpc
      .mockResolvedValueOnce({ data: Array.from({ length: 200 }, (_, i) => ({ row_count: 201, contact: { id: String(i) } })), error: null })
      .mockResolvedValueOnce({ data: [{ row_count: 201, contact: { id: "200" } }], error: null });
    const rows = await fetchAllContacts(EMPTY_FILTERS);
    expect(rows).toHaveLength(201);
    expect(rpc).toHaveBeenNthCalledWith(2, "search_social_contacts", expect.objectContaining({ p_limit: 200, p_offset: 200 }));
  });
});

describe("fetchContactStats", () => {
  it("reads the first row of the set-returning RPC", async () => {
    rpc.mockResolvedValue({ data: [{ total: 3, workflow_leads: 1, enriched: 2, top_platform: "instagram" }], error: null });
    expect(await fetchContactStats()).toEqual({ total: 3, workflow_leads: 1, enriched: 2, top_platform: "instagram" });
    expect(rpc).toHaveBeenCalledWith("get_social_contacts_stats");
  });
  it("returns zeros when the RPC yields no row", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await fetchContactStats()).toEqual({ total: 0, workflow_leads: 0, enriched: 0, top_platform: null });
  });
});

describe("updateContact", () => {
  it("updates by id with the patch", async () => {
    const q = chain({ data: null, error: null });
    from.mockReturnValue(q);
    await updateContact("1", { tags: ["vip"] });
    expect(from).toHaveBeenCalledWith("social_contacts");
    expect(q.update).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(q.eq).toHaveBeenCalledWith("id", "1");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/features/audience/infrastructure` → module not found.

- [ ] **Step 3: Implement the repository**

```ts
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import type { ContactFilters, SocialContact } from "../domain/socialContact";

// Compile-time proof that the hand-declared domain row still matches the generated schema.
type AssertRowShape = Tables<"social_contacts"> extends SocialContact ? true : never;
const _rowShapeOk: AssertRowShape = true;
void _rowShapeOk;

export const CONTACTS_PAGE_SIZE = 50;
const EXPORT_PAGE = 200;
const EXPORT_CAP = 5000;

export interface ContactsPage { rows: SocialContact[]; total: number; }
export interface ContactStats { total: number; workflow_leads: number; enriched: number; top_platform: string | null; }
export type ContactPatch = Partial<Pick<SocialContact, "display_name" | "email" | "phone_number" | "company" | "notes" | "tags" | "whatsapp_contact_id">>;

interface SearchRow { row_count: number; contact: SocialContact; }

function searchArgs(filters: ContactFilters, limit: number, offset: number) {
  return {
    p_query: filters.search.trim() || null,
    p_platform: filters.platform === "all" ? null : filters.platform,
    p_source: filters.source === "all" ? null : filters.source,
    p_tags: filters.tags.length > 0 ? filters.tags : null,
    p_limit: limit,
    p_offset: offset,
  };
}

async function search(filters: ContactFilters, limit: number, offset: number): Promise<ContactsPage> {
  const { data, error } = await supabase.rpc("search_social_contacts", searchArgs(filters, limit, offset));
  if (error) throw error;
  const rows = (data ?? []) as SearchRow[];
  return { rows: rows.map((r) => r.contact), total: rows[0]?.row_count ?? 0 };
}

export function listContacts(filters: ContactFilters, page: number): Promise<ContactsPage> {
  return search(filters, CONTACTS_PAGE_SIZE, page * CONTACTS_PAGE_SIZE);
}

export async function fetchAllContacts(filters: ContactFilters): Promise<SocialContact[]> {
  const all: SocialContact[] = [];
  for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_PAGE) {
    const { rows } = await search(filters, EXPORT_PAGE, offset);
    all.push(...rows);
    if (rows.length < EXPORT_PAGE) break;
  }
  return all;
}

export async function fetchContactStats(): Promise<ContactStats> {
  const { data, error } = await supabase.rpc("get_social_contacts_stats");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;   // set-returning RPC arrives as an array
  return {
    total: Number(row?.total ?? 0),
    workflow_leads: Number(row?.workflow_leads ?? 0),
    enriched: Number(row?.enriched ?? 0),
    top_platform: row?.top_platform ?? null,
  };
}

export async function fetchDistinctTags(): Promise<string[]> {
  const { data, error } = await supabase.from("social_contacts").select("tags").not("tags", "eq", "{}").limit(1000);
  if (error) throw error;
  const set = new Set<string>();
  for (const row of data ?? []) for (const t of row.tags ?? []) set.add(t);
  return [...set].sort();
}

export async function updateContact(id: string, patch: ContactPatch): Promise<void> {
  const { error } = await supabase.from("social_contacts").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteContact(id: string): Promise<void> {
  const { error } = await supabase.from("social_contacts").delete().eq("id", id);
  if (error) throw error;
}
```

- [ ] **Step 4: Run** — `npx vitest run src/features/audience/infrastructure` → 7 passed.

- [ ] **Step 5: Write the failing hook test** (`src/features/audience/ui/hooks/useSocialContacts.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const listContacts = vi.fn();
const updateContact = vi.fn();
vi.mock("../../infrastructure/socialContactsRepository", () => ({
  listContacts: (...a: unknown[]) => listContacts(...a),
  fetchContactStats: vi.fn(),
  fetchDistinctTags: vi.fn(),
  updateContact: (...a: unknown[]) => updateContact(...a),
  deleteContact: vi.fn(),
  CONTACTS_PAGE_SIZE: 50,
}));

import { useSocialContacts, useUpdateSocialContact } from "./useSocialContacts";
import { EMPTY_FILTERS } from "../../domain/socialContact";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSocialContacts", () => {
  it("passes filters and page to the repository", async () => {
    listContacts.mockResolvedValue({ rows: [], total: 0 });
    const { result } = renderHook(() => useSocialContacts({ ...EMPTY_FILTERS, platform: "threads" }, 1), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listContacts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, platform: "threads" }, 1);
  });
});

describe("useUpdateSocialContact", () => {
  it("calls the repository with id and patch", async () => {
    updateContact.mockResolvedValue(undefined);
    const { result } = renderHook(() => useUpdateSocialContact(), { wrapper: wrapper() });
    result.current.mutate({ id: "1", patch: { notes: "x" } });
    await waitFor(() => expect(updateContact).toHaveBeenCalledWith("1", { notes: "x" }));
  });
});
```

- [ ] **Step 6: Implement the hooks** (`src/features/audience/ui/hooks/useSocialContacts.ts`)

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "@/hooks/use-toast";
import type { ContactFilters } from "../../domain/socialContact";
import {
  deleteContact, fetchContactStats, fetchDistinctTags, listContacts, updateContact, type ContactPatch,
} from "../../infrastructure/socialContactsRepository";

const ROOT = "social-contacts";

export function useSocialContacts(filters: ContactFilters, page: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: [ROOT, "list", user?.id, filters, page],
    queryFn: () => listContacts(filters, page),
    enabled: !!user,
    placeholderData: (prev) => prev,
  });
}

export function useSocialContactStats() {
  const { user } = useAuth();
  return useQuery({ queryKey: [ROOT, "stats", user?.id], queryFn: fetchContactStats, enabled: !!user });
}

export function useSocialContactTags() {
  const { user } = useAuth();
  return useQuery({ queryKey: [ROOT, "tags", user?.id], queryFn: fetchDistinctTags, enabled: !!user });
}

function useInvalidateContacts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [ROOT] });
}

export function useUpdateSocialContact() {
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ContactPatch }) => updateContact(id, patch),
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not save contact", description: error.message, variant: "destructive" }),
  });
}

export function useDeleteSocialContact() {
  const invalidate = useInvalidateContacts();
  return useMutation({
    mutationFn: deleteContact,
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Could not delete contact", description: error.message, variant: "destructive" }),
  });
}
```

`src/features/audience/index.ts`:

```ts
export * from "./domain/socialContact";
export * from "./ui/hooks/useSocialContacts";
export { fetchAllContacts, CONTACTS_PAGE_SIZE } from "./infrastructure/socialContactsRepository";
export { downloadBlob } from "./infrastructure/downloadBlob";
```

- [ ] **Step 7: Run** — `npx vitest run src/features/audience` → all pass.

- [ ] **Step 8: Commit**

```bash
git add src/features/audience
git commit -m "feat(audience): repository over the search RPC and TanStack ui hooks"
```

### Task 7: Page, filters, table, nav, route

**Files:**
- Create: `src/pages/automation/AudiencePage.tsx`, `src/pages/automation/__tests__/AudiencePage.test.tsx`
- Create: `src/components/audience/ContactFilters.tsx`, `src/components/audience/ContactsTable.tsx`
- Create (stub, replaced in Task 8): `src/components/audience/ContactDetailsDrawer.tsx`
- Modify: `src/components/layout/DashboardLayout.tsx` (`automationChildren` and the effect dependency list that names `flags.leadsCrm`)
- Modify: `src/components/AnimatedRoutes.tsx` (lazy import next to `UnifiedAgentSetupPage`; route after `/automation/agents`)

**Interfaces:**
- Consumes: `@/features/audience` exports; `PlatformIcon` + `ExtendedPlatform` from `@/components/PlatformIcon` (`size` is a token: `"sm"`); shadcn `Card`, `Input`, `Select`, `Badge`, `Button`, `Table`, `Avatar`.
- Produces: `AudiencePage` default export; `ContactsTable { rows; onOpen(row); onDelete(row) }`; `ContactFilters { value; tags; onChange(next) }`.

- [ ] **Step 1: Write the failing page test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const useSocialContacts = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return {
    ...actual,
    useSocialContacts: (...a: unknown[]) => useSocialContacts(...a),
    useSocialContactStats: () => ({ data: { total: 2, workflow_leads: 1, enriched: 1, top_platform: "instagram" } }),
    useSocialContactTags: () => ({ data: ["lead"] }),
    useUpdateSocialContact: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteSocialContact: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import AudiencePage from "@/pages/automation/AudiencePage";

const rows = [
  { id: "1", platform: "instagram", display_name: "Dana", username: "dana.kw", platform_user_id: "178", email: null, phone_number: null,
    source: "organic_comment", tags: ["lead"], total_comments_count: 3, last_interacted_at: new Date().toISOString(), whatsapp_contact_id: null },
  { id: "2", platform: "threads", display_name: "", username: "vigrox.kw", platform_user_id: "vigrox.kw", email: "v@x.io", phone_number: null,
    source: "workflow_lead", tags: [], total_comments_count: 1, last_interacted_at: new Date().toISOString(), whatsapp_contact_id: null },
];

describe("AudiencePage", () => {
  it("renders KPIs and one row per contact", () => {
    useSocialContacts.mockReturnValue({ data: { rows, total: 2 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText("Audience & Contacts")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-Workflow leads")).toHaveTextContent("1");
    expect(screen.getByText("Dana")).toBeInTheDocument();
    expect(screen.getByText("vigrox.kw")).toBeInTheDocument();
    expect(screen.getByText("Workflow")).toBeInTheDocument();
  });

  it("passes the search term to the hook and resets to page 0", () => {
    useSocialContacts.mockReturnValue({ data: { rows: [], total: 0 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText("Search name, handle, phone or email"), { target: { value: "dana" } });
    expect(useSocialContacts).toHaveBeenLastCalledWith(expect.objectContaining({ search: "dana" }), 0);
  });

  it("shows the empty state when there are no contacts", () => {
    useSocialContacts.mockReturnValue({ data: { rows: [], total: 0 }, isLoading: false });
    render(<MemoryRouter><AudiencePage /></MemoryRouter>);
    expect(screen.getByText("No contacts yet")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/pages/automation/__tests__/AudiencePage.test.tsx` → module not found.

- [ ] **Step 3: `ContactFilters.tsx`**

```tsx
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { ContactFilters as Filters, ContactPlatform, ContactSource } from "@/features/audience";

const PLATFORMS: Array<{ value: ContactPlatform | "all"; label: string }> = [
  { value: "all", label: "All platforms" }, { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" }, { value: "threads", label: "Threads" },
];
const SOURCES: Array<{ value: ContactSource | "all"; label: string }> = [
  { value: "all", label: "All sources" }, { value: "organic_comment", label: "Organic" }, { value: "workflow_lead", label: "Workflow leads" },
];

export function ContactFilters({ value, tags, onChange }: { value: Filters; tags: string[]; onChange: (next: Filters) => void }) {
  const toggleTag = (tag: string) =>
    onChange({ ...value, tags: value.tags.includes(tag) ? value.tags.filter((t) => t !== tag) : [...value.tags, tag] });
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center">
      <Input
        placeholder="Search name, handle, phone or email"
        value={value.search}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
        className="md:max-w-sm"
      />
      <Select value={value.platform} onValueChange={(v) => onChange({ ...value, platform: v as Filters["platform"] })}>
        <SelectTrigger className="md:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={value.source} onValueChange={(v) => onChange({ ...value, source: v as Filters["source"] })}>
        <SelectTrigger className="md:w-44"><SelectValue /></SelectTrigger>
        <SelectContent>{SOURCES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
      </Select>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <button key={tag} type="button" onClick={() => toggleTag(tag)} aria-pressed={value.tags.includes(tag)}>
              <Badge variant={value.tags.includes(tag) ? "default" : "outline"}>{tag}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `ContactsTable.tsx`**

```tsx
import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlatformIcon, type ExtendedPlatform } from "@/components/PlatformIcon";
import { contactLabel, type SocialContact } from "@/features/audience";

export function ContactsTable({ rows, onOpen, onDelete }: {
  rows: SocialContact[]; onOpen: (row: SocialContact) => void; onDelete: (row: SocialContact) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contact</TableHead><TableHead>Source</TableHead><TableHead>Contact info</TableHead>
          <TableHead>Engagement</TableHead><TableHead>Tags</TableHead><TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const label = contactLabel(row);
          return (
            <TableRow key={row.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8"><AvatarFallback>{label.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  <div>
                    <div className="flex items-center gap-2 font-medium"><PlatformIcon platform={row.platform as ExtendedPlatform} size="sm" />{label}</div>
                    {row.username && row.display_name && <div className="text-xs text-muted-foreground">@{row.username}</div>}
                  </div>
                </div>
              </TableCell>
              <TableCell><Badge variant={row.source === "workflow_lead" ? "default" : "secondary"}>{row.source === "workflow_lead" ? "Workflow" : "Organic"}</Badge></TableCell>
              <TableCell className="text-sm">
                {row.phone_number || row.email
                  ? <div className="flex flex-col">{row.phone_number && <span>{row.phone_number}</span>}{row.email && <span>{row.email}</span>}</div>
                  : <span className="text-muted-foreground">Not captured</span>}
              </TableCell>
              <TableCell className="text-sm">
                {row.total_comments_count} comments
                <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(row.last_interacted_at), { addSuffix: true })}</div>
              </TableCell>
              <TableCell><div className="flex flex-wrap gap-1">{row.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}</div></TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" onClick={() => onOpen(row)}>Details</Button>
                <Button size="sm" variant="ghost" onClick={() => onDelete(row)}>Delete</Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 5: `AudiencePage.tsx`**

```tsx
import { useState } from "react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ContactFilters } from "@/components/audience/ContactFilters";
import { ContactsTable } from "@/components/audience/ContactsTable";
import { ContactDetailsDrawer } from "@/components/audience/ContactDetailsDrawer";
import {
  CONTACTS_PAGE_SIZE, EMPTY_FILTERS, useDeleteSocialContact, useSocialContactStats, useSocialContactTags,
  useSocialContacts, type ContactFilters as Filters, type SocialContact,
} from "@/features/audience";

export default function AudiencePage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<SocialContact | null>(null);
  const contacts = useSocialContacts(filters, page);
  const stats = useSocialContactStats();
  const tags = useSocialContactTags();
  const remove = useDeleteSocialContact();

  const rows = contacts.data?.rows ?? [];
  const total = contacts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));

  const kpis = [
    { label: "Total contacts", value: stats.data?.total ?? 0 },
    { label: "Workflow leads", value: stats.data?.workflow_leads ?? 0 },
    { label: "Enriched contacts", value: stats.data?.enriched ?? 0 },
    { label: "Top platform", value: stats.data?.top_platform ?? "—" },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Audience & Contacts</h1>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((k) => (
            <Card key={k.label}>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{k.label}</CardTitle></CardHeader>
              <CardContent className="text-2xl font-semibold" data-testid={`kpi-${k.label}`}>{k.value}</CardContent>
            </Card>
          ))}
        </div>
        <ContactFilters value={filters} tags={tags.data ?? []} onChange={(next) => { setFilters(next); setPage(0); }} />
        <Card>
          <CardContent className="p-0">
            {rows.length === 0 && !contacts.isLoading
              ? <div className="p-10 text-center text-muted-foreground">No contacts yet</div>
              : <ContactsTable rows={rows} onOpen={setSelected} onDelete={(row) => remove.mutate(row.id)} />}
          </CardContent>
        </Card>
        <div className="flex items-center justify-end gap-2 text-sm">
          <span>Page {page + 1} of {pageCount}</span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
        <ContactDetailsDrawer contact={selected} onClose={() => setSelected(null)} />
      </div>
    </DashboardLayout>
  );
}
```

Stub for this task (replaced in Task 8):

```tsx
import type { SocialContact } from "@/features/audience";
export function ContactDetailsDrawer(_props: { contact: SocialContact | null; onClose: () => void }) { return null; }
```

- [ ] **Step 6: Nav and route**

`DashboardLayout.tsx`, in `automationChildren` after the Comment Manager entry:

```ts
      ...(flags.audienceHub ? [{ icon: Users, label: "Audience & Contacts", path: "/automation/audience" }] : []),
```

and add `flags.audienceHub` to the dependency array that already lists `flags.commentManager, flags.leadsCrm, ...`.

`AnimatedRoutes.tsx`:

```ts
const AudiencePage = lazyWithRetry(() => import("@/pages/automation/AudiencePage"), "AudiencePage");
```

```tsx
        <Route path="/automation/audience" element={<ProtectedRoute><AnimatedPage><AudiencePage /></AnimatedPage></ProtectedRoute>} />
```

- [ ] **Step 7: Verify** — `npx vitest run src/pages/automation && npm run typecheck && npm run lint` → pass.

- [ ] **Step 8: Commit**

```bash
git add src/pages/automation/AudiencePage.tsx src/pages/automation/__tests__/AudiencePage.test.tsx src/components/audience src/components/layout/DashboardLayout.tsx src/components/AnimatedRoutes.tsx
git commit -m "feat(audience): Audience & Contacts page, nav entry and route"
```

### Task 8: Contact details drawer

**Files:**
- Replace: `src/components/audience/ContactDetailsDrawer.tsx`
- Create: `src/components/audience/__tests__/ContactDetailsDrawer.test.tsx`

**Interfaces:**
- Consumes: `useUpdateSocialContact` (Task 6); `normalizePhone(raw, defaultDialCode?)` from `@/components/messaging/contacts/contactCodecs` — strips every non-digit and returns digits only, the format `whatsapp_contacts.phone_number` uses.
- Produces: `ContactDetailsDrawer { contact: SocialContact | null; onClose(): void }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return { ...actual, useUpdateSocialContact: () => ({ mutate, isPending: false }) };
});

import { ContactDetailsDrawer } from "../ContactDetailsDrawer";

const contact = {
  id: "1", platform: "instagram", display_name: "Dana", username: "dana.kw", platform_user_id: "178",
  email: null, phone_number: null, company: null, notes: null, tags: ["lead"], source: "organic_comment",
  total_comments_count: 3, last_interacted_at: "2026-09-04T00:00:00Z", first_interacted_at: "2026-09-01T00:00:00Z",
  last_comment_text: "price?", whatsapp_contact_id: null,
} as never;

describe("ContactDetailsDrawer", () => {
  it("saves edited fields with a digits-only phone and lower-cased email", () => {
    render(<ContactDetailsDrawer contact={contact} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+965 5000 0000" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " Dana@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "1", patch: expect.objectContaining({ phone_number: "96550000000", email: "dana@example.com" }) },
      expect.anything(),
    );
  });

  it("adds a tag on Enter and removes a tag", () => {
    render(<ContactDetailsDrawer contact={contact} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Add tag"), { target: { value: "vip" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Add tag"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith({ id: "1", patch: expect.objectContaining({ tags: ["vip"] }) }, expect.anything());
  });

  it("renders nothing when no contact is selected", () => {
    const { container } = render(<ContactDetailsDrawer contact={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/audience` → the stub has no Save button.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { normalizePhone } from "@/components/messaging/contacts/contactCodecs";
import { contactLabel, useUpdateSocialContact, type SocialContact } from "@/features/audience";

interface Draft { display_name: string; email: string; phone_number: string; company: string; notes: string; tags: string[]; }

function toDraft(c: SocialContact): Draft {
  return {
    display_name: c.display_name, email: c.email ?? "", phone_number: c.phone_number ?? "",
    company: c.company ?? "", notes: c.notes ?? "", tags: c.tags,
  };
}

export function ContactDetailsDrawer({ contact, onClose }: { contact: SocialContact | null; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState("");
  const update = useUpdateSocialContact();

  useEffect(() => { setDraft(contact ? toDraft(contact) : null); setTagInput(""); }, [contact]);
  if (!contact || !draft) return null;

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...draft, [key]: e.target.value });

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !draft.tags.includes(tag)) setDraft({ ...draft, tags: [...draft.tags, tag] });
    setTagInput("");
  };

  const save = () => {
    const phone = draft.phone_number.trim();
    update.mutate({
      id: contact.id,
      patch: {
        display_name: draft.display_name.trim(),
        email: draft.email.trim().toLowerCase() || null,
        phone_number: phone ? normalizePhone(phone) || null : null,
        company: draft.company.trim() || null,
        notes: draft.notes.trim() || null,
        tags: draft.tags,
      },
    }, { onSuccess: onClose });
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader><SheetTitle>{contactLabel(contact)}</SheetTitle></SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="text-sm text-muted-foreground">
            {contact.platform} · {contact.total_comments_count} comments · last comment: {contact.last_comment_text ?? "—"}
          </div>
          <div><Label htmlFor="display_name">Name</Label><Input id="display_name" value={draft.display_name} onChange={set("display_name")} /></div>
          <div><Label htmlFor="email">Email</Label><Input id="email" value={draft.email} onChange={set("email")} /></div>
          <div><Label htmlFor="phone">Phone</Label><Input id="phone" value={draft.phone_number} onChange={set("phone_number")} /></div>
          <div><Label htmlFor="company">Company</Label><Input id="company" value={draft.company} onChange={set("company")} /></div>
          <div><Label htmlFor="notes">Notes</Label><Textarea id="notes" value={draft.notes} onChange={set("notes")} /></div>
          <div>
            <Label htmlFor="tag">Tags</Label>
            <div className="mb-2 flex flex-wrap gap-1">
              {draft.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                  <button type="button" aria-label={`Remove tag ${tag}`} className="ml-1" onClick={() => setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) })}>×</button>
                </Badge>
              ))}
            </div>
            <Input id="tag" placeholder="Add tag" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={update.isPending}>Save</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/components/audience src/pages/automation && npm run typecheck` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/audience
git commit -m "feat(audience): contact details drawer with tags and normalised contact fields"
```

### Task 9: Full CSV export

**Files:**
- Create: `src/components/audience/ExportMenu.tsx`, `src/components/audience/__tests__/ExportMenu.test.tsx`
- Modify: `src/pages/automation/AudiencePage.tsx` (render `<ExportMenu filters={filters} />` in the header row next to the `<h1>`)

**Interfaces:**
- Consumes: `fetchAllContacts(filters)`, `buildContactsCsv(rows)`, `downloadBlob(blob, filename)` from `@/features/audience`.
- Produces: `ExportMenu { filters: ContactFilters }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const fetchAllContacts = vi.fn();
const downloadBlob = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return { ...actual, fetchAllContacts: (...a: unknown[]) => fetchAllContacts(...a), downloadBlob: (...a: unknown[]) => downloadBlob(...a) };
});

import { ExportMenu } from "../ExportMenu";
import { EMPTY_FILTERS } from "@/features/audience";

describe("ExportMenu", () => {
  it("downloads the filtered rows as CSV", async () => {
    fetchAllContacts.mockResolvedValue([{ platform: "threads", display_name: "V", username: "v", platform_user_id: "v", email: null, phone_number: null, company: null, source: "organic_comment", tags: [], total_comments_count: 1, first_interacted_at: "a", last_interacted_at: "b", notes: null }]);
    render(<ExportMenu filters={{ ...EMPTY_FILTERS, platform: "threads" }} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(await screen.findByText("Full CSV"));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled());
    expect(fetchAllContacts).toHaveBeenCalledWith({ ...EMPTY_FILTERS, platform: "threads" });
    const [blob, name] = downloadBlob.mock.calls[0];
    expect(name).toMatch(/^audience-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(await (blob as Blob).text()).toContain("threads,V,v,v");
  });
});
```

(Radix dropdowns open on `pointerDown` under jsdom; if this repo's other dropdown tests use a different event, copy theirs.)

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/hooks/use-toast";
import { buildContactsCsv, downloadBlob, fetchAllContacts, type ContactFilters } from "@/features/audience";

export function ExportMenu({ filters }: { filters: ContactFilters }) {
  const [busy, setBusy] = useState(false);

  const exportFull = async () => {
    setBusy(true);
    try {
      const rows = await fetchAllContacts(filters);
      downloadBlob(new Blob([buildContactsCsv(rows)], { type: "text/csv;charset=utf-8" }), `audience-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (error) {
      toast({ title: "Export failed", description: (error as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy}>Export</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={exportFull}>Full CSV</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 4: Verify** — `npx vitest run src/components/audience src/pages/automation` → pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/audience/ExportMenu.tsx src/components/audience/__tests__/ExportMenu.test.tsx src/pages/automation/AudiencePage.tsx
git commit -m "feat(audience): full CSV export"
```

---

## Slice 4 — Phase 3 (Codex lane, after Slices 1–3 are merged)

### Task 10: Meta Custom Audience CSV

**Files:** `src/features/audience/domain/socialContact.ts` (+ test), `src/components/audience/ExportMenu.tsx` (+ test).

- [ ] **Step 1: Confirm the accepted columns.** Open <https://www.facebook.com/business/help/2082575038703844>; record the exact header names for email, phone, first name, last name, and whether a page-scoped user id column exists, as the comment above `META_AUDIENCE_COLUMNS`. This step blocks Step 3; do not proceed from memory.

- [ ] **Step 2: Failing test**

```ts
describe("buildMetaAudienceCsv", () => {
  it("emits only rows with an email or phone, lower-cased email, digits-only phone, split name", () => {
    const lines = buildMetaAudienceCsv([row, { ...row, id: "2", email: null, phone_number: null }]).split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("dana@example.com,96550000000,Dana,KW");
  });
});
```

(Add the header assertion once Step 1 fixes the names.)

- [ ] **Step 3: Implement**

```ts
// Column names per Meta's customer-list reference (spec §5.1), recorded on <date>: <names from Step 1>
const META_AUDIENCE_COLUMNS = ["email", "phone", "fn", "ln"] as const;  // replace with Step 1's names

export function buildMetaAudienceCsv(rows: SocialContact[]): string {
  const lines = [META_AUDIENCE_COLUMNS.join(",")];
  for (const row of rows) {
    if (!row.email && !row.phone_number) continue;
    const [first = "", ...rest] = row.display_name.trim().split(/\s+/);
    lines.push([row.email?.trim().toLowerCase() ?? "", row.phone_number ?? "", first, rest.join(" ")].map(csvCell).join(","));
  }
  return lines.join("\r\n");
}
```

Add a `Meta Custom Audience CSV` item to `ExportMenu` (file `meta-audience-YYYY-MM-DD.csv`) and one test case mirroring Task 9's.

- [ ] **Step 4: Verify and commit** — `npx vitest run src/features/audience src/components/audience`; `git commit -m "feat(audience): Meta custom audience CSV export"`.

### Task 11: WhatsApp contact link

**Files:** repository (+ test), hooks (+ test), `ContactDetailsDrawer.tsx` (+ test), `ContactsTable.tsx`.

- Repository: `findWhatsAppContactByPhone(phone: string): Promise<{ id: string; display_name: string | null } | null>` → `supabase.from("whatsapp_contacts").select("id, display_name").eq("phone_number", phone).maybeSingle()`.
- Hook: `useWhatsAppContactMatch(phone: string | null)` (enabled only when `phone` is set; key `[ROOT, "wa-match", user?.id, phone]`).
- Drawer: when a match exists and `contact.whatsapp_contact_id` is null, render `Link WhatsApp contact "<display_name>"` which calls `update.mutate({ id, patch: { whatsapp_contact_id: match.id } })`; when linked, render a `Link` to `/messaging/whatsapp/contacts` labelled "Open on WhatsApp".
- Table: same "Open on WhatsApp" link in the actions cell when `whatsapp_contact_id` is set.
- Tests mirror Task 8: mock `useWhatsAppContactMatch` → `{ data: { id: "wa-1", display_name: "Dana WA" } }`, click the link button, assert `mutate` called with `{ whatsapp_contact_id: "wa-1" }`; and a test that a repository error surfaces as the mutation's toast (the composite FK rejects a contact from another owner).

Commit: `feat(audience): link social contacts to WhatsApp contacts`.

### Task 12: Google Sheets sync

**Files:**
- Modify: `supabase/functions/_shared/connectorRegistry.ts` (`google_sheets.composio.tools` and `mutating`)
- Create: `supabase/functions/audience-sheets-sync/index.ts` (+ `index.test.ts`)
- Create: `src/components/audience/SheetsSyncDialog.tsx` (+ test); modify `AudiencePage.tsx`

- [ ] **Step 1: Find the append slug and its argument schema**

```bash
curl -s -H "x-api-key: $COMPOSIO_API_KEY" "https://backend.composio.dev/api/v3.1/tools?toolkit_slug=googlesheets&limit=100" \
  | jq '.items[] | select(.slug | test("APPEND"; "i")) | {slug, version, input_parameters}'
```

Record the slug, the version matching `toolkitVersion "20260902_00"`, and the parameter names for spreadsheet id, sheet/range and values. If no append tool exists, **stop and report**; the plan does not specify a `BATCH_UPDATE` range computation.

- [ ] **Step 2: Registry** — add the slug to `tools` and `mutating`; run the `_shared` registry/telemetry Deno tests and update any snapshot enumerating the allow-list.

- [ ] **Step 3: Edge function** (ARCHITECTURE.md §12 shape)

CORS → `authenticateCaller(req)` → body `{ connection_id: string; spreadsheet_id: string; sheet_name: string; contact_ids: string[] }` (1–200 ids, each a UUID) → read `connector_connections.workspace_id` for `connection_id` → `is_workspace_member(workspace_id, userId)` via `adminClient.rpc`, else 200 `{ ok: false, error: "forbidden" }` → `loadActiveConnection(adminClient, connection_id, workspace_id)` → contacts via `.from("social_contacts").select(...).in("id", contact_ids).eq("user_id", userId)` → rows `[date, contactLabel, platform, username, phone, email, source, last_comment_text]` → `composioClientFromEnv().executeTool({ slug, version, workspaceId: workspace_id, connectedAccountId: connection.composioConnectedAccountId, arguments: <built from Step 1's parameter names>, signal: AbortSignal.timeout(20_000) })` → 200 `{ ok: true, appended: n }` or 200 `{ ok: false, error: sanitizeErrorMessage(e) }`.

Test with a fake admin client and a fake Composio client: non-member returns `forbidden` and calls no tool; row shape; tool failure → 200 with `ok: false`.

- [ ] **Step 4: UI** — `SheetsSyncDialog` lists the caller's active `google_sheets` rows from `connector_connections` (new repository function `listGoogleSheetsConnections()`; RLS already scopes to member workspaces), takes spreadsheet id + sheet name, calls `supabase.functions.invoke("audience-sheets-sync", { body })` with the ids of the current table page, and toasts the appended count.

- [ ] **Step 5: Deploy** through the runtime checkout (`docs/runbooks/deploy-edge-function.md`; `git fetch` in `/root/postora-runtime`, then `restart`, never `up -d`).

Commit: `feat(audience): Google Sheets sync through the Composio connector layer`.

---

## Slice 5 — Gates, deploy, wrap-up

### Task 13: Full gate run and PR

- [ ] **Step 1: Deno first, then bun**

```bash
deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/
deno check supabase/functions/_shared/socialContactIngest.ts
rm -rf node_modules && bun install
npm run typecheck && npm run lint && npm test && npm run build
bash scripts/db-harness.sh
```

Expected: all green; `npm test` baseline was 474 passed / 0 failed before this work, plus the new suites.

- [ ] **Step 2: Guards** — `clean-code-guard` on every changed production file, `test-guard` on every test file. Fix findings before the PR.

- [ ] **Step 3: Migration before merge** — `main` auto-deploys the frontend, so apply `20260904120000_social_contacts.sql` on the Contabo Postgres as `supabase_admin` first (fetch via `git fetch origin refs/heads/feat/social-audience-hub` + `FETCH_HEAD` on the runtime checkout), then `NOTIFY pgrst, 'reload schema'`. Deploy the two changed edge functions through the runtime checkout.

- [ ] **Step 4: PR**

```bash
git push -u origin feat/social-audience-hub
gh pr create --title "feat(audience): Social Audience Hub (Phase 1–2)" --body-file docs/superpowers/plans/2026-09-04-social-audience-hub.md
```

One bot review round (Codex), then merge. Flip `feature_audience_hub` for a test user via `user_feature_overrides` before enabling globally.

- [ ] **Step 5: Wrap-up** — `graphify update .`, mem0 `add_memory` with the outcome, final report per CLAUDE.md step 9.

---

## Self-review

- **Spec coverage:** §2.1 nav/route → Task 7; §2.2 header/KPI/filters/table → Task 7; drawer → Task 8; §3.1–3.7 table, composite FKs, RLS, privileges, writer, stats, search → Task 1; §4.1 call sites and Threads placement → Tasks 2–3; §4.2 promotion → Task 1 (RPC + harness case 3); §4.4 workflow-lead → deferred by spec; §5.1 CSVs → Tasks 9–10; §5.2 Sheets with derived workspace → Task 12; §3.4 WhatsApp link → Task 11; §7.1 flag → Task 4; timeline / bulk delete / merge → spec Phase 3, out of this plan.
- **Placeholder scan:** Tasks 10 and 12 open with a discovery step whose result feeds a named constant or argument object, and each names its stop condition. No "TBD" remains.
- **Layering:** the domain declares `SocialContact` itself and infrastructure proves it still matches `Tables<"social_contacts">`, because ARCHITECTURE.md §4 forbids `domain -> Supabase` and no other feature's domain imports the generated types.
- **Type consistency:** `touchSocialContact(admin, socialAccountId, touch)`, `touch_social_contact(p_social_account_id, p_platform, p_author_id, p_author_name, p_author_username, p_comment_text, p_post_id)`, `search_social_contacts(p_query, p_platform, p_source, p_tags, p_limit, p_offset)` → `{ row_count, contact }`, `ContactFilters`, `SocialContact`, `ContactPatch`, `useSocialContacts(filters, page)`, `useUpdateSocialContact().mutate({ id, patch }, opts)` are used with the same names and argument order everywhere.
