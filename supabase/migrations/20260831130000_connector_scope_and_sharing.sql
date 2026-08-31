-- Per-account connectors, Migration A: scope, credentials, sharing.
--
-- WHY
-- Every connected account sees the same connector cards today because
-- ai_agent_tools has no account dimension at all: no social_account_id, no
-- platform, one UNIQUE (user_id, name) across every account a login owns.
-- Choosing "Shopify" over "Supabase" changes a label and nothing else -- no
-- credential fields exist, `connector_type` is decoration, and four of the
-- twelve types the picker offers (myfatoorah, stripe, higgsfield, mcp_custom)
-- are silently rewritten to custom_rest by the deployed writer. This
-- migration adds the account dimension, the credential columns, the explicit
-- share table, and widens the CHECK to the twelve types the registry
-- declares. PR-4's code depends on every part of it.
--
-- It ADDS only. The one thing it drops is the connector_type CHECK, recreated
-- in the same statement pair strictly wider (a CHECK cannot be altered in
-- place). ai_agent_tools_user_id_name_key is NOT dropped -- see D.
--
-- APPLIED BY HAND BY THE OWNER. Rehearse statement by statement with
-- ROLLBACK against production, not a scratch database: Postora migrations
-- self-commit, so an outer BEGIN does not protect anything, and a virgin
-- database hides exactly the replay defects that bit on 2026-08-28.
--
-- ORDERING TRAP -- READ BEFORE REDEPLOYING messaging-api
-- This PR also empties PENDING_DB_CONNECTOR_TYPES in
-- supabase/functions/_shared/connectorRegistry.ts, which widens the derived
-- SERVER_CONNECTOR_TYPES from eight to twelve. The deployed messaging-api
-- validates connector_type against that list; widened, it stops downgrading
-- `stripe` to custom_rest and starts writing it -- and every save of one of
-- the four new types then becomes a violation of the eight-type CHECK until
-- THIS migration is applied: a 500 where there is currently a wrong-but-
-- working row. Merging this PR is safe on its own (Edge Functions do not
-- auto-deploy and nothing calls the new columns yet), but messaging-api must
-- not be redeployed until this migration is live. The same rule, one file.

BEGIN;

-- ============================================================================
-- A. Scope: an owning account, its platform, and explicit sharing state
-- ============================================================================
-- THE DEFAULT IS 'all_accounts', AND THAT IS THE WHOLE POINT. 'account' looks
-- like the right default and is the 2026-08-28 outage wearing a new hat:
-- between this migration and the PR-4 deploy, the DEPLOYED ai_upsert_tool
-- still inserts rows with neither scope nor account. Under an 'account'
-- default those rows land as scope='account', social_account_id=NULL -- a
-- connector no account can ever resolve, saved successfully, with no error
-- anywhere, for every connector saved in that window. Defaulting to
-- 'all_accounts' makes the old writer's rows mean exactly what they already
-- meant, so the window is harmless. PR-4's code writes scope explicitly; a
-- later migration flips the default once no old writer exists.
--
-- The pairing CHECK lands in the SAME transaction as the default, never
-- before it. Split them and the window turns from silent corruption into a
-- hard 500 on every new-connector save (the SET NOT NULL failure exactly:
-- 52 accounts across 20 logins could not save at all). One transaction means
-- no session ever sees the columns without their invariant.
ALTER TABLE public.ai_agent_tools
  ADD COLUMN social_account_id UUID
    REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  ADD COLUMN platform TEXT,
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'all_accounts'
    CHECK (scope IN ('account', 'all_accounts'));

ALTER TABLE public.ai_agent_tools
  ADD CONSTRAINT ai_agent_tools_scope_matches_account
  CHECK ((scope = 'account') = (social_account_id IS NOT NULL));

-- ============================================================================
-- B. The account link must prove owner AND platform, structurally
-- ============================================================================
-- Edge Functions run under the service role, so RLS is not checking them;
-- ownership must live in the schema. The single-column FK above keeps the
-- account owned by the same user; this composite key also keeps the PLATFORM
-- honest -- without it a connector can name platform='instagram' while
-- pointing at a Facebook page, and every account-keyed reader would load the
-- wrong persona class of bug. It reuses the unique key 20260828190000 put on
-- social_accounts; existing rows have a NULL account, and MATCH SIMPLE
-- satisfies a composite FK vacuously, so no backfill is needed.
--
-- > Note for whoever drops things later: this is now the SECOND dependant on
-- > social_accounts (id, user_id, platform) -- ai_agent_configs' FK is the
-- > first. Any future migration that drops that unique key must drop BOTH
-- > dependants first; one that forgets fails only on replay, which is the
-- > failure that hid on 2026-08-28.
ALTER TABLE public.ai_agent_tools
  ADD CONSTRAINT ai_agent_tools_account_same_owner_platform
  FOREIGN KEY (social_account_id, user_id, platform)
  REFERENCES public.social_accounts (id, user_id, platform);

-- ============================================================================
-- C. Credential columns -- the split IS the design
-- ============================================================================
-- `settings` holds non-secret connection facts the UI may read back;
-- `credentials_secret_id` points at ONE Vault secret per connector holding
-- only the secret fields as a JSON blob (written by PR-4 via
-- vault.create_secret, decrypted at call time under the service role);
-- `configured_secret_fields` caches the field NAMES that have values, so the
-- UI can render "Consumer secret: set" without touching Vault. The test
-- columns record the last test_connection probe. No FK to vault.secrets on
-- purpose: a public-schema-only dump does not carry the vault schema, and the
-- runbook (PR-7) must state that vault is backed up with public or not at
-- all -- an FK would turn every such restore into a hard failure instead of
-- a documented operational fact.
ALTER TABLE public.ai_agent_tools
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN credentials_secret_id UUID,
  ADD COLUMN configured_secret_fields TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN last_test_at TIMESTAMPTZ,
  ADD COLUMN last_test_ok BOOLEAN,
  ADD COLUMN last_test_error TEXT;

-- ============================================================================
-- D. Uniqueness moves to (user_id, social_account_id, name) -- expand half
-- ============================================================================
-- NULLS NOT DISTINCT is load-bearing, not decoration. scope='all_accounts'
-- rows carry a NULL social_account_id, and Postgres treats NULLs as distinct
-- by default: verified on the production server (PostgreSQL 17.6), a plain
-- unique index on these three columns accepted THREE identical legacy rows.
-- Without NULLS NOT DISTINCT, PR-7's drop of the old key would leave legacy
-- connectors with no uniqueness at all.
--
-- ai_agent_tools_user_id_name_key is deliberately NOT dropped here. It is the
-- ON CONFLICT target of the DEPLOYED ai_upsert_tool; dropping it in the same
-- migration that adds the columns breaks every connector save in the window
-- before the PR-4 code deploys -- precisely the 2026-08-28 mistake. Both
-- constraints coexist until PR-7, which is legal for a simpler reason than
-- intuition suggests: (user_id, name) is strictly STRONGER, so anything the
-- old constraint admits, the new one admits too. No in-flight save can
-- violate either. Existing rows comply trivially: they are unique under the
-- old key and all share one NULL account.
CREATE UNIQUE INDEX ai_agent_tools_user_account_name_key
  ON public.ai_agent_tools (user_id, social_account_id, name)
  NULLS NOT DISTINCT;

-- ============================================================================
-- E. The connector_type CHECK, rebuilt with all twelve registry types
-- ============================================================================
-- A CHECK cannot be altered in place: DROP, then ADD strictly wider. The
-- twelve are exactly CONNECTOR_TYPES in
-- supabase/functions/_shared/connectorRegistry.ts -- read from there, not
-- retyped, so the two cannot disagree; the contract test in
-- src/lib/__tests__/connectorRegistry.test.ts parses this very list and
-- fails the build if they drift. Until PR-4 lands, saving one of the four
-- new types still degrades to custom_rest server-side, which the old
-- eight-type CHECK accepts -- so this half is inert until the code catches
-- up, and mandatory before it does (otherwise the 400 that replaces the
-- silent downgrade would be a constraint violation instead).
--
-- The DROP is deliberately NOT "IF EXISTS": if the auto-generated constraint
-- name were ever wrong, a silent no-op here would leave BOTH checks active,
-- the effective contract would still be eight types, and every save of a new
-- type would 500 after this migration "succeeded" -- a silent failure worse
-- than a loud one. Fail the migration instead.
ALTER TABLE public.ai_agent_tools
  DROP CONSTRAINT ai_agent_tools_connector_type_check;

ALTER TABLE public.ai_agent_tools
  ADD CONSTRAINT ai_agent_tools_connector_type_check
  CHECK (connector_type IN (
    'supabase', 'mysql_postgres', 'woocommerce', 'shopify',
    'salla', 'zid', 'formula', 'custom_rest',
    'myfatoorah', 'stripe', 'higgsfield', 'mcp_custom'
  ));

-- ============================================================================
-- F. Explicit shares: ai_agent_tool_accounts
-- ============================================================================
-- Connectors are not knowledge sources: they HAVE an owning account (the
-- scope CHECK, the uniqueness key and the composite FK all hang off it), so
-- unlike ai_knowledge_sources there is no shared/restricted column to flip.
-- Sharing is additive link rows instead -- the model #78 shipped for
-- ai_knowledge_source_accounts, reused rather than reinvented. An account
-- resolves a connector when scope='all_accounts' OR it owns it OR a link
-- exists; that predicate is deliberately a SUPERSET of A's, so the two
-- production rows that are all_accounts must not silently narrow.
--
-- user_id is denormalised onto the link for the same reason as the knowledge
-- table: RLS is auth.uid() = user_id, and without the column every policy
-- evaluation needs a join. The secondary index mirrors the knowledge table's:
-- the primary key serves tool-first probes (resolution, ON DELETE CASCADE
-- from ai_agent_tools), while cascade deletes FROM social_accounts and any
-- account-side listing scan on social_account_id alone, which the composite
-- primary key cannot serve.
CREATE TABLE public.ai_agent_tool_accounts (
  tool_id UUID NOT NULL REFERENCES public.ai_agent_tools(id) ON DELETE CASCADE,
  social_account_id UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, social_account_id)
);

CREATE INDEX ai_agent_tool_accounts_account_idx
  ON public.ai_agent_tool_accounts (social_account_id, tool_id);

ALTER TABLE public.ai_agent_tool_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own tool account links"
  ON public.ai_agent_tool_accounts;
CREATE POLICY "Users manage their own tool account links"
  ON public.ai_agent_tool_accounts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================================
-- G. set_ai_agent_tool_accounts: replace a connector's whole share set
-- ============================================================================
-- Mirrors set_ai_knowledge_source_visibility (20260828180000) deliberately,
-- down to the FOR UPDATE ordering and the count(DISTINCT) ownership check:
-- it REPLACES the whole link set in one transaction, takes the row lock
-- first so concurrent sharing changes serialise instead of interleaving with
-- the rewrite, and is granted to service_role only, because messaging-api
-- authenticates the bearer itself and then runs under the service role.
--
-- The owning account is never written as a link row: it resolves through
-- social_account_id, so a link would be a second, silently divergent source
-- of one fact. It is EXCLUDED from the insert rather than rejected, because
-- the sharing strip PR-4 ships renders the owner checked-and-disabled and
-- sends the complete account list -- receiving it is a legal input, the same
-- way duplicate ids are legal and collapsed.
--
-- §12.3 layer 1, the name-collision refusal: the whole reason two tools can
-- share a name is D above, so sharing must refuse to create a state where
-- one account resolves two ENABLED tools of the same name -- the dispatcher
-- assembles tools into a Map keyed by name and would silently keep one at
-- random. "Enabled" is is_enabled IS TRUE, mirroring the dispatcher's own
-- filter. The error names both tools so the user knows what to rename; layer
-- 2 (dispatch time, own-tool-wins plus an ai_agent_logs row) still exists
-- because renames happen after the link does. A disabled shared tool skips
-- the check: it cannot create two ENABLED tools today, and enabling it later
-- is exactly the rename-class event layer 2 owns.

CREATE OR REPLACE FUNCTION public.set_ai_agent_tool_accounts(
  p_user_id uuid,
  p_tool_id uuid,
  p_social_account_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_tool_name text;
  v_tool_enabled boolean;
  v_owner_account_id uuid;
  v_requested integer;
  v_owned integer;
  v_collision_detail text;
BEGIN
  -- Row lock first, and NOT FOUND (not a silent zero-row SELECT) so a tool
  -- the caller does not own is a loud refusal rather than a no-op that
  -- reports success to the UI.
  SELECT name, is_enabled, social_account_id
    INTO v_tool_name, v_tool_enabled, v_owner_account_id
  FROM public.ai_agent_tools
  WHERE id = p_tool_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connector not found for caller';
  END IF;

  -- Duplicate ids are collapsed rather than trusted: counting distinct rows
  -- against a duplicated array would misfire the ownership check, and the
  -- insert would hit the (tool_id, social_account_id) primary key anyway.
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

  IF v_requested > 0 AND v_tool_enabled IS TRUE THEN
    -- The owner is excluded from the targets: it resolves through
    -- social_account_id no matter what this write does, so a collision it
    -- already has is not this share's doing and is layer 2's to handle.
    SELECT string_agg(
             format('account %s already resolves enabled connector %L (tool %s)',
                    target.account_id, v_tool_name, other.id),
             '; ')
      INTO v_collision_detail
    FROM (SELECT DISTINCT account_id
          FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id) AS target,
         public.ai_agent_tools AS other
    WHERE other.id <> p_tool_id
      AND other.user_id = p_user_id
      AND other.name = v_tool_name
      AND other.is_enabled IS TRUE
      AND target.account_id IS DISTINCT FROM v_owner_account_id
      AND (
        other.scope = 'all_accounts'
        OR other.social_account_id = target.account_id
        OR EXISTS (
          SELECT 1
          FROM public.ai_agent_tool_accounts AS link
          WHERE link.tool_id = other.id
            AND link.social_account_id = target.account_id
        )
      );

    IF v_collision_detail IS NOT NULL THEN
      RAISE EXCEPTION
        'Sharing would give an account two enabled connectors named %L: %. '
        'Rename one of them and share again.',
        v_tool_name, v_collision_detail;
    END IF;
  END IF;

  -- Replace the whole link set: partial updates are how stale shares survive
  -- an untick, and an empty array legitimately means "shared with no one".
  DELETE FROM public.ai_agent_tool_accounts
  WHERE tool_id = p_tool_id;

  INSERT INTO public.ai_agent_tool_accounts (tool_id, social_account_id, user_id)
  SELECT p_tool_id, account_id, p_user_id
  FROM (SELECT DISTINCT account_id
        FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id) AS ids
  WHERE account_id IS DISTINCT FROM v_owner_account_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_ai_agent_tool_accounts(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_ai_agent_tool_accounts(uuid, uuid, uuid[]) TO service_role;

COMMIT;
