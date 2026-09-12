# Partner API Section Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Postora's messaging, comments, automation and human-agent capability — including the full WhatsApp surface across Evolution, Cloud API and coexistence — as scoped, metered, versioned `/v1` Partner API endpoints, so an external product can drive all four sections without a user JWT.

**Architecture:** Each operation is lifted out of its user-JWT edge function into a `_shared/` use-case function taking a resolved context rather than an HTTP request. `messaging-api` remains the browser's thin dispatcher; a new `/v1` handler becomes the partner's. Routes register in `V1_ROUTES` naming an alias action, whose scope lives in `ACTION_SCOPES` and whose risk class is handed to the limiter. A new, deliberately tiny platform credential tier provisions workspaces and issues workspace-scoped keys.

**Tech Stack:** Deno edge functions, TypeScript, self-hosted Supabase (PostgreSQL + RLS), `deno test` with `https://deno.land/std@0.208.0/assert/mod.ts`, OpenAPI 3.1 with a machine-checked baseline.

**Spec:** `docs/superpowers/specs/2026-09-10-partner-api-sections-design.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **`ARCHITECTURE.md` is required reading before editing anything under `src/**` or `supabase/functions/**`.** It is not auto-loaded. Read it deliberately. Every delegation brief must name it.
2. **Edge Functions run under the service role, so RLS is not enforcing tenancy.** Every ownership check must be structural — in the SQL, or in a composite foreign key — never left to the caller.
3. **A migration always lands before the code that depends on it.** Ask of every schema change: what is deployed right now, and does this statement still hold for it?
4. **Never let a failed read look like an empty one.** A discarded `error` beside a `maybeSingle()` is a documented production incident in this repository. Always branch on `error` before `data`.
5. **Every early return that refuses work must write a log row.**
6. **Permission-shaped state must be monotonic.** Adding a permission must never narrow access; removing one must never widen it.
7. **No route may be added without all three of:** an alias action in `V1_ROUTES`, a scope entry in `ACTION_SCOPES`, and a risk class (`A` bounded local read, `B` heavier or provider-fanout read, `C` any write, external side effect, or billable action).
8. **Generic scopes only.** No legacy scope (`whatsapp:template.send`, `whatsapp:templates.read`, `whatsapp:webhooks.manage`) may satisfy any new action. `partnerScopes.test.ts` asserts the absence.
9. **Every route change must also update the published contract.** Adding a handler and passing its tests is not done. See "The contract artifact ritual" below — CI's `contract-drift` job fails otherwise.
10. **Zero dead modules.** No new helper is complete without at least one active non-test consumer wired in the same change. Name the calling line; a grep for the export's name also matches type-only imports.
11. **Commit scoped to the task's files only:** `git commit -- <files>`. Never commit `b64.txt`, logs, backups, `.env*`, or secret files.
12. **Do not run `npx supabase functions deploy`.** It targets Supabase Cloud and fails against this self-hosted stack.
13. **Implementers do not commit.** The orchestrator reviews the diff against the dispatch baseline and commits.
14. **Every new `public` function MUST revoke execute from `anon` and `authenticated` by name, not only from `PUBLIC`.** This database carries
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon`, and the same for `authenticated`
    (`supabase/tests/baseline_schema.sql:23842`). Those are **direct role grants**, and `REVOKE ALL ... FROM PUBLIC` does not remove a direct grant.
    A `SECURITY DEFINER` function left that way is callable by any anonymous PostgREST client with caller-chosen arguments — for the functions in this
    plan, that means anyone provisioning workspaces and revoking any partner's keys. Always write:

    ```sql
    REVOKE ALL ON FUNCTION public.<name>(<arg types>) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.<name>(<arg types>) TO service_role;
    ```

    And add a privilege test asserting `has_function_privilege('anon', '<signature>', 'EXECUTE')` is false.
    `ai-agent-adapters/migration.test.ts` already documents this exposure for another function; the same check belongs on each of these.
15. **`service_role` holds only SELECT and INSERT on `partner_api_keys`** (`20260830120300_partner_api_least_privilege_grants.sql`). Any UPDATE or DELETE
    on that table must go through a `SECURITY DEFINER` function. A handler that calls `.update()` or `.delete()` on it directly will fail at runtime,
    and a compensation path built on one is not a compensation.

### The contract artifact ritual

**Do NOT run `scripts/regenerate-openapi-baseline.sh` as part of a task.** An
earlier draft of this plan told you to, before the commit. That is wrong twice
over, and the script's own header says so: it refuses to run on a dirty tree,
and "the baseline is what the gate compares against, so regenerating it first
would make the gate compare the document to itself and find nothing."

Regenerating the baseline is a **post-merge, human-reviewed** step. A task that
advances it defeats the breaking-change detector it was meant to satisfy.

Run this at the end of **every task that adds or changes a route**, before the
commit:

```bash
# 1. Add the route to docs/api/openapi.yaml by hand. Do NOT touch
#    docs/api/openapi.baseline.yaml or docs/api/accepted-breaking-changes.txt.

# 2. Check the new contract against the UNCHANGED baseline. Additive changes
#    pass; a reported break means the task is wrong.
deno run --allow-read scripts/check-openapi-drift.ts

# 3. Regenerate only the derived client artifacts.
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts

# 4. Verify the two generator gates.
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
```

Every change in this plan is **additive**. If `check-openapi-drift.ts` reports a
breaking change, that is a bug in the task — never a reason to edit
`docs/api/accepted-breaking-changes.txt` or advance the baseline.

**Also note `generate-postman.ts` hardcodes the `x-postora-key` header** for
every operation, while the platform tier authenticates with `Bearer`. Teach the
generator the per-tier header in the same task that adds the first platform
route, or the collection will ship platform requests that cannot authenticate
while its regeneration test passes.

### Running the tests

Full edge-function suite, exactly as CI runs it:

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/
```

A single file:

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/v1/<file>.test.ts
```

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/partnerPlatformKeys.ts` | Authenticate a platform key by full hash; resolve its record. Separate from `partnerApiKeys.ts` so the tier is a property of the code path, not of a row. |
| `supabase/functions/_shared/partnerEntitlement.ts` | Resolve whether a workspace's owner is entitled to an (action, channel, mode) predicate, from `app_settings` plus `user_feature_overrides`. |
| `supabase/functions/partner-api/platform/policy.ts` | `PLATFORM_ACTION_SCOPES` and `PLATFORM_ACTION_RISK`. Imports no handlers, so the router can import policy without a cycle. |
| `supabase/functions/partner-api/platform/router.ts` | The `/v1/platform` route table, dispatched from `handleV1Request` in `v1/router.ts`. |
| `supabase/functions/partner-api/platform/authenticated.ts` | `withPlatformAuth`, using the platform-specific rate RPC. |
| `supabase/functions/partner-api/platform/workspaces.ts` | Create, list and get provisioned workspaces. |
| `supabase/functions/partner-api/platform/keys.ts` | Issue and revoke workspace-scoped keys. |
| `supabase/functions/_shared/whatsappNumberOps.ts` | List and get WhatsApp numbers across a workspace. Sibling of `whatsappPartnerOps.ts` — see the alignment note below. |
| `supabase/functions/_shared/whatsappPairingOps.ts` | Register a number, pairing lifecycle, session end, history sync. Same shape. |
| `supabase/functions/_shared/whatsappProfileOps.ts` | Business profile read and update. Same shape. |
| `supabase/functions/partner-api/v1/whatsappNumbers.ts` | `/v1/whatsapp/numbers` handlers. |
| `supabase/functions/_shared/whatsappPartnerOps.ts` (**existing, 26KB**) | Extended in place with the four new send types, forward, revoke, flag. Already holds `sendTemplate`, `sendText`, `sendMedia`, `listTemplates`, `upsertOutboundConversation`. |
| `supabase/functions/_shared/conversationOps.ts` | Conversation reads, delete, mark-read, state. |
| `supabase/functions/_shared/contactOps.ts` | Contact list and get. |
| `supabase/functions/partner-api/v1/contacts.ts` | `/v1/contacts` handlers. |
| `supabase/functions/_shared/whatsappPartnerOps.ts` (existing) | Also gains template create and delete beside the existing `listTemplates`. |
| `supabase/functions/_shared/whatsappCatalogOps.ts` | Catalog and products. |
| `supabase/functions/partner-api/v1/whatsappCatalog.ts` | `/v1/whatsapp/catalog` and `/products` handlers. |
| `supabase/functions/_shared/broadcastOps.ts` | Broadcast create, list, get. |
| `supabase/functions/partner-api/v1/broadcasts.ts` | `/v1/whatsapp/broadcasts` handlers. |
| `supabase/functions/_shared/scheduledMessageOps.ts` | Scheduled send create, list, cancel. |
| `supabase/functions/partner-api/v1/scheduledMessages.ts` | `/v1/whatsapp/scheduled-messages` handlers. |
| `supabase/functions/_shared/whatsappAnalyticsOps.ts` | Analytics reads. |
| `supabase/functions/partner-api/v1/analytics.ts` | `/v1/whatsapp/analytics` handlers. |
| `supabase/functions/_shared/commentOps.ts` | Comment list, get, reply, hide, delete. Lifted from `comment-manager`. |
| `supabase/functions/partner-api/v1/comments.ts` | `/v1/comments` handlers. |
| `supabase/functions/_shared/automationOps.ts` | Agent config, tools, handlers, conversation modes, auto-replies, audience. |
| `supabase/functions/partner-api/v1/automation.ts` | `/v1/automation` handlers. |
| `supabase/functions/_shared/agentOps.ts` | Human agent CRUD and assignment. |
| `supabase/functions/partner-api/v1/agents.ts` | `/v1/agents` and assignment handlers. |

Each new file above gets a sibling `*.test.ts`.

### Modified files

| File | Change |
|---|---|
| `supabase/functions/partner-api/router.ts` | `ACTION_SCOPES` and `ACTION_RISK_CLASSES` gain every new workspace action, **together** — an existing assertion requires their key sets to match exactly. |
| `supabase/functions/partner-api/v1/router.ts` | `V1_ROUTES` gains every new route, and `handleV1Request` resolves `PLATFORM_ROUTES` first. This is the real dispatcher; `partner-api/router.ts` holds policy only. |
| `supabase/functions/partner-api/v1/authenticated.ts` | `resolveWhatsAppAccount` extended to accept an optional account id (spec §4.4). |
| `scripts/generate-postman.ts` | Per-tier auth header: platform routes use `Bearer`, workspace routes keep `x-postora-key`. |
| `supabase/functions/_shared/partnerScopes.ts` | The new generic scopes. |
| `supabase/functions/partner-api/v1/errors.ts` | `feature_not_entitled`; generalise `unsupported_capability`'s message. |
| `supabase/functions/_shared/partnerWebhookEvents.ts` | Eleven new certified event types. |
| `supabase/functions/partner-api/v1/conversations.ts` | New sub-resource handlers. |
| `supabase/functions/partner-api/v1/messages.ts` | Four new body types, forward, revoke, flag. |
| `supabase/functions/partner-api/v1/templates.ts` | Create and delete. |
| `supabase/functions/messaging-api/index.ts` | Each lifted action becomes a call into its use-case. |
| `supabase/functions/comment-manager/index.ts` | Same, for the seven comment actions. |
| `supabase/functions/whatsapp-evolution-bridge/index.ts` | Same, for the pairing actions. |
| `docs/api/openapi.yaml` + generated artifacts | Every new route. |
| `POSTORA_PARTNER_API_PRD_v1.0.md` | Replace the stale DEFERRED banner. |

---

# Phase 1 — Platform tier, entitlement, WhatsApp connection lifecycle

Unblocks: a partner can provision a tenant workspace, receive a key, and pair a
WhatsApp number.

---

### Task 1: Principals, platform keys, platform rate buckets, and vocabulary

Rewritten after debate round 1 (findings 1, 3, 11, 16, 19).

**Files:**
- Create: `supabase/migrations/20260910100000_partner_platform_tier.sql`
- Modify: `supabase/functions/_shared/partnerScopes.ts`
- Modify: `supabase/functions/_shared/partnerScopes.test.ts`
- Modify: `docs/api/openapi.yaml` (the scope enum)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `partner_principals`, `partner_platform_keys`, `partner_platform_rate_buckets`, `partner_provisioned_workspaces`; RPC `consume_partner_platform_rate`; scopes `platform:workspaces.read`, `platform:workspaces.manage`, `platform:keys.manage`.

- [ ] **Step 1: Write the failing scope test**

Append to `supabase/functions/_shared/partnerScopes.test.ts`:

```typescript
Deno.test("platform scopes are generic, never legacy", () => {
  const platformScopes = [
    "platform:workspaces.read",
    "platform:workspaces.manage",
    "platform:keys.manage",
  ];
  for (const scope of platformScopes) {
    assertEquals(
      GENERIC_SCOPES.includes(scope as GenericScope),
      true,
      `${scope} must be a generic scope, or issuance rejects it`,
    );
    assertEquals(
      (LEGACY_SCOPES as readonly string[]).includes(scope),
      false,
      `${scope} must never be legacy`,
    );
  }
});
```

Match the real exported names in `partnerScopes.ts` before writing this. If the
generic list is exported under a different identifier, use that one.

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-read --no-check --node-modules-dir=auto \
  supabase/functions/_shared/partnerScopes.test.ts
```

Expected: FAIL — `platform:workspaces.read must be a generic scope`.

- [ ] **Step 3: Add the scopes, and the OpenAPI enum in the same step**

Add the three scopes to the generic list in `_shared/partnerScopes.ts`, keeping
its existing alphabetical order.

**Then add the same three to the scope enum in `docs/api/openapi.yaml`.** An
existing contract test compares that enum to the vocabulary exactly, so changing
one without the other fails a gate that has nothing to do with this task. This
is why the two edits are one step, not two.

- [ ] **Step 4: Run both gates**

```bash
deno test --allow-env --allow-read --no-check --node-modules-dir=auto \
  supabase/functions/_shared/partnerScopes.test.ts
deno run --allow-read scripts/check-openapi-drift.ts
```

Expected: PASS, and the drift check reports an **additive** change, not a break.

- [ ] **Step 5: Write the migration**

Create `supabase/migrations/20260910100000_partner_platform_tier.sql`:

```sql
-- The platform credential tier (spec §5.2 to §5.4a).
--
-- Four tables and one RPC. The shapes are driven by three constraints found
-- during review, each of which broke an earlier design:
--
--  1. partner_api_keys.social_account_id is NOT NULL with a composite FK, and
--     create_partner_key requires it. A workspace key cannot precede an
--     account, and an account cannot precede a key -- so PROVISIONING creates
--     both, atomically, in one function. See provision_partner_tenant below.
--  2. consume_partner_rate_v2 writes buckets whose key_id references
--     partner_api_keys. A platform key id violates that FK, so the platform
--     tier needs its own bucket table -- not a renamed call.
--  3. Ownership must bind to a stable PRINCIPAL, not to a credential. Binding
--     to a platform_key_id would strand a partner's whole estate the moment
--     they rotated that key.

-- 1. The stable owner. Credentials attach to this; workspaces belong to it.
CREATE TABLE public.partner_principals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.partner_principals ENABLE ROW LEVEL SECURITY;

-- 2. Rotatable credentials for a principal.
CREATE TABLE public.partner_platform_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        UUID NOT NULL REFERENCES public.partner_principals(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  -- The vocabulary is the EXISTING one: KEY_PREFIX_BY_ENVIRONMENT maps
  -- production -> pk_live_ and staging -> pk_test_. Introducing 'live'/'test'
  -- here would give the platform tier a second environment vocabulary for the
  -- same two environments.
  environment         TEXT NOT NULL CHECK (environment IN ('production', 'staging')),
  key_prefix          TEXT NOT NULL,
  -- The platform tier's own prefixes, so a platform key is distinguishable
  -- from a workspace key by inspection: pl_live_ / pl_test_.
  CONSTRAINT partner_platform_keys_prefix_matches_environment CHECK (
    (environment = 'production' AND key_prefix LIKE 'pl\_live\_%') OR
    (environment = 'staging'    AND key_prefix LIKE 'pl\_test\_%')
  ),
  -- Authentication queries by HASH, matching authenticatePartnerKey. The
  -- prefix is display only: it is not unique, so a maybeSingle() lookup on it
  -- would fail the moment two keys shared one.
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 30,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A platform key may hold ONLY platform scopes. In the database, because a
  -- handler check is one refactor from being skipped.
  CONSTRAINT partner_platform_keys_scopes_are_platform
    CHECK (scopes <@ ARRAY[
      'platform:workspaces.read',
      'platform:workspaces.manage',
      'platform:keys.manage'
    ]::TEXT[])
);

CREATE INDEX idx_partner_platform_keys_live
  ON public.partner_platform_keys (principal_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.partner_platform_keys ENABLE ROW LEVEL SECURITY;

-- 3. Rate buckets for the platform tier. Mirrors the shape the workspace-tier
--    bucket table uses; read that migration and match its columns and its
--    window semantics exactly, so the two limiters cannot drift.
CREATE TABLE public.partner_platform_rate_buckets (
  key_id        UUID NOT NULL REFERENCES public.partner_platform_keys(id) ON DELETE CASCADE,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

ALTER TABLE public.partner_platform_rate_buckets ENABLE ROW LEVEL SECURITY;

-- 4. Which principal provisioned which workspace, and the service identity
--    that owns its accounts. RESTRICT on the owner: it is a cascade root, and
--    a routine user-pruning job must fail loudly here rather than silently
--    deleting every connected account in the workspace.
CREATE TABLE public.partner_provisioned_workspaces (
  workspace_id      UUID PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  principal_id      UUID NOT NULL REFERENCES public.partner_principals(id) ON DELETE RESTRICT,
  owner_user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  external_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (principal_id, external_ref)
);

ALTER TABLE public.partner_provisioned_workspaces ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.partner_provisioned_workspaces.owner_user_id IS
  'Service identity owning this workspace''s social accounts. Interactive '
  'authentication is disabled for it. Never prune: deleting it cascades away '
  'every connected account.';

-- The platform limiter. Same semantics as consume_partner_rate_v2, different
-- bucket table. Read that function and mirror its window arithmetic and its
-- return shape exactly; a limiter that rounds its window differently is a
-- limiter with a different limit.
-- Signature and semantics mirror consume_partner_rate_v2 exactly: RETURNS
-- TABLE, not JSONB, so both doors read the same shape.
--
-- reset_seconds is seconds REMAINING in the consumed window, 1..60, computed
-- with CEIL. Never floor and never `60 - EXTRACT(SECOND)`: both can yield 0
-- during the final fraction of a second, which claims a live window has
-- already ended. Retry-After is delay-seconds by RFC 9110, so this same number
-- feeds the header with no local recomputation.
--
-- now() is captured ONCE so the bucket incremented and the window the reset is
-- measured against are provably the same instant.
CREATE OR REPLACE FUNCTION public.consume_partner_platform_rate(
  p_key_id UUID,
  p_limit  INTEGER
) RETURNS TABLE (allowed BOOLEAN, remaining INTEGER, reset_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  INTEGER;
  v_now    TIMESTAMPTZ;
  v_window TIMESTAMPTZ;
BEGIN
  v_now := now();
  v_window := date_trunc('minute', v_now);

  INSERT INTO public.partner_platform_rate_buckets (key_id, window_start, count)
  VALUES (p_key_id, v_window, 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET count = partner_platform_rate_buckets.count + 1
  RETURNING count INTO v_count;

  RETURN QUERY SELECT
    v_count <= p_limit,
    GREATEST(p_limit - v_count, 0),
    CEIL(EXTRACT(EPOCH FROM (v_window + INTERVAL '1 minute' - v_now)))::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_partner_platform_rate(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_partner_platform_rate(UUID, INTEGER) TO service_role;
```

Before writing the RPC body, open the migration that defines
`consume_partner_rate_v2` and reproduce its window arithmetic and JSON keys.
The sketch above is the intent; that function is the specification.

- [ ] **Step 6: Write the provisioning function**

Still in the same migration. This is what breaks the bootstrap cycle, and it is
a function rather than four client calls because four separate commits leave
orphans when the third fails:

```sql
-- Provision a tenant: workspace, service owner, membership, WhatsApp
-- placeholder account, and the workspace key bound to it -- atomically.
--
-- WHY ONE FUNCTION. partner_api_keys.social_account_id is NOT NULL, so the key
-- needs the account; the account is created by pairing, which needs the key.
-- Creating both here is the only order that satisfies both constraints. Doing
-- it in four client round-trips leaves an orphaned auth user and workspace
-- whenever a later step fails, and a retry of the same external_ref creates
-- another pair before hitting the uniqueness violation.
--
-- The auth user is NOT created here -- auth.users is written through the Auth
-- admin API, not SQL. The caller creates it first and passes its id, then
-- deletes it if this function raises. That compensation is the one step that
-- cannot be transactional, and the handler must implement it.
CREATE OR REPLACE FUNCTION public.provision_partner_tenant(
  p_principal_id     UUID,
  p_owner_user_id    UUID,
  p_workspace_name   TEXT,
  p_external_ref     TEXT,
  p_connection_name  TEXT,
  p_key_name         TEXT,
  p_key_prefix       TEXT,
  p_key_hash         TEXT,
  p_scopes           TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
  v_account_id   UUID := gen_random_uuid();
  v_key_id       UUID;
BEGIN
  IF p_scopes && ARRAY[
    'platform:workspaces.read',
    'platform:workspaces.manage',
    'platform:keys.manage'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'a workspace key may not hold a platform scope'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.workspaces (name, owner_id, is_personal)
  VALUES (p_workspace_name, p_owner_user_id, false)
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, p_owner_user_id, 'owner');

  INSERT INTO public.partner_provisioned_workspaces
    (workspace_id, principal_id, owner_user_id, external_ref)
  VALUES (v_workspace_id, p_principal_id, p_owner_user_id, p_external_ref);

  -- The placeholder the key binds to. pending_ id and empty token are filled
  -- in by pairing; is_active stays false until reconciliation activates it.
  --
  -- CONSENT AND QUOTA. This row is a Direct QR account, so both gates apply,
  -- and this path does NOT go through registerNumber where they live. The
  -- caller must therefore validate the risk-consent attestation and enforce
  -- the account quota BEFORE calling this function, and pass the consent
  -- fields in so they are recorded on the row it creates. Extend this
  -- signature with the consent parameters rather than leaving the metadata
  -- below consent-free: a provisioned number that paired without a recorded
  -- attestation is exactly the audit gap §5.5 exists to prevent.
  INSERT INTO public.social_accounts
    (id, user_id, workspace_id, platform, platform_user_id, platform_username,
     access_token, connection_mode, account_metadata, is_active)
  VALUES
    (v_account_id, p_owner_user_id, v_workspace_id, 'whatsapp',
     'pending_' || v_account_id::TEXT, p_connection_name,
     '', 'evolution_qr',
     jsonb_build_object('connection_mode', 'evolution_qr',
                        'display_name', p_connection_name),
     false);

  INSERT INTO public.partner_api_keys
    (workspace_id, social_account_id, name, key_prefix, key_hash, scopes)
  VALUES
    (v_workspace_id, v_account_id, p_key_name, p_key_prefix, p_key_hash, p_scopes)
  RETURNING id INTO v_key_id;

  -- Finding 2: without this row the key cannot see the account it was issued
  -- against. binding.ts has no fallback, so listing would omit it and pairing
  -- would refuse it as unbound.
  INSERT INTO public.partner_api_key_accounts (key_id, workspace_id, social_account_id)
  VALUES (v_key_id, v_workspace_id, v_account_id);

  RETURN jsonb_build_object(
    'workspace_id', v_workspace_id,
    'account_id', v_account_id,
    'key_id', v_key_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_partner_tenant(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_partner_tenant(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO service_role;
```

Open `partner_api_key_accounts`'s definition and confirm its column names
before writing that last insert. If it carries extra required columns, supply
them.

- [ ] **Step 7: Verify against the database harness**

This migration is exactly what CI's `db-harness` job exists to check. Run it as
that job does, or at minimum apply the file to a throwaway Postgres and confirm
`provision_partner_tenant` executes end to end and rolls back on a forced
failure.

Do not rely on reading the SQL. A function this long with five inserts is where
a wrong column name hides until production.

- [ ] **Step 8: Commit**

```bash
git commit -- supabase/migrations/20260910100000_partner_platform_tier.sql \
               supabase/functions/_shared/partnerScopes.ts \
               supabase/functions/_shared/partnerScopes.test.ts \
               docs/api/openapi.yaml \
  -m "feat(partner-api): platform credential tier, principals and atomic provisioning"
```

---

### Task 2: Platform key authentication

Rewritten after debate round 1 (findings 3, 13, 14).

**Files:**
- Create: `supabase/functions/_shared/partnerPlatformKeys.ts`
- Create: `supabase/functions/partner-api/platform/authenticated.ts`
- Create: `supabase/functions/partner-api/platform/policy.ts`
- Test: `supabase/functions/partner-api/platform/authenticated.test.ts`

**Interfaces:**
- Consumes: Task 1's tables and `consume_partner_platform_rate`.
- Produces:
  - `PLATFORM_ACTION_SCOPES: Record<string, readonly string[]>` and `PLATFORM_ACTION_RISK: Record<string, LimiterRiskClass>` — in `policy.ts`, **separate from the router**, so the router may import policy without policy importing handlers.
  - `interface PlatformKeyRecord { id: string; principalId: string; keyPrefix: string; scopes: string[]; rateLimitPerMin: number; expiresAt: string | null; revokedAt: string | null; }`
  - `authenticatePlatformKey(admin, presented): Promise<PlatformKeyRecord | null>`
  - `interface PlatformAuthedContext { admin; record: PlatformKeyRecord; requestId: string; rateHeaders: Record<string, string>; }`
  - `withPlatformAuth(action, riskClass, handler, adminFactory?)` returning the same `(req, requestId, params, doorFactory?) => Promise<Response>` shape as `withPartnerAuth`.

**Three corrections that drove this rewrite.**

1. Authentication queries by **full hash**, not by a derived prefix. The prefix
   is display-only and not unique, so a `maybeSingle()` on it fails as soon as
   two keys share one — which, for an environment-derived prefix, is
   immediately.
2. There is no `enforceRateLimit`. The real export is
   `checkRateLimit(client, record, riskClass)`, and it returns a status union
   and throws on refusal. The platform tier cannot use its RPC anyway: the
   bucket table's `key_id` references `partner_api_keys`.
3. **`generatePartnerKey` cannot mint a platform key as it stands.** It
   hardcodes `KEY_PREFIX_BY_ENVIRONMENT`, which maps `production` to `pk_live_`
   and `staging` to `pk_test_`, and it returns `{ key, prefix, hash }` — the
   hash is already there, so calling `hashPartnerKey` again is redundant.

   Extract a parameterised generator rather than writing a second one:

   ```typescript
   // In _shared/partnerApiKeys.ts. generatePartnerKey keeps its signature and
   // becomes a call into this, so there stays exactly ONE key format.
   export async function generateKeyWithPrefix(
     prefix: string,
   ): Promise<{ key: string; prefix: string; hash: string }> { /* existing body */ }
   ```

   Two generators would mean two body alphabets and two hash formats, and a key
   that authenticates at one door and not the other.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/partner-api/platform/authenticated.test.ts`. Note the
fixture builds a **real** key and hash: a literal `"hash"` can never equal a
SHA-256 of the presented key, so a test using one proves nothing about the
success path.

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { withPlatformAuth } from "./authenticated.ts";

const PRESENTED = "pl_live_0123456789abcdef0123456789abcdef";

async function rowFor(scopes: string[]) {
  return {
    id: "pk-1",
    principal_id: "pr-1",
    key_prefix: "pl_live",
    key_hash: await hashPartnerKey(PRESENTED),
    scopes,
    rate_limit_per_min: 30,
    expires_at: null,
    revoked_at: null,
  };
}

function stub(row: unknown) {
  return {
    rpc(name: string) {
      if (name === "consume_partner_platform_rate") {
        return Promise.resolve({
          data: { allowed: true, remaining: 29, reset_seconds: 42 },
          error: null,
        });
      }
      return Promise.resolve({ error: null });
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        update() { return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        insert() { return Promise.resolve({ error: null }); },
      };
    },
  };
}

function request() {
  return new Request("https://x/v1/platform/workspaces", {
    method: "POST",
    headers: { authorization: `Bearer ${PRESENTED}` },
  });
}

Deno.test("a platform key with the required scope reaches the handler", async () => {
  let reached = false;
  const route = withPlatformAuth("create_workspace", "C", () => {
    reached = true;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }, () => stub(await rowFor(["platform:workspaces.manage"])));
  const res = await route(request(), "req-1", {});
  assertEquals(res.status, 200);
  assertEquals(reached, true);
});

Deno.test("a platform key without the required scope is refused", async () => {
  const route = withPlatformAuth("create_workspace", "C", () =>
    Promise.resolve(new Response("{}", { status: 200 })),
    () => stub(await rowFor(["platform:workspaces.read"])));
  const res = await route(request(), "req-1", {});
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "insufficient_scope");
});

Deno.test("an unknown key is refused before any handler runs", async () => {
  const route = withPlatformAuth("create_workspace", "C", () =>
    Promise.resolve(new Response("{}", { status: 200 })),
    () => stub(null));
  const res = await route(request(), "req-1", {});
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, "invalid_key");
});

Deno.test("a WORKSPACE key presented to the platform door is not found, not unauthorized", async () => {
  // Spec §5.3 rule 3: a wrong-tier credential must not learn that the platform
  // tier exists. 401 would confirm it; 404 does not.
  const route = withPlatformAuth("create_workspace", "C", () =>
    Promise.resolve(new Response("{}", { status: 200 })),
    () => stub(null));
  const req = new Request("https://x/v1/platform/workspaces", {
    method: "POST",
    headers: { authorization: "Bearer pk_live_workspacekeynotplatform" },
  });
  const res = await route(req, "req-1", {});
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "resource_not_found");
});
```

The last test encodes a decision the earlier draft got wrong: it returned 401
for a wrong-tier credential while the spec required 404.

**The rule is symmetric, and the other direction is not implemented yet.**
`v1/authenticated.ts` currently answers 401 when a platform credential reaches a
workspace route. Add the mirror check there in this task: a presented key with
the platform prefix answers `resource_not_found`, not `invalid_key`.

Both directions need a test, and both must exercise **both header forms** —
`Authorization: Bearer` and `x-postora-key` — because a check that reads only
one leaves the other as a working oracle for which tiers exist. That is four
cases, and the isolation suite must contain all four.

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/authenticated.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the key resolver**

Create `supabase/functions/_shared/partnerPlatformKeys.ts`:

```typescript
// Platform-tier key authentication (spec §5.4).
//
// A separate module from partnerApiKeys.ts on purpose. One resolver returning
// "some key record" would make the tier a property of the row rather than of
// the code path, and a single missing check would let a workspace key reach a
// provisioning route.
//
// Lookup is by HASH, matching authenticatePartnerKey. key_prefix is display
// only and is not unique; a maybeSingle() on it breaks the moment two keys
// share a prefix, which for an environment-based prefix is immediately.

import { doorEnvironment, hashPartnerKey, type PartnerEnvironment } from "./partnerApiKeys.ts";

export interface PlatformKeyRecord {
  id: string;
  principalId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** Platform prefixes, mirroring KEY_PREFIX_BY_ENVIRONMENT's two environments. */
const PLATFORM_PREFIX_BY_ENVIRONMENT = {
  production: "pl_live_",
  staging: "pl_test_",
} as const;

export async function authenticatePlatformKey(
  // deno-lint-ignore no-explicit-any
  admin: any,
  presented: string,
  doorEnv: PartnerEnvironment = doorEnvironment(),
): Promise<PlatformKeyRecord | null> {
  // BOTH environment checks that authenticatePartnerKey performs, reproduced
  // here. Without them a staging credential restored into a production
  // database authenticates against production.
  //
  // Check one, the prefix layer: refuse the other environment's key before any
  // lookup, with the same answer an unknown key gets — so a production door
  // never confirms a staging key exists.
  if (!presented || !presented.startsWith(PLATFORM_PREFIX_BY_ENVIRONMENT[doorEnv])) {
    return null;
  }

  const presentedHash = await hashPartnerKey(presented);

  const { data, error } = await admin
    .from("partner_platform_keys")
    .select("id, principal_id, key_prefix, scopes, rate_limit_per_min, expires_at, revoked_at, environment")
    .eq("key_hash", presentedHash)
    .is("revoked_at", null)
    .maybeSingle();

  // Global constraint 4: a failed read must never look like an empty one.
  if (error) throw new Error(`platform key lookup failed: ${error.message}`);
  if (!data) return null;

  // Check two, the row layer: the stored environment must match the door. The
  // prefix CHECK only makes a row internally consistent; it says nothing about
  // which deployment is reading it.
  if (data.environment !== doorEnv) return null;

  if (data.expires_at && new Date(data.expires_at) <= new Date()) return null;

  return {
    id: data.id,
    principalId: data.principal_id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
    rateLimitPerMin: data.rate_limit_per_min,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
  };
}
```

- [ ] **Step 4: Implement the policy table**

Create `supabase/functions/partner-api/platform/policy.ts`. It imports nothing
from the router or the handlers, which is what breaks the import cycle the
earlier draft had:

```typescript
// Platform-tier policy. Separate from router.ts so the router may import
// policy without policy importing handlers -- the cycle that made Task 2's
// tests unrunnable in the previous draft.

import type { LimiterRiskClass } from "../../_shared/partnerApiMetering.ts";

export const PLATFORM_ACTION_SCOPES: Record<string, readonly string[]> = {
  create_workspace: ["platform:workspaces.manage"],
  list_platform_workspaces: ["platform:workspaces.read"],
  get_platform_workspace: ["platform:workspaces.read"],
  issue_workspace_key: ["platform:keys.manage"],
  revoke_workspace_key: ["platform:keys.manage"],
};

// An existing assertion elsewhere requires the scope and risk maps to have
// identical key sets. Adding to one without the other fails that test.
export const PLATFORM_ACTION_RISK: Record<string, LimiterRiskClass> = {
  create_workspace: "C",
  list_platform_workspaces: "A",
  get_platform_workspace: "A",
  issue_workspace_key: "C",
  revoke_workspace_key: "C",
};
```

- [ ] **Step 5: Implement the auth wrapper**

Create `supabase/functions/partner-api/platform/authenticated.ts`. Read
`partner-api/v1/authenticated.ts` and `_shared/partnerApiMetering.ts` first, and
mirror `checkRateLimit`'s real result handling and header stamping rather than
the sketch below:

```typescript
import { authenticatePlatformKey, type PlatformKeyRecord } from "../../_shared/partnerPlatformKeys.ts";
import { PLATFORM_ACTION_SCOPES } from "./policy.ts";
import { v1ErrorResponse } from "../v1/errors.ts";
import type { LimiterRiskClass } from "../../_shared/partnerApiMetering.ts";

export interface PlatformAuthedContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  record: PlatformKeyRecord;
  requestId: string;
  rateHeaders: Record<string, string>;
}

export type PlatformAuthedHandler = (
  req: Request,
  authed: PlatformAuthedContext,
  params: Record<string, string>,
) => Promise<Response>;

/** A presented credential that is not a platform key at all. The platform door
 *  must not confirm its own existence to a workspace key, so this is 404. */
const PLATFORM_PREFIX = "pl_";
// pl_live_ and pl_test_ mirror the workspace tier's pk_live_ / pk_test_, so
// a credential's tier is readable from the key itself. The migration's
// prefix-matches-environment CHECK is what keeps the two in agreement.

export function withPlatformAuth(
  action: string,
  riskClass: LimiterRiskClass,
  handler: PlatformAuthedHandler,
  // deno-lint-ignore no-explicit-any
  adminFactory?: () => any,
) {
  return async (
    req: Request,
    requestId: string,
    params: Record<string, string>,
    // deno-lint-ignore no-explicit-any
    doorFactory?: () => any,
  ): Promise<Response> => {
    const admin = (adminFactory ?? doorFactory)?.();
    if (!admin) return v1ErrorResponse("internal_error", requestId);

    // Read BOTH header forms. A workspace client presents `x-postora-key`, so
    // reading only Bearer would answer 401 for the very credential the
    // wrong-tier rule is about, and the 404 rule would never fire.
    const bearer = req.headers.get("authorization") ?? "";
    const presented = bearer.startsWith("Bearer ")
      ? bearer.slice(7)
      : (req.headers.get("x-postora-key") ?? "");

    // Wrong tier: answer as if the route does not exist (spec §5.3 rule 3), so
    // a workspace key never learns the platform tier is there.
    if (presented && !presented.startsWith(PLATFORM_PREFIX)) {
      console.warn(`[partner-api] wrong-tier credential at platform door (request ${requestId})`);
      return v1ErrorResponse("resource_not_found", requestId);
    }
    if (!presented) return v1ErrorResponse("invalid_key", requestId);

    let record: PlatformKeyRecord | null;
    try {
      record = await authenticatePlatformKey(admin, presented);
    } catch (err) {
      console.error(`[partner-api] platform auth failed (request ${requestId}):`, err);
      return v1ErrorResponse("internal_error", requestId);
    }
    if (!record) {
      console.warn(`[partner-api] platform key rejected (request ${requestId})`);
      return v1ErrorResponse("invalid_key", requestId);
    }

    const required = PLATFORM_ACTION_SCOPES[action];
    if (!required || !required.some((s) => record!.scopes.includes(s))) {
      console.warn(`[partner-api] platform scope refused: ${action} (request ${requestId})`);
      return v1ErrorResponse("insufficient_scope", requestId);
    }

    // The platform limiter, NOT consume_partner_rate_v2: that RPC's buckets
    // reference partner_api_keys, so a platform key id violates its FK.
    //
    // ONLY the persistence call differs. The decision, the outage policy and
    // the headers are the workspace door's, reused — a second copy of that
    // logic is a second rate-limit policy, and the two will drift.
    //
    // Extract the shared part of checkRateLimit in partnerApiMetering.ts into
    // a function taking the RPC name plus (keyId, perMinute, riskClass), and
    // call it from both doors. It must preserve, verbatim:
    //   - result validation (a malformed RPC row is an outage, not an allow),
    //   - the class-A outage rule (a bounded local read may continue when the
    //     limiter is unavailable; everything else is refused),
    //   - Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining and
    //     X-RateLimit-Reset,
    //   - header stamping on SUCCESSFUL responses, not only on refusals.
    //
    // `riskClass` is a real input to that policy. An implementation that
    // accepts it and never reads it has silently dropped the outage rule.
    const limit = await checkPlatformRateLimit(admin, record, riskClass, requestId);
    if (!limit.allowed) return limit.response;

    return await handler(req, { admin, record, requestId, rateHeaders: limit.headers }, params);
  };
}
```

Match `v1ErrorResponse`'s real options argument before using `{ headers }`; if
it does not accept headers, stamp them on the returned Response instead.

- [ ] **Step 6: Run the test to verify it passes**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/authenticated.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git commit -- supabase/functions/_shared/partnerPlatformKeys.ts \
               supabase/functions/partner-api/platform/policy.ts \
               supabase/functions/partner-api/platform/authenticated.ts \
               supabase/functions/partner-api/platform/authenticated.test.ts \
  -m "feat(partner-api): platform key authentication and its own limiter"
```

---

### Task 3: Mount the platform tier in the real dispatcher

Rewritten after debate round 1 (finding 4). **The previous draft mounted the
router in `partner-api/router.ts`, which holds policy maps and does not dispatch
requests.** Production dispatch runs `index.ts → v1/router.ts::handleV1Request`,
and that is where `resolveV1Route` executes. Mounting anywhere else leaves every
platform endpoint unreachable while the route table looks correct.

**Files:**
- Create: `supabase/functions/partner-api/platform/router.ts`
- Create: `supabase/functions/partner-api/platform/isolation.test.ts`
- Modify: `supabase/functions/partner-api/v1/router.ts` (inside `handleV1Request`)

**Interfaces:**
- Consumes: `withPlatformAuth` (Task 2), `PLATFORM_ACTION_SCOPES` and `PLATFORM_ACTION_RISK` (Task 2's `policy.ts`), the handlers from Tasks 4 and 5.
- Produces: `PLATFORM_ROUTES: V1Route[]`, dispatched by `handleV1Request`.

**Ordering note.** This task's router imports handlers created in Tasks 4 and 5.
Implement Tasks 4 and 5 **before** running this task's full suite, or implement
all three in one slice. The previous draft's ordering could not compile.

- [ ] **Step 1: Write the failing isolation test**

Create `supabase/functions/partner-api/platform/isolation.test.ts`. It must
drive the **exported request handler**, not inspect the route tables, because
table inspection is exactly what let the previous draft believe an unmounted
router worked:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PLATFORM_ACTION_SCOPES } from "./policy.ts";
import { ACTION_SCOPES } from "../router.ts";
import { handleV1Request } from "../v1/router.ts";

Deno.test("no action is reachable through both doors", () => {
  for (const action of Object.keys(PLATFORM_ACTION_SCOPES)) {
    assertEquals(
      Object.prototype.hasOwnProperty.call(ACTION_SCOPES, action),
      false,
      `${action} must not also be a workspace action`,
    );
  }
});

Deno.test("a platform route reaches its handler, proven by handler invocation", async () => {
  // The weak version of this test asserted only that the error code was not
  // `unknown_action`. An UNMOUNTED router answers `resource_not_found`, which
  // passes that assertion — so the test would have gone green against exactly
  // the bug it exists to catch.
  //
  // Prove dispatch by observing the handler run. Register a probe route in the
  // platform table for the test, or export a seam the test can substitute; do
  // not settle for an error-code shape.
  let handlerRan = false;
  const res = await handleV1Request(
    new Request("https://x/v1/platform/workspaces", {
      method: "GET",
      headers: { authorization: "Bearer pl_live_testkeywithavalidhash" },
    }),
    "/v1/platform/workspaces",
    "req-1",
    () => stubAdminReaching(() => { handlerRan = true; }),
  );
  assertEquals(handlerRan, true, "the platform handler must actually execute");
  assertEquals(res.status, 200);
});

Deno.test("an authenticated platform route does not answer resource_not_found", async () => {
  // The specific false pass: an unmounted platform table makes every
  // /v1/platform/* path fall through to the unmatched-route answer.
  const res = await handleV1Request(
    new Request("https://x/v1/platform/workspaces", {
      method: "GET",
      headers: { authorization: "Bearer pl_live_testkeywithavalidhash" },
    }),
    "/v1/platform/workspaces",
    "req-2",
    () => stubAdmin(),
  );
  assertEquals(res.status !== 404, true, "an unmounted platform table would 404 here");
});

Deno.test("a workspace route still dispatches unchanged", async () => {
  const res = await handleV1Request(
    new Request("https://x/v1/usage", { method: "GET" }),
    "/v1/usage",
    "req-2",
    () => stubAdmin(),
  );
  assertEquals(res.status !== 404, true);
});

Deno.test("an unmatched path still 404s without touching Supabase", async () => {
  let touched = false;
  const res = await handleV1Request(
    new Request("https://x/v1/platform/nothing", { method: "GET" }),
    "/v1/platform/nothing",
    "req-3",
    () => { touched = true; return stubAdmin(); },
  );
  assertEquals(res.status, 404);
  assertEquals(touched, false, "routing must not construct a client for an unmatched path");
});
```

Read `handleV1Request`'s real signature before writing this and match it
exactly, including how it receives the admin factory. Supply `stubAdmin` in the
shape the other v1 tests use.

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/isolation.test.ts
```

Expected: FAIL — `./policy.ts` resolves but the platform path is unmatched.

- [ ] **Step 3: Implement the platform route table**

Create `supabase/functions/partner-api/platform/router.ts`:

```typescript
// The /v1/platform route table (spec §5.4).
//
// A separate table from V1_ROUTES, and a separate policy table. Two doors
// sharing one policy table would need every entry to declare its tier; two
// tables make the tier structural.

import { withPlatformAuth } from "./authenticated.ts";
import { PLATFORM_ACTION_RISK } from "./policy.ts";
import { createWorkspace, getWorkspace, listWorkspaces } from "./workspaces.ts";
import { issueWorkspaceKey, revokeWorkspaceKey } from "./keys.ts";
import type { V1Route } from "../v1/router.ts";

export const PLATFORM_ROUTES: V1Route[] = [
  {
    pattern: "/v1/platform/workspaces/{id}/keys",
    methods: { POST: withPlatformAuth("issue_workspace_key", PLATFORM_ACTION_RISK.issue_workspace_key, issueWorkspaceKey) },
  },
  {
    pattern: "/v1/platform/workspaces",
    methods: {
      GET: withPlatformAuth("list_platform_workspaces", PLATFORM_ACTION_RISK.list_platform_workspaces, listWorkspaces),
      POST: withPlatformAuth("create_workspace", PLATFORM_ACTION_RISK.create_workspace, createWorkspace),
    },
  },
  {
    pattern: "/v1/platform/workspaces/{id}",
    methods: { GET: withPlatformAuth("get_platform_workspace", PLATFORM_ACTION_RISK.get_platform_workspace, getWorkspace) },
  },
  {
    pattern: "/v1/platform/keys/{id}",
    methods: { DELETE: withPlatformAuth("revoke_workspace_key", PLATFORM_ACTION_RISK.revoke_workspace_key, revokeWorkspaceKey) },
  },
];
```

- [ ] **Step 4: Mount it inside `handleV1Request`**

Open `supabase/functions/partner-api/v1/router.ts` and find `handleV1Request`,
where `resolveV1Route(V1_ROUTES, subPath, req.method)` runs. Resolve the
platform table first, and route it through the **same** exception mapping,
405 handling and `Allow` header construction the workspace table already gets.
Do not add a second dispatch path beside the existing one; extend the existing
resolution so both tables share it:

```typescript
// Platform routes resolve first. They are strictly namespaced under
// /v1/platform/, so this cannot shadow a workspace route. Sharing the
// resolution means they also share the 405/Allow and exception handling that
// v1/router.test.ts already pins.
const resolution = resolveV1Route(PLATFORM_ROUTES, subPath, req.method).kind === "not_found"
  ? resolveV1Route(V1_ROUTES, subPath, req.method)
  : resolveV1Route(PLATFORM_ROUTES, subPath, req.method);
```

Compute the platform resolution once into a local rather than calling it twice;
the two-call form above is written for clarity, not for copying.

- [ ] **Step 5: Run the isolation test and the whole partner-api suite**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/partner-api/
```

Expected: PASS, including the existing `router.test.ts` non-enumerability
assertions, which must not regress.

- [ ] **Step 6: Commit**

```bash
git commit -- supabase/functions/partner-api/platform/router.ts \
               supabase/functions/partner-api/platform/isolation.test.ts \
               supabase/functions/partner-api/v1/router.ts \
  -m "feat(partner-api): dispatch the platform tier from handleV1Request"
```

---

### Task 4: Provision a tenant

Rewritten after debate round 1 (findings 1, 2, 16, 17, 18). The handler is now
thin: one Auth call, one RPC, and a compensation path.

**Files:**
- Create: `supabase/functions/partner-api/platform/workspaces.ts`
- Test: `supabase/functions/partner-api/platform/workspaces.test.ts`

**Interfaces:**
- Consumes: `PlatformAuthedContext` (Task 2); `provision_partner_tenant` (Task 1); `generatePartnerKey` from `_shared/partnerApiKeys.ts` (it returns `{ key, prefix, hash }`).
- Produces:
  - `createWorkspace(req, authed, params)` — 201 `{ workspace_id, account_id, key_id, key, request_id }`. `key` is returned once and never again.
  - `listWorkspaces(req, authed, params)` — `{ data, next_cursor, request_id }`
  - `getWorkspace(req, authed, params)` — one workspace, or `resource_not_found`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/partner-api/platform/workspaces.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createWorkspace, getWorkspace } from "./workspaces.ts";

const AUTHED = {
  record: {
    id: "pk-1",
    principalId: "pr-1",
    keyPrefix: "pl_live",
    scopes: ["platform:workspaces.manage"],
    rateLimitPerMin: 30,
    expiresAt: null,
    revokedAt: null,
  },
  requestId: "req-1",
  rateHeaders: {},
};

interface Opts {
  ownerError?: unknown;
  rpcError?: unknown;
  linkRow?: unknown;
  linkError?: unknown;
}

function adminStub(opts: Opts = {}) {
  const deleted: string[] = [];
  return {
    deleted,
    auth: {
      admin: {
        createUser() {
          return Promise.resolve({
            data: opts.ownerError ? null : { user: { id: "svc-user-1" } },
            error: opts.ownerError ?? null,
          });
        },
        deleteUser(id: string) { deleted.push(id); return Promise.resolve({ error: null }); },
      },
    },
    rpc(name: string) {
      if (name === "provision_partner_tenant") {
        return Promise.resolve({
          data: opts.rpcError ? null : { workspace_id: "ws-9", account_id: "acct-9", key_id: "wk-9" },
          error: opts.rpcError ?? null,
        });
      }
      return Promise.resolve({ error: null });
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: "linkRow" in opts ? opts.linkRow : { workspace_id: "ws-9" },
            error: opts.linkError ?? null,
          });
        },
      };
    },
  };
}

function createReq(body: unknown) {
  return new Request("https://x/v1/platform/workspaces", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("provisioning returns the workspace, the account and the key once", async () => {
  const res = await createWorkspace(
    createReq({ name: "Tenant A", external_ref: "wasl-7", connection_name: "Support" }),
    { ...AUTHED, admin: adminStub() },
    {},
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.workspace_id, "ws-9");
  assertEquals(body.account_id, "acct-9");
  assertEquals(typeof body.key, "string");
  assertEquals(body.key.length > 20, true);
});

Deno.test("a failed provisioning DELETES the orphaned owner identity", async () => {
  // The one step that cannot be transactional. Without this compensation, a
  // retry of the same external_ref leaves a growing pile of auth users that
  // own nothing and can never be pruned safely.
  const admin = adminStub({ rpcError: { message: "unique violation" } });
  const res = await createWorkspace(
    createReq({ name: "Tenant A", external_ref: "wasl-7", connection_name: "Support" }),
    { ...AUTHED, admin },
    {},
  );
  assertEquals(res.status >= 400, true);
  assertEquals(admin.deleted, ["svc-user-1"], "the orphaned owner must be removed");
});

Deno.test("a missing connection_name is rejected, never substituted", async () => {
  const res = await createWorkspace(
    createReq({ name: "Tenant A", external_ref: "wasl-7" }),
    { ...AUTHED, admin: adminStub() },
    {},
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_request");
});

Deno.test("get answers resource_not_found outside this principal's estate", async () => {
  const res = await getWorkspace(
    new Request("https://x/v1/platform/workspaces/ws-other"),
    { ...AUTHED, admin: adminStub({ linkRow: null }) },
    { id: "ws-other" },
  );
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "resource_not_found");
});

Deno.test("get surfaces a failed read as an error, never as not-found", async () => {
  const res = await getWorkspace(
    new Request("https://x/v1/platform/workspaces/ws-9"),
    { ...AUTHED, admin: adminStub({ linkError: { message: "statement timeout" } }) },
    { id: "ws-9" },
  );
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error.code, "internal_error");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/workspaces.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `createWorkspace`**

Create `supabase/functions/partner-api/platform/workspaces.ts`:

```typescript
// POST /v1/platform/workspaces (spec §5.2 to §5.4).
//
// One Auth call, one RPC, one compensation. Everything the database can do
// atomically it does; the auth user is the only resource outside that
// transaction, so it is created first and deleted on failure.

import { v1ErrorResponse } from "../v1/errors.ts";
import { v1JsonResponse } from "../v1/respond.ts";
import { doorEnvironment, generatePartnerKey } from "../../_shared/partnerApiKeys.ts";
import type { PlatformAuthedContext } from "./authenticated.ts";

/** Scopes a provisioned tenant key receives. Deliberately explicit rather than
 *  caller-supplied on this route: the bootstrap key must be able to pair the
 *  number it was issued against, and nothing more. A partner widens it later
 *  through issue_workspace_key. */
const BOOTSTRAP_SCOPES = [
  "whatsapp:numbers.read",
  "whatsapp:numbers.manage",
  "conversations:read",
  "messages:read",
  "messages:send",
];

export async function createWorkspace(
  req: Request,
  authed: PlatformAuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  let body: { name?: unknown; external_ref?: unknown; connection_name?: unknown };
  try {
    body = await req.json();
  } catch {
    return v1ErrorResponse("invalid_request", requestId, { message: "body must be JSON" });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const connectionName = typeof body.connection_name === "string" ? body.connection_name.trim() : "";
  if (!name || !connectionName) {
    console.warn(`[partner-api] provisioning refused: missing name or connection_name (request ${requestId})`);
    return v1ErrorResponse("invalid_request", requestId, {
      message: "name and connection_name are required",
    });
  }
  const externalRef = typeof body.external_ref === "string" ? body.external_ref : null;

  // The service identity. Created OUTSIDE the transaction because auth.users is
  // written through the Auth admin API, not SQL.
  const ownerEmail = `svc+${crypto.randomUUID()}@partner.postora.cloud`;
  const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
    email: ownerEmail,
    email_confirm: false,
    // Interactive authentication is disabled for this identity. The metadata
    // marker is documentation; the guard is that no password is ever set and
    // recovery is blocked by the auth hook added in this task's step 5.
    user_metadata: { partner_service_account: true, principal_id: record.principalId },
  });

  if (ownerError || !owner?.user) {
    console.error(`[partner-api] owner identity creation failed (request ${requestId}):`, ownerError);
    return v1ErrorResponse("internal_error", requestId);
  }

  // generatePartnerKey already returns the hash; do not re-hash.
  const secret = await generatePartnerKey(doorEnvironment());

  const { data, error } = await admin.rpc("provision_partner_tenant", {
    p_principal_id: record.principalId,
    p_owner_user_id: owner.user.id,
    p_workspace_name: name,
    p_external_ref: externalRef,
    p_connection_name: connectionName,
    p_key_name: `${name} bootstrap`,
    p_key_prefix: secret.prefix,
    p_key_hash: secret.hash,
    p_scopes: BOOTSTRAP_SCOPES,
  });

  if (error || !data) {
    // NOT every error means rollback. A lost response can follow a COMMITTED
    // transaction, in which case deleting the owner would either fail against
    // the provisioning row's ON DELETE RESTRICT, or — worse, if it succeeded —
    // destroy a live tenant.
    //
    // So: read back before compensating, and only delete an owner that owns
    // nothing.
    const { data: existing, error: readbackError } = await admin
      .from("partner_provisioned_workspaces")
      .select("workspace_id")
      .eq("owner_user_id", owner.user.id)
      .maybeSingle();

    if (readbackError) {
      // Unknown outcome. Leave everything alone and say so: deleting on a
      // failed read is how a committed tenant gets destroyed.
      console.error(`[partner-api] provisioning outcome UNKNOWN, owner ${owner.user.id} left in place (request ${requestId}):`, error, readbackError);
      return v1ErrorResponse("internal_error", requestId);
    }

    if (existing) {
      // It actually committed; the response was lost. Report the created
      // tenant rather than treating a delivery failure as a provisioning
      // failure. The bootstrap key is NOT recoverable here — it was returned
      // once and is gone — so the partner must issue a new one.
      console.warn(`[partner-api] provisioning committed but response was lost (request ${requestId})`);
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    }

    console.error(`[partner-api] provisioning rolled back, compensating (request ${requestId}):`, error);
    const { error: cleanupError } = await admin.auth.admin.deleteUser(owner.user.id);
    if (cleanupError) {
      // Visibility, not recovery. See the durable-reservation note below.
      console.error(`[partner-api] COMPENSATION FAILED, orphaned auth user ${owner.user.id} (request ${requestId}):`, cleanupError);
    }
    return v1ErrorResponse("internal_error", requestId);
  }

  return v1JsonResponse({
    workspace_id: data.workspace_id,
    account_id: data.account_id,
    key_id: data.key_id,
    key: secret.key,
    external_ref: externalRef,
    request_id: requestId,
  }, requestId, 201);
}
```

`generatePartnerKey(environment)` returns `{ key, prefix, hash }` — verified
2026-09-10 — so do not re-hash. Its environments are `production` and
`staging`, mapping to `pk_live_` and `pk_test_`, and it must be called with
`doorEnvironment()` so a staging deployment does not mint production keys.

**Two gaps this handler still has, which must be closed in this task.**

**A durable reservation.** The read-back above narrows the window but does not
remove it: a crash between the Auth create and the RPC leaves an orphan with
nothing recording that an attempt was in flight. Write a
`partner_provisioning_attempts` row — request id, principal, external ref,
owner user id, state — *before* creating the Auth user, and settle it after.
Then a reconciliation job can find and clean up orphans, and a retry of the
same `external_ref` can recognise its own prior attempt instead of creating a
second identity. Logging `COMPENSATION FAILED` is visibility; the attempts
table is recovery.

**`external_ref` retry semantics.** `UNIQUE (principal_id, external_ref)`
currently makes a retry fail at the very end, after another owner and workspace
were created. Check the attempts table first and return the existing tenant, so
a partner retrying a timed-out provisioning call gets its workspace rather than
a uniqueness violation and a pile of orphans.

- [ ] **Step 4: Implement `listWorkspaces` and `getWorkspace`**

`listWorkspaces` and `getWorkspace` scope by `principal_id`, not by key id, so
rotating a platform key does not strand the estate. Pagination uses the real API:

```typescript
import { encodeCursor, readPageRequest } from "../v1/pagination.ts";

const page = readPageRequest(req, requestId);
if (!page.ok) return page.res;
// page.page.limit and page.page.cursor
```

`readPageRequest(req, requestId)` returns `{ ok: true, page: { limit, cursor } }`
or `{ ok: false, res }`, and `CursorPosition` is `{ timestamp, id }`. Order and
filter by `(created_at, workspace_id)` together — a timestamp-only predicate
drops every row sharing a boundary timestamp, which a bulk provisioning run
produces immediately.

**There is no platform-tier route for additional numbers.** An earlier draft had
one, contradicting Task 8, which registers numbers with a workspace key. The
bootstrap cycle blocks only the *first* account, because only then does no key
exist; once a workspace key exists it can create further accounts and their own
bindings. Additional numbers therefore go through `POST /v1/whatsapp/numbers`
(Task 8), and this task implements only `listWorkspaces` and `getWorkspace`
beyond `createWorkspace`.

- [ ] **Step 5: Block interactive authentication for service identities**

The metadata marker alone is not a guard. Add the block where this codebase
already gates sign-in, and add a test that a service identity cannot complete a
password-recovery or magic-link flow.

If no such hook exists, say so explicitly in the task's report rather than
leaving the claim unenforced, and record it as a follow-up. Do not describe the
identity as non-login until something enforces it.

- [ ] **Step 6: Run the tests**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/workspaces.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Update the contract, check drift, regenerate clients**

Add the three platform workspace routes to `docs/api/openapi.yaml`, then:

```bash
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
```

**Teach `generate-postman.ts` the per-tier header in this task.** It hardcodes
`x-postora-key` for every operation; platform routes authenticate with `Bearer`.
Without this the generated collection ships platform requests that cannot
authenticate while its own regeneration test passes.

- [ ] **Step 8: Commit**

```bash
git commit -- supabase/functions/partner-api/platform/workspaces.ts \
               supabase/functions/partner-api/platform/workspaces.test.ts \
               scripts/generate-postman.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): provision a tenant atomically through the platform tier"
```

---

### Task 5: Issue and revoke workspace-scoped keys

Rewritten after debate round 1 (findings 1, 15).

**Files:**
- Create: `supabase/functions/partner-api/platform/keys.ts`
- Test: `supabase/functions/partner-api/platform/keys.test.ts`
- Modify: `supabase/migrations/20260910100000_partner_platform_tier.sql` (add the revocation RPC)

**Interfaces:**
- Consumes: `PlatformAuthedContext` (Task 2); `generatePartnerKey` (returns `{ key, prefix, hash }`).
- Produces:
  - `issueWorkspaceKey(req, authed, params)` — 201 `{ id, key, key_prefix, scopes, workspace_id, request_id }`
  - `revokeWorkspaceKey(req, authed, params)` — 204
  - RPC `revoke_partner_key_in_estate(p_principal_id, p_key_id, p_reason)`

**Why an RPC for revocation.** `partner_api_keys` and
`partner_provisioned_workspaces` each reference `workspaces`; neither references
the other. PostgREST's embedded-resource syntax
(`partner_provisioned_workspaces!inner(...)`) therefore has no declared
relationship to follow and fails at runtime. The estate check needs a real SQL
join, and a join plus a conditional update is one statement in a function.

- [ ] **Step 1: Add the revocation RPC to Task 1's migration**

```sql
-- Revoke a workspace key, but only inside the calling principal's estate.
-- The join is why this is a function: partner_api_keys and
-- partner_provisioned_workspaces are related only THROUGH workspaces, so no
-- PostgREST embed can express it.
CREATE OR REPLACE FUNCTION public.revoke_partner_key_in_estate(
  p_principal_id UUID,
  p_key_id       UUID,
  p_reason       TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.partner_api_keys AS k
  SET revoked_at = now(), revoked_reason = p_reason
  FROM public.partner_provisioned_workspaces AS p
  WHERE k.id = p_key_id
    AND k.workspace_id = p.workspace_id
    AND p.principal_id = p_principal_id
    AND k.revoked_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_partner_key_in_estate(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_partner_key_in_estate(UUID, UUID, TEXT) TO service_role;
```

An already-revoked key returns false, so a repeated revoke answers
`resource_not_found` rather than reporting a second successful revocation.

- [ ] **Step 2: Write the failing test**

Create `supabase/functions/partner-api/platform/keys.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { issueWorkspaceKey, revokeWorkspaceKey } from "./keys.ts";

const AUTHED = {
  record: {
    id: "pk-1",
    principalId: "pr-1",
    keyPrefix: "pl_live",
    scopes: ["platform:keys.manage"],
    rateLimitPerMin: 30,
    expiresAt: null,
    revokedAt: null,
  },
  requestId: "req-1",
  rateHeaders: {},
};

function adminStub(opts: { inEstate?: boolean; revoked?: boolean; accountRow?: unknown } = {}) {
  return {
    rpc(name: string) {
      if (name === "revoke_partner_key_in_estate") {
        return Promise.resolve({ data: opts.revoked ?? true, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      if (table === "partner_provisioned_workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({
              data: (opts.inEstate ?? true) ? { workspace_id: "ws-9" } : null,
              error: null,
            });
          },
        };
      }
      if (table === "partner_api_key_accounts" || table === "partner_api_keys") {
        return {
          insert() { return this; },
          select() { return this; },
          eq() { return this; },
          single() { return Promise.resolve({ data: { id: "wk-1" }, error: null }); },
          maybeSingle() { return Promise.resolve({ data: opts.accountRow ?? { id: "acct-9" }, error: null }); },
        };
      }
      if (table === "social_accounts") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: opts.accountRow ?? { id: "acct-9" }, error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function issueReq(body: unknown) {
  return new Request("https://x/v1/platform/workspaces/ws-9/keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

Deno.test("issuing a key returns the secret exactly once", async () => {
  const res = await issueWorkspaceKey(
    issueReq({ name: "wasl tenant 7", scopes: ["conversations:read"], account_id: "acct-9" }),
    { ...AUTHED, admin: adminStub() },
    { id: "ws-9" },
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(typeof body.key, "string");
  assertEquals(body.workspace_id, "ws-9");
});

Deno.test("a platform scope may never be granted to a workspace key", async () => {
  const res = await issueWorkspaceKey(
    issueReq({ name: "n", scopes: ["platform:keys.manage"], account_id: "acct-9" }),
    { ...AUTHED, admin: adminStub() },
    { id: "ws-9" },
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_request");
});

Deno.test("issuing into a workspace outside the estate is not found", async () => {
  const res = await issueWorkspaceKey(
    issueReq({ name: "n", scopes: ["conversations:read"], account_id: "acct-9" }),
    { ...AUTHED, admin: adminStub({ inEstate: false }) },
    { id: "ws-other" },
  );
  assertEquals(res.status, 404);
});

Deno.test("issuing without an account_id is rejected — the column is NOT NULL", async () => {
  const res = await issueWorkspaceKey(
    issueReq({ name: "n", scopes: ["conversations:read"] }),
    { ...AUTHED, admin: adminStub() },
    { id: "ws-9" },
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_request");
});

Deno.test("revoking a key outside the estate is not found", async () => {
  const res = await revokeWorkspaceKey(
    new Request("https://x/v1/platform/keys/wk-other", { method: "DELETE" }),
    { ...AUTHED, admin: adminStub({ revoked: false }) },
    { id: "wk-other" },
  );
  assertEquals(res.status, 404);
});

Deno.test("revoking an already-revoked key is not found, not a second success", async () => {
  const res = await revokeWorkspaceKey(
    new Request("https://x/v1/platform/keys/wk-1", { method: "DELETE" }),
    { ...AUTHED, admin: adminStub({ revoked: false }) },
    { id: "wk-1" },
  );
  assertEquals(res.status, 404);
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/platform/keys.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement the handlers**

Create `supabase/functions/partner-api/platform/keys.ts`. The issuance path
requires an `account_id` because `partner_api_keys.social_account_id` is NOT
NULL, and it must insert the `partner_api_key_accounts` binding or the new key
cannot see its own account:

```typescript
import { v1ErrorResponse } from "../v1/errors.ts";
import { v1JsonResponse } from "../v1/respond.ts";
import { GENERIC_SCOPES } from "../../_shared/partnerScopes.ts";
import { doorEnvironment, generatePartnerKey } from "../../_shared/partnerApiKeys.ts";
import type { PlatformAuthedContext } from "./authenticated.ts";

export async function issueWorkspaceKey(
  req: Request,
  authed: PlatformAuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  let body: { name?: unknown; scopes?: unknown; account_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return v1ErrorResponse("invalid_request", requestId, { message: "body must be JSON" });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  if (!name) return v1ErrorResponse("invalid_request", requestId, { message: "name is required" });
  if (!accountId) {
    // partner_api_keys.social_account_id is NOT NULL. Defaulting to "some
    // account in the workspace" would silently pin the key to whichever row
    // sorted first, which is not a decision this API may make for a partner.
    return v1ErrorResponse("invalid_request", requestId, {
      message: "account_id is required; a key is pinned to one account",
    });
  }

  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (scopes.length === 0) {
    return v1ErrorResponse("invalid_request", requestId, { message: "scopes must be a non-empty array" });
  }
  for (const scope of scopes) {
    if (scope.startsWith("platform:")) {
      console.warn(`[partner-api] refused platform scope on a workspace key (request ${requestId})`);
      return v1ErrorResponse("invalid_request", requestId, {
        message: "a workspace key may not hold a platform scope",
      });
    }
    if (!(GENERIC_SCOPES as readonly string[]).includes(scope)) {
      return v1ErrorResponse("invalid_request", requestId, { message: `unknown scope: ${scope}` });
    }
  }

  const { data: link, error: linkError } = await admin
    .from("partner_provisioned_workspaces")
    .select("workspace_id")
    .eq("principal_id", record.principalId)
    .eq("workspace_id", params.id)
    .maybeSingle();

  if (linkError) {
    console.error(`[partner-api] estate check failed (request ${requestId}):`, linkError);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!link) {
    console.warn(`[partner-api] key issue refused: workspace outside estate (request ${requestId})`);
    return v1ErrorResponse("resource_not_found", requestId);
  }

  // Confirm the account is in THAT workspace before pinning to it. The
  // composite FK would reject a mismatch, but a clear 404 beats a constraint
  // error surfacing as internal_error.
  const { data: account, error: accountError } = await admin
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", params.id)
    .eq("id", accountId)
    .maybeSingle();

  if (accountError) return v1ErrorResponse("internal_error", requestId);
  if (!account) return v1ErrorResponse("resource_not_found", requestId);

  // generatePartnerKey already returns the hash; do not re-hash.
  const secret = await generatePartnerKey(doorEnvironment());

  const { data: created, error: insertError } = await admin
    .from("partner_api_keys")
    .insert({
      workspace_id: params.id,
      social_account_id: accountId,
      name,
      key_prefix: secret.prefix,
      key_hash: secret.hash,
      scopes,
    })
    .select("id")
    .single();

  if (insertError || !created) {
    console.error(`[partner-api] key insert failed (request ${requestId}):`, insertError);
    return v1ErrorResponse("internal_error", requestId);
  }

  // Finding 2 again: without the binding the key cannot see its own account.
  const { error: bindingError } = await admin
    .from("partner_api_key_accounts")
    .insert({ key_id: created.id, workspace_id: params.id, social_account_id: accountId });

  if (bindingError) {
    console.error(`[partner-api] binding insert failed (request ${requestId}):`, bindingError);
    return v1ErrorResponse("internal_error", requestId);
  }

  return v1JsonResponse({
    id: created.id,
    key: secret.key,
    key_prefix: secret.prefix,
    scopes,
    workspace_id: params.id,
    account_id: accountId,
    request_id: requestId,
  }, requestId, 201);
}

export async function revokeWorkspaceKey(
  _req: Request,
  authed: PlatformAuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const { data: revoked, error } = await admin.rpc("revoke_partner_key_in_estate", {
    p_principal_id: record.principalId,
    p_key_id: params.id,
    p_reason: "revoked via platform API",
  });

  if (error) {
    console.error(`[partner-api] key revoke failed (request ${requestId}):`, error);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (revoked !== true) {
    console.warn(`[partner-api] key revoke refused: outside estate or already revoked (request ${requestId})`);
    return v1ErrorResponse("resource_not_found", requestId);
  }

  return new Response(null, { status: 204, headers: authed.rateHeaders });
}
```

**The two inserts above are not atomic, and the obvious compensation is
impossible.** `service_role` holds only SELECT and INSERT on
`partner_api_keys` (`20260830120300_partner_api_least_privilege_grants.sql`),
so a handler cannot delete the key it just created when the binding insert
fails. Offering that fallback would leave a usable key bound to nothing.

**So an atomic `issue_partner_key_in_estate` RPC is mandatory, not preferred.**
Write it alongside `revoke_partner_key_in_estate` in Task 1's migration: it
performs the estate check, the account-in-workspace check, the key insert and
the binding insert in one transaction, and revokes execute from `PUBLIC`, `anon`
and `authenticated`. The handler above then reduces to validation plus one RPC
call, exactly as `createWorkspace` does.

**Every credential mutation must write an audit row.** The existing
`20260831170000_partner_api_credential_lifecycle.sql` functions deliberately
commit the mutation, the binding and the `partner_audit_logs` entry together.
Provisioning, issuance and estate revocation are new entry points that create
and revoke credentials, so each must do the same, recording the principal, the
platform key that acted, the request id and the child key. Adding an unaudited
credential path is a regression in exactly the property that migration exists to
guarantee.

- [ ] **Step 5: Run the tests and the whole partner-api suite**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/partner-api/
```

Expected: PASS, including Task 3's isolation tests, which can now import every
handler.

- [ ] **Step 6: Update the contract, check drift, regenerate clients, commit**

```bash
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
git commit -- supabase/functions/partner-api/platform/keys.ts \
               supabase/functions/partner-api/platform/keys.test.ts \
               supabase/migrations/20260910100000_partner_platform_tier.sql \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): issue and revoke workspace keys within a principal's estate"
```


### Task 6: Server-side feature entitlement

**Files:**
- Create: `supabase/functions/_shared/partnerEntitlement.ts`
- Modify: `supabase/functions/partner-api/v1/errors.ts`
- Test: `supabase/functions/_shared/partnerEntitlement.test.ts`

**Interfaces:**
- Consumes: the workspace's plan, read the way `check-subscription` already reads it.
- Produces:
  - `type PartnerFeature = "messaging" | "comments" | "automation" | "human_agent" | "whatsapp"`
  - `assertEntitled(admin: any, workspaceId: string, feature: PartnerFeature, requestId: string): Promise<Response | null>` — returns a `feature_not_entitled` response, or `null` when entitled.
  - Error code `feature_not_entitled`, status 403, `retryable: false`.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/partnerEntitlement.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assertEntitled } from "./partnerEntitlement.ts";

interface StubOpts {
  ownerRow?: unknown;
  ownerError?: unknown;
  globalValue?: unknown;
  globalError?: unknown;
  overrides?: Array<{ feature_key: string; enabled: boolean; expires_at: string | null }>;
  overrideError?: unknown;
}

function adminStub(opts: StubOpts = {}) {
  return {
    from(table: string) {
      if (table === "partner_provisioned_workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({
              data: "ownerRow" in opts ? opts.ownerRow : { owner_user_id: "svc-user-1" },
              error: opts.ownerError ?? null,
            });
          },
        };
      }
      if (table === "app_settings") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({
              data: "globalValue" in opts ? { key: "k", value: opts.globalValue } : null,
              error: opts.globalError ?? null,
            });
          },
        };
      }
      if (table === "user_feature_overrides") {
        const rows = opts.overrides ?? [];
        const result = Promise.resolve({ data: rows, error: opts.overrideError ?? null });
        return {
          select() { return this; },
          eq() { return this === undefined ? result : chainable(result); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

/** user_feature_overrides is read with two chained .eq() calls and awaited
 *  directly, with no .maybeSingle(). The stub must therefore be thenable. */
// deno-lint-ignore no-explicit-any
function chainable(result: Promise<any>): any {
  return { eq: () => result, then: result.then.bind(result) };
}

Deno.test("a globally enabled feature passes through", async () => {
  const res = await assertEntitled(adminStub({ globalValue: true }), "ws-1", "messaging", "req-1");
  assertEquals(res, null);
});

Deno.test("a JSON-encoded boolean string is honoured", async () => {
  // app_settings stores true, "true", and "\"true\"" interchangeably.
  const res = await assertEntitled(adminStub({ globalValue: '"true"' }), "ws-1", "messaging", "req-1");
  assertEquals(res, null);
});

Deno.test("a globally disabled feature is refused with feature_not_entitled", async () => {
  const res = await assertEntitled(adminStub({ globalValue: false }), "ws-1", "automation", "req-1");
  assertEquals(res === null, false);
  assertEquals(res!.status, 403);
  assertEquals((await res!.json()).error.code, "feature_not_entitled");
});

Deno.test("an unexpired user override beats the global value", async () => {
  const res = await assertEntitled(
    adminStub({
      globalValue: false,
      overrides: [{ feature_key: "k", enabled: true, expires_at: null }],
    }),
    "ws-1",
    "messaging",
    "req-1",
  );
  assertEquals(res, null);
});

Deno.test("an EXPIRED override does not grant", async () => {
  const res = await assertEntitled(
    adminStub({
      globalValue: false,
      overrides: [{ feature_key: "k", enabled: true, expires_at: "2020-01-01T00:00:00Z" }],
    }),
    "ws-1",
    "messaging",
    "req-1",
  );
  assertEquals(res === null, false);
  assertEquals((await res!.json()).error.code, "feature_not_entitled");
});

Deno.test("a failed global read refuses rather than granting", async () => {
  const res = await assertEntitled(
    adminStub({ globalError: { message: "statement timeout" } }),
    "ws-1",
    "messaging",
    "req-1",
  );
  assertEquals(res === null, false);
  assertEquals(res!.status, 500);
  assertEquals((await res!.json()).error.code, "internal_error");
});

Deno.test("a workspace with no provisioned owner is refused, never defaulted to entitled", async () => {
  const res = await assertEntitled(adminStub({ ownerRow: null }), "ws-1", "messaging", "req-1");
  assertEquals(res === null, false);
  assertEquals(res!.status, 403);
  assertEquals((await res!.json()).error.code, "feature_not_entitled");
});

Deno.test("an absent app_settings row is refused, not treated as enabled", async () => {
  // The most dangerous case: a mistyped setting key reads as absent. That must
  // disable the feature loudly, never silently grant it.
  const res = await assertEntitled(adminStub({}), "ws-1", "messaging", "req-1");
  assertEquals(res === null, false);
  assertEquals((await res!.json()).error.code, "feature_not_entitled");
});
```

The last three tests encode the fail-closed rule. An entitlement check that
grants on a failed read, an absent row, or an expired override is worse than no
check, because it looks present in review while enforcing nothing.

- [ ] **Step 2: Run the test to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/partnerEntitlement.test.ts
```

Expected: FAIL — module `./partnerEntitlement.ts` not found.

- [ ] **Step 3: Add the error code**

In `supabase/functions/partner-api/v1/errors.ts`, insert alphabetically between `connector_write_not_allowed` and `idempotency_conflict`:

```typescript
  // The workspace's plan does not include this feature. DISTINCT from
  // insufficient_scope, which is about the key. Both are 403: errors.ts's rule
  // is that the typed code, not the status family, is the partner's
  // discriminator. A 402 would be the only 402 in the vocabulary and would
  // imply a payment flow the Partner API does not operate.
  feature_not_entitled: {
    status: 403, retryable: false,
    message: "This workspace's plan does not include that feature",
  },
```

- [ ] **Step 4: Implement the entitlement check**

Create `supabase/functions/_shared/partnerEntitlement.ts`:

```typescript
// Server-side feature entitlement (spec §10).
//
// The four sections are gated in the browser by useFeatureFlags. A partner key
// never touches the browser, so the same entitlement must be enforced here or
// a flagged-off feature is reachable by API.
//
// FAIL CLOSED. A failed read and an absent plan both refuse. An entitlement
// check that grants on error is worse than none, because it looks present in
// review while enforcing nothing.

import { v1ErrorResponse } from "../partner-api/v1/errors.ts";

// NOT a section boolean. FLAG_KEYS has no generic "messaging" or "automation"
// flag — it is channel- and mode-specific, and WhatsApp alone has separate
// visibility, messaging, Cloud API and Direct QR controls. A single `whatsapp`
// boolean would let a partner drive a connection mode an operator disabled.
//
// So an action declares the exact app_settings keys it requires, and the check
// is a CONJUNCTION: every listed key must be enabled.
//
// This table lives beside ACTION_SCOPES so the predicate for an action is
// reviewable in one place and cannot be chosen differently by two implementers.
// Fill each entry from FLAG_KEYS in src/hooks/useFeatureFlags.tsx — the keys
// are that file's, not this plan's.
export const ACTION_FEATURE_KEYS: Record<string, readonly string[]> = {
  // Example shape, with real keys substituted:
  //   list_whatsapp_numbers:      ["<whatsapp section key>"],
  //   create_whatsapp_pairing:    ["<whatsapp section key>", "<direct QR key>"],
  //   register_whatsapp_number:   ["<whatsapp section key>", "<direct QR key>"],
  //   send_text:                  ["<whatsapp section key>", "<whatsapp messaging key>"],
};

export async function assertEntitled(
  // deno-lint-ignore no-explicit-any
  admin: any,
  workspaceId: string,
  action: string,
  requestId: string,
): Promise<Response | null> {
  const requiredKeys = ACTION_FEATURE_KEYS[action] ?? [];
  // An action with no declared keys is a policy gap, not an open door. Refuse
  // rather than allowing an unlisted action through unchecked.
  if (requiredKeys.length === 0) {
    console.error(`[partner-api] no feature policy for action ${action} (request ${requestId})`);
    return v1ErrorResponse("internal_error", requestId);
  }
  // The subject is the workspace's provisioned OWNER user (spec §5.4). There
  // is no workspace-level entitlement table; useFeatureFlags composes a global
  // app_settings value with a per-user override, and both are user-scoped.
  const { data: provisioning, error: provisioningError } = await admin
    .from("partner_provisioned_workspaces")
    .select("owner_user_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (provisioningError) {
    console.error(`[partner-api] entitlement owner lookup failed (request ${requestId}):`, provisioningError);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!provisioning) {
    console.warn(`[partner-api] refused: workspace ${workspaceId} has no provisioned owner (request ${requestId})`);
    return v1ErrorResponse("feature_not_entitled", requestId);
  }

  const { data: globalRows, error: globalError } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", requiredKeys);

  // FAIL CLOSED, unlike the browser. useFeatureFlags preserves its last cache
  // on a failed read so a transient error never collapses a live UI. A server
  // has no such cache, and granting on error is worse than not checking.
  if (globalError) {
    console.error(`[partner-api] entitlement global read failed (request ${requestId}):`, globalError);
    return v1ErrorResponse("internal_error", requestId);
  }

  // Start from the global value of every required key. A key with no row is
  // absent, which is false — a mistyped key must disable the action loudly,
  // never grant it.
  const state = new Map<string, boolean>(requiredKeys.map((k) => [k, false]));
  for (const row of globalRows ?? []) {
    state.set(row.key, coerceFlag(row.value));
  }

  const { data: overrides, error: overrideError } = await admin
    .from("user_feature_overrides")
    .select("feature_key, enabled, expires_at")
    .eq("user_id", provisioning.owner_user_id)
    .in("feature_key", requiredKeys);

  if (overrideError) {
    console.error(`[partner-api] entitlement override read failed (request ${requestId}):`, overrideError);
    return v1ErrorResponse("internal_error", requestId);
  }

  const now = new Date();
  for (const override of overrides ?? []) {
    if (override.expires_at && new Date(override.expires_at) < now) continue;
    if (state.has(override.feature_key)) state.set(override.feature_key, override.enabled === true);
  }

  // The admin override in useFeatureFlags, which grants an admin every flag, is
  // deliberately NOT reproduced. A partner key is not a person and must not
  // inherit an operator's elevation.

  const missing = requiredKeys.filter((k) => state.get(k) !== true);
  if (missing.length > 0) {
    console.warn(
      `[partner-api] refused: workspace ${workspaceId} not entitled to ${action}; ` +
        `missing ${missing.join(", ")} (request ${requestId})`,
    );
    return v1ErrorResponse("feature_not_entitled", requestId);
  }

  return null;
}

/** app_settings stores a flag as true, "true", or "\"true\"".
 *
 *  ONE parse, matching useFeatureFlags exactly. Recursive decoding would grant
 *  a deeply encoded value ("\"\\\"true\\\"\"") that the browser rejects, so the
 *  two doors would disagree about the same stored row — and the API would be
 *  the more permissive of the two. */
function coerceFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== "string") return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return raw === "true";
  }
}
```

**Fill `ACTION_FEATURE_KEYS` from the live flag list before running the tests.**
Open `src/hooks/useFeatureFlags.tsx`, read `FLAG_KEYS` and `FLAG_KEY_MAP`, and
give every Phase 1 alias action its exact required keys. Do not invent key
names: a key absent from `app_settings` reads as false, which fails closed and
disables the endpoint in production while every stubbed unit test passes.

**This is the one place in the plan with unfilled values, and it is deliberate**
— the keys belong to that file, not to this document. Two rules while filling it:

- A route naming a connection mode requires that mode's key **as well as** the
  section key. `create_whatsapp_pairing` on Direct QR must not be reachable
  when an operator has disabled Direct QR but left WhatsApp on. That bypass is
  precisely why a single section boolean was rejected.
- Every Phase 1 action must appear. An action missing from the table refuses
  with `internal_error`, which is loud and safe but will stop the endpoint
  working.

Add a test asserting that every action in `V1_ROUTES` for Phase 1 has an entry,
so a route added later cannot silently arrive without a feature policy.

- [ ] **Step 5: Run the test to verify it passes**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/partnerEntitlement.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Wire the first consumer**

Global constraint 10 forbids a module with no production consumer. Task 8 is the
first endpoint that calls `assertEntitled`. If Task 8 is not being implemented in
the same slice, do not commit this task alone — fold it into Task 8's commit.

- [ ] **Step 7: Commit (with Task 8, or alone only if Task 8 follows immediately)**

```bash
git commit -- supabase/functions/_shared/partnerEntitlement.ts \
               supabase/functions/_shared/partnerEntitlement.test.ts \
               supabase/functions/partner-api/v1/errors.ts \
  -m "feat(partner-api): server-side feature entitlement"
```

---

## Debate round 1 — verdict table

Reviewer: Codex `gpt-6-astra`, high effort, dispatched read-only through the
relay's sandbox. The tree was unchanged against the dispatch baseline
`5b3a98e9`; the two files it reported touching were the untracked spec and plan,
already present before the run.

26 findings. I verified the structurally decisive ones against the code myself
rather than ruling from the report.

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | Provisioning cannot issue the first workspace key — `social_account_id` is NOT NULL and `create_partner_key` requires it, but the key is needed to create the first account | P1 | accept | Verified: the RPC exists in `20260831170000_partner_api_credential_lifecycle.sql`. A genuine circular dependency that would fail on the very first call. Requires an accountless credential design. |
| 2 | `registerNumber` never inserts `partner_api_key_accounts`, so a created number is invisible to its creating key | P1 | accept | `binding.ts` has no fallback by design. Registration would 201 and then vanish. |
| 3 | `enforceRateLimit` does not exist (`checkRateLimit(client, record, riskClass)` does), and `consume_partner_rate_v2` buckets FK to `partner_api_keys`, so a platform key id violates the constraint | P1 | accept | Verified at `partnerApiMetering.ts:175`. The second half is the deeper problem: renaming the call cannot fix a foreign key. |
| 4 | The platform router is mounted in `partner-api/router.ts`, which holds policy maps and does not dispatch; real dispatch is `index.ts → v1/router.ts::handleV1Request` | P1 | accept | Platform endpoints would be unreachable. Codex also confirmed my `withPartnerAuth` signature claim was correct. |
| 5 | Registration claims idempotency but never settles it — no `replay`, no `attemptToken`, no `completeIdempotency`/`markIndeterminate`; consent is outside the hash | P1 | accept | A success leaves a processing claim; after lease expiry a retry creates a second account. |
| 6 | Cloud API and coexistence registration produce unusable placeholders with no credential exchange or Meta onboarding | P1 | accept | Phase 1 narrows to Direct QR and explicitly rejects the other two modes with `unsupported_capability`, rather than pretending to support them. |
| 7 | "Copy the exact feature key" is impossible: `FLAG_KEYS` has no generic messaging or automation flag, only channel- and mode-specific ones | P1 | accept | My one-boolean-per-section model would let a `whatsapp` flag bypass a disabled connection mode. Needs an action/channel/mode policy. |
| 8 | The human-agent migration rests on obsolete schema — `20260726000001` already adds `workspace_id` to both tables | P1 | accept | Verified. My own research error: I read the original `CREATE TABLE` and missed the later `ALTER TABLE`. Spec G3 and §6 are largely wrong and must shrink to the real delta. |
| 9 | Event producers are incomplete — the webhook calls `syncEvolutionAccountConnection` directly, bypassing `reconcileAccountConnection`; only `connected` is sketched | P1 | accept | My "one place both paths converge" claim is false. Certifying an event with no complete producer publishes a promise nothing keeps. |
| 10 | The contract ritual runs `regenerate-openapi-baseline.sh` before commit, which the script refuses on a dirty tree — and circumventing it compares the contract to itself | P1 | accept | Verified in the script's own header: "Not before: the baseline is what the gate compares against." My global constraint actively defeated the breaking-change gate. |
| 11 | Several mandatory PASS checkpoints cannot pass in order: OpenAPI scope enum, circular task imports, `ACTION_RISK_CLASSES` exact-key assertion, new scopes never added to `GENERIC_SCOPES` for issuance | P1 | accept | Task ordering must be reworked into importable slices. |
| 12 | Workspace pagination uses the wrong API shape and drops timestamp ties | P2 | accept | `readPageRequest(req, requestId)` returns `{ok, page}`; my snippet passed `URLSearchParams` and read `page.limit` directly. Keyset must order by `(created_at, workspace_id)`. |
| 13 | Platform auth invents prefix lookup; real auth queries by full hash. Fixtures use a `"hash"` literal that cannot equal a SHA-256 | P2 | accept | My `partnerKeyPrefixOf` extraction is unnecessary and wrong; query by hash. |
| 14 | Wrong-tier credentials return 401 under my wrappers, but the spec requires 404; and `generate-postman.ts` hardcodes `x-postora-key` while platform auth expects Bearer | P2 | accept | The generated collection would ship platform requests that cannot authenticate, while its regeneration test passes. |
| 15 | Revocation uses `partner_provisioned_workspaces!inner(...)`, an embed with no declared relationship between the two tables | P1 | accept | Neither table references the other. Needs an explicit join in an estate-authorised RPC. My negative test also concealed the failure via `??`. |
| 16 | Provisioning failures orphan identities and workspaces; retrying an `external_ref` creates another owner before the uniqueness violation | P2 | accept | Four separate commits with no compensation. Needs a durable reservation first. |
| 17 | `plan_slug` is declared and never used, and replacing `createAndGetQr` drops its `enforceAccountQuota` call, making `quota_exceeded` unreachable | P2 | accept | Silently removing a server-side account limit is exactly the class of regression the extraction hazard warns about. |
| 18 | A passwordless auth user is initial state, not an enforced non-login principal; the marker is unenforced metadata | P2 | partial | Accept the concern and add an explicit interactive-auth block plus a cascade test. Defer the full service-principal redesign: it is real, but forcing it into phase 1 trades a bounded compatibility bridge for an unbounded one. |
| 19 | Platform-key rotation strands the estate, because ownership binds to a `platform_key_id` | P2 | accept | Bind provisioned workspaces to a stable `partner_principal`, with rotatable credentials attached to it. Cheap now, very expensive later. |
| 20 | Consent records do not support the attestation §5.5 promises — `{accepted:true}` alone passes, no key id, no server receipt time, no consent version | P2 | accept | The browser path would also be relabelled `partner_attestation`, destroying real observed provenance. |
| 21 | History-sync status reads `account_metadata.history_sync_state`, which nothing writes; real state is `whatsapp_evolution_instances` with `claim_whatsapp_history_sync` | P2 | accept | A metadata precheck cannot prove a job was claimed. |
| 22 | `phone_number` is rendered from `platform_username`, which Direct QR deliberately uses for the chosen label; lists ignore pagination and omit `next_cursor` | P2 | accept | "Support" would be returned as a phone number. Codex also confirmed `connection_mode` and the name helpers were right. |
| 23 | The webhook migration drops the existing `cardinality(events) > 0` requirement | P2 | accept | Confirms the corrected eight-entry list is now right, but the replacement predicate must be complete, not just the array. |
| 24 | `{ok:true}` from session termination cannot express the real `disconnectWhatsAppAccount` distinction between local deactivation and failed remote logout | P2 | accept | Telling a partner the remote session ended when Evolution was unreachable is a false success claim. |
| 25 | The spec contradicts itself: §10 says 403, §12 says "402, not 403" | P2 | accept | Mine. §10 was corrected and §12 was left stale. 403 with distinct codes is the decision; §12 is wrong. |
| 26 | The PRD banner would publish a false legacy-scope guarantee — `whatsapp:templates.read` does satisfy `list_templates` | P2 | accept | Verified in `ACTION_SCOPES`. My "deliberate empty set" claim is wrong, and enforcing it would silently narrow existing partner access. The true rule is capability pinning: legacy scopes grant no *new* capability. |

**Nothing was rejected.** That is itself a finding: the plan was written from a
reading of the codebase that was too shallow in six places, and three of my own
assertions to the user were wrong. Round 2 runs against the revised documents.

---

## Debate round 2 — verdict table

Same reviewer and invocation: Codex `gpt-6-astra`, high effort, read-only
through the relay's sandbox. Tree unchanged against baseline `5b3a98e9`.

17 findings, 8 blocking. **Most are defects introduced by the round 1 fixes**,
which is the specific thing a second round is for. Round 2 also verified six
sections as sound; those are recorded at the end.

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | New `SECURITY DEFINER` functions revoke only from `PUBLIC`, but the database grants `EXECUTE` on new `public` functions **directly** to `anon` and `authenticated` | P1 | accept | Verified at `supabase/tests/baseline_schema.sql:23842`. A direct role grant survives `REVOKE ... FROM PUBLIC`, so provisioning and revocation were callable anonymously with caller-chosen principal ids. The most serious finding of either round. Now global constraint 14, with a privilege test. |
| 2 | Platform auth drops environment isolation — no prefix-vs-door check and no stored-environment check | P1 | accept | `authenticatePartnerKey` performs both. A staging credential in a restored production database would have authenticated. Both checks reproduced; workspace keys now mint with `doorEnvironment()` rather than always production. |
| 3 | The rejected single-flag entitlement model was still the executable one | P1 | accept | The spec was corrected in round 1 and Task 6 was not. Now an `(action → required keys)` conjunction, with an unlisted action refusing rather than passing. `coerceFlag` also parsed recursively where the browser parses once — the API was the more permissive door. |
| 4 | The bootstrap path creates the QR placeholder directly, bypassing the consent and quota gates that live in `registerNumber` | P1 | accept | Following the documented sequence would have paired a Direct QR number with no recorded attestation. The provisioning function now requires consent parameters and quota enforcement from its caller. |
| 5 | Idempotency call signatures wrong: replay fields are `httpStatus`/`body`, `completeIdempotency` takes six positional arguments, `markIndeterminate` needs `attemptToken` | P1 | accept | Verified against the module. All three corrected. The deeper point stands: insert and settle are still two commits, so the settlement belongs inside the registration RPC. Recorded as required, not optional. |
| 6 | The registration caller passes neither the creating key id nor the new consent provenance fields | P1 | accept | My round 1 fix added parameters and left the caller behind, so the binding could not identify its key and consent metadata would be `undefined`. Context now carries `keyId`; caller passes evidence, actor and version. |
| 7 | Compensation assumes every RPC error means rollback | P1 | accept | A lost response after a commit would have deleted a live tenant's owner, or failed against `RESTRICT`. Now reads back before compensating, distinguishes unknown from rolled-back, and adds a durable attempts table plus `external_ref` retry semantics. |
| 8 | Platform limiter returns JSONB not `RETURNS TABLE`, and `60 - EXTRACT(SECOND)` can return zero | P2 | accept | The real RPC uses `CEIL` precisely so 0 is impossible. Signature and arithmetic now mirror it, and the wrapper reuses the workspace door's decision, outage policy and headers instead of a second copy. |
| 9 | `present()` fixed the QR label but returns Meta's opaque `phone_number_id` as a phone number for Cloud API and coexistence | P2 | accept | Verified: `whatsapp-oauth` stores the id in `platform_user_id` and the human number in `account_metadata.display_phone_number`. Per-mode resolution added. `resolved` is now checked before `is_active`, since reconciliation can activate a row before its identity resolves. |
| 10 | The revised list handler cannot compile: `_req` then `req`, missing `readPageRequest` import, test imports the ops module instead of the route module | P1 | accept | All three were introduced by my round 1 edits, including a bulk rename that rewrote the test's import target. Fixed. |
| 11 | Pagination orders by `connected_at`, but a disconnect writes `is_active` and `updated_at` and leaves `connected_at` untouched | P2 | accept | The reconciliation feed would never surface the transitions a partner reconnects to find. Ordering, cursor and select moved to `updated_at`. |
| 12 | The suggested "delete the key if binding fails" fallback cannot run — `service_role` has only SELECT and INSERT on `partner_api_keys` | P2 | accept | Verified in the least-privilege migration. Atomic issuance through an RPC is now mandatory rather than preferred. |
| 13 | Provisioning, issuance and revocation write credentials with no `partner_audit_logs` entry | P2 | accept | The existing lifecycle functions deliberately commit mutation, binding and audit together. Three new entry points would have reintroduced unaudited credential creation. |
| 14 | Wrong-tier 404 is half-implemented: the platform door reads only Bearer, and the workspace door still answers 401 for a platform key | P2 | accept | A check that reads one header form leaves the other as an oracle for which tiers exist. Both directions, both header forms, four test cases. |
| 15 | The dispatch regression test passes with the platform router completely unmounted | P1 | accept | My assertion was "the code is not `unknown_action`"; an unmatched `/v1` path answers `resource_not_found`, so the test would have gone green against the exact bug it existed to catch. Now asserts handler invocation. |
| 16 | `generate-agent-context.ts` reads only `v1/router.ts` and workspace policy, and parses only `withPartnerAuth` with a literal risk class | P2 | accept | The published agent bundle would omit the entire platform tier while its equality test passed. Recorded in the spec and in the ritual. |
| 17 | Four surviving contradictions: spec §2.4 baseline regeneration, §5.2 versus Task 8 on additional numbers, §5.6 `plan_slug`, and G3 | P2 | accept | All four were mine. §2.4 and G3 corrected; `plan_slug` removed with the resulting quota gap stated plainly; additional numbers assigned to the workspace tier, and the redundant platform route deleted. |

**Verified sound by round 2**, and left as they are: the provisioning function's
column lists against the real schema; `UPDATE ... FROM` as the revocation join
shape; resolving platform routes inside `handleV1Request` with a `not_found`
fallback, preserving 405 and `Allow` handling; a trigger as viable for
`is_active` transitions, and the widened CHECK preserving both the eight-event
list and `cardinality(events) > 0`; `unsupported_capability` at 422 for the
unsupported connection modes; and `whatsapp_evolution_instances` as the correct
sync-state source with local deactivation reported separately from remote
logout.

**Status: the two-round debate budget is spent, and the plan is not yet
implementable.** Round 2's findings are addressed above, but they were dense
enough — and enough of them were introduced by round 1's fixes — that a third
pass over Tasks 1 to 8 is warranted before dispatching any implementer. That is
a judgement to confirm rather than assume.

---

## Alignment with the existing shared-ops layer

Read this before Task 7. It corrects a wrong assumption an earlier draft of
this plan made, and getting it wrong produces exactly the parallel
implementation the PRD forbids.

**`supabase/functions/_shared/whatsappPartnerOps.ts` already is the shared
use-case layer** (26KB, verified 2026-09-10). Its header states the pattern:
"WhatsApp operations shared by the JWT door (messaging-api) and the key door
(partner-api). The context is deliberately role-free: each door authorizes in
its own terms before constructing one." It already exports `sendTemplate`,
`sendText`, `sendMedia`, `listTemplates` and `upsertOutboundConversation`, and
`messaging-api/index.ts` already consumes it.

New shared operations therefore go **into that file, or into a `*Ops.ts`
sibling at `_shared/` root following its shape**. Never into a new
`_shared/usecases/` tree.

### Two contexts, deliberately

| Context | Shape | Use for |
|---|---|---|
| `WhatsAppOpsContext` (existing, in `whatsappPartnerOps.ts`) | `{ admin, accountId, ownerId, workspaceId, phoneNumberId, accessToken, connectionMode }` | any operation **on one connected number** — sends, templates, profile, catalog |
| `WhatsAppNumberContext` (new, in `whatsappNumberOps.ts`) | `{ admin, workspaceId, accountIds, requestId }` | **workspace-level** reads and registration, where there is no single account yet and no access token to carry |

These are not redundant. A registration has no `phoneNumberId` or
`accessToken` because the number does not exist yet, and a list spans accounts.
Forcing either into the other's shape means inventing empty fields, and an
empty `accessToken` is a provider call that fails at runtime rather than at the
type level.

### Resolving the account for a per-number operation

Use the existing `resolveWhatsAppAccount(authed)` from `v1/authenticated.ts`.
Do not hand-roll the lookup: it performs preflight checks a new handler will
forget.

- Not WhatsApp, or not active → `account_not_connected`
- `needs_reauth`, or `token_expires_at` in the past → `account_needs_reauth`
- Returns `{ ctx: WhatsAppOpsContext, wabaId }`

**Extend it, once, to take an optional account id** (spec §4.4). It currently
resolves `record.socialAccountId`, the single account a key is pinned to, so a
tenant with three numbers would need three keys. The extension is: use a
supplied `account_id` when present and in the bound set, else the pinned one;
an unbound id answers `resource_not_found`. Every existing caller passes
nothing and keeps its current behaviour.

### Failure convention

`whatsappPartnerOps.ts` throws `WhatsAppOpError(message, code, status,
metaCode?, indeterminate)` rather than returning a tagged result. New
per-number operations match that. The `indeterminate` flag is load-bearing: it
means it cannot be proven Meta did *not* accept, so the caller must keep the
quota unit and make the request non-resendable. A 5xx, a missing message id, or
an unparseable body are all indeterminate; a 4xx with a specific Meta code is a
definite rejection.

The new workspace-level operations in `whatsappNumberOps.ts` return tagged
results instead, because they make no provider call that could be
indeterminate. Where a pairing operation does call Evolution, it throws
`WhatsAppOpError` like its siblings.

---

## The extraction hazard every remaining task shares

Read this before Task 7 and before any later extraction task.

The private surfaces this plan lifts from are scoped by **user**, not by
workspace:

| Source | Current scoping unit |
|---|---|
| `whatsapp-evolution-bridge` — `createAndGetQr(context, ...)`, `getQrStatus(admin, userId, body)`, `syncPastChats(admin, userId, body)`, `getSyncStatus(admin, userId, body)`, `logoutInstance(admin, userId, body)` | `context.user.id` / `userId` |
| `messaging-api` | the caller's JWT subject |
| `comment-manager` | the caller's JWT subject |
| `whatsapp_agents`, `whatsapp_conversation_assignments` | `user_id`, no workspace column at all |

**A partner key has a workspace and no user.** Extraction therefore is not a
move; it is a re-scoping. Every lifted use-case takes a `workspaceId` and a
resolved set of bound account ids, and reaches rows through the
`partner_api_key_accounts` binding, never through a user id.

Three rules follow, and they apply to Tasks 7 onward without being restated:

1. **Never pass a user id into a lifted use-case.** If a lifted function still
   needs one, the extraction is incomplete — the row it reaches is scoped by
   the wrong thing.
2. **The browser door supplies the workspace too.** When `messaging-api` calls
   the extracted use-case, it resolves the caller's workspace first and passes
   that. It must not keep a user-scoped path beside the workspace-scoped one;
   two scoping units for one rule is the `PROJECT_AGENT.md` stop condition
   "two different modules appear to own the same business rule".
3. **Every extraction ships a door-parity test** asserting that the browser
   door and the `/v1` door return the same result for the same input. This is
   the regression gate on the largest risk in the spec (§14.1).

---

### Task 7: Lift WhatsApp number reads, and expose them

**Files:**
- Create: `supabase/functions/_shared/whatsappNumberOps.ts`
- Create: `supabase/functions/_shared/whatsappNumberOps.test.ts`
- Create: `supabase/functions/partner-api/v1/whatsappNumbers.ts`
- Create: `supabase/functions/partner-api/v1/whatsappNumbers.test.ts`
- Modify: `supabase/functions/messaging-api/index.ts` (the `whatsapp_register_phone` branch)
- Modify: `supabase/functions/partner-api/v1/router.ts`, `supabase/functions/partner-api/router.ts`

**Interfaces:**
- Consumes: `assertEntitled` (Task 6); `boundAccountIds`, `selectBoundAccounts` from `v1/binding.ts`.
- Produces:
  - `interface WhatsAppNumberContext { admin: any; workspaceId: string; accountIds: string[]; requestId: string; }`
  - `listWhatsAppNumbers(ctx: WhatsAppNumberContext): Promise<{ ok: true; numbers: WhatsAppNumber[] } | { ok: false; reason: "read_failed" }>`
  - `getWhatsAppNumber(ctx, accountId: string): Promise<{ ok: true; number: WhatsAppNumber } | { ok: false; reason: "read_failed" | "not_found" }>`
  - `interface WhatsAppNumber { account_id: string; phone_number: string | null; display_name: string | null; connection_mode: string | null; status: "connected" | "disconnected" | "pending"; connected_at: string | null; }`

  Registration (`POST /v1/whatsapp/numbers`) is **not** in this task. It writes,
  so it needs the idempotency claim path and a connection-mode branch, and it
  belongs with the pairing lifecycle in Task 8.

- [ ] **Step 1: Write the failing use-case test**

Create `supabase/functions/_shared/whatsappNumberOps.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getWhatsAppNumber, listWhatsAppNumbers } from "./whatsappNumberOps.ts";

const ROW = {
  id: "acct-1",
  workspace_id: "ws-1",
  platform: "whatsapp",
  // The identity is platform_user_id. platform_username holds the Direct QR
  // LABEL, which is exactly the trap this fixture exists to catch.
  platform_user_id: "15550001111",
  platform_username: "Support",
  connection_mode: "evolution_qr",
  account_metadata: { display_name: "Support", connection_mode: "evolution_qr" },
  is_active: true,
  connected_at: "2026-09-01T00:00:00Z",
};

function adminStub(rows: unknown[] | null, error: unknown = null) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        order() { return Promise.resolve({ data: rows, error }); },
        maybeSingle() {
          return Promise.resolve({ data: rows === null ? null : rows[0] ?? null, error });
        },
      };
    },
  };
}

const CTX = { workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" };

Deno.test("list returns only accounts the key is bound to", async () => {
  const result = await listWhatsAppNumbers({ ...CTX, admin: adminStub([ROW]) });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.numbers.length, 1);
  assertEquals(result.numbers[0].account_id, "acct-1");
  assertEquals(result.numbers[0].connection_mode, "evolution_qr");
  assertEquals(result.numbers[0].status, "connected");
});

Deno.test("the Direct QR label is never returned as a phone number", async () => {
  const result = await listWhatsAppNumbers({ ...CTX, admin: adminStub([ROW]) });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.numbers[0].phone_number, "15550001111");
  assertEquals(result.numbers[0].display_name, "Support");
});

Deno.test("an unpaired placeholder reports pending with a null phone number", async () => {
  const pending = {
    ...ROW,
    platform_user_id: "pending_5f6a1c1e-0000-0000-0000-000000000000",
    is_active: false,
  };
  const result = await listWhatsAppNumbers({ ...CTX, admin: adminStub([pending]) });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.numbers[0].phone_number, null);
  // pending, NOT disconnected: a pairing screen must tell "scan the QR" from
  // "reconnect", and the placeholder has never been paired at all.
  assertEquals(result.numbers[0].status, "pending");
});

Deno.test("list reports a failed read rather than an empty list", async () => {
  const result = await listWhatsAppNumbers({
    ...CTX,
    admin: adminStub(null, { message: "statement timeout" }),
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "read_failed");
});

Deno.test("a paired but inactive account reads as disconnected, not absent", async () => {
  const result = await listWhatsAppNumbers({
    ...CTX,
    admin: adminStub([{ ...ROW, is_active: false }]),
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.numbers[0].status, "disconnected");
});

Deno.test("get refuses an account outside the bound set without querying it", async () => {
  let queried = false;
  const admin = {
    from() {
      queried = true;
      return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: ROW, error: null }); } };
    },
  };
  const result = await getWhatsAppNumber({ ...CTX, admin }, "acct-elsewhere");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "not_found");
  assertEquals(queried, false, "an unbound id must be refused before it reaches the database");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappNumberOps.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

Create `supabase/functions/_shared/whatsappNumberOps.ts`:

```typescript
// WhatsApp number reads, scoped by WORKSPACE and bound accounts.
//
// Lifted from messaging-api and whatsapp-evolution-bridge, which scoped by
// user id. A partner key has a workspace and no user, so the scoping unit
// changes here. See "The extraction hazard" in the plan: never reintroduce a
// user id into this module.
//
// Returns a tagged result rather than a Response, so both doors render their
// own error vocabulary. A use-case that returned an HTTP Response would tie
// the browser door to the partner door's error codes.

import { encodeCursor } from "../partner-api/v1/pagination.ts";

export interface WhatsAppNumberContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  workspaceId: string;
  accountIds: string[];
  requestId: string;
  /** The partner key acting, when there is one. Required by any operation that
   *  CREATES an account, because the new row needs a
   *  partner_api_key_accounts binding to that key or the key cannot see it.
   *  Absent for the browser door, which has no key and no binding to write. */
  keyId?: string;
}

export interface WhatsAppNumber {
  account_id: string;
  phone_number: string | null;
  display_name: string | null;
  connection_mode: string | null;
  status: "connected" | "disconnected" | "pending";
  connected_at: string | null;
}

// deno-lint-ignore no-explicit-any
function present(row: any): WhatsAppNumber {
  const meta = (row.account_metadata ?? {}) as Record<string, unknown>;
  const mode = row.connection_mode ?? (meta.connection_mode as string | undefined) ?? null;

  // platform_username is NOT the phone number in every mode. Direct QR
  // deliberately stores the user's chosen connection LABEL there (see
  // createAndGetQr), so reading it as a phone number returns "Support" as a
  // number. The real identity is platform_user_id, and until pairing resolves
  // it that value is a `pending_<uuid>` placeholder, which must render as null
  // rather than as a phone number that does not exist.
  const rawId = typeof row.platform_user_id === "string" ? row.platform_user_id : "";
  const resolved = Boolean(rawId) && !rawId.startsWith("pending_");

  // The phone number lives in a DIFFERENT place per mode, and neither is
  // platform_username:
  //   evolution_qr  -> platform_user_id is the linked number
  //   cloud_api     -> platform_user_id is Meta's opaque phone_number_id;
  //                    the human number is account_metadata.display_phone_number
  //                    (whatsapp-oauth writes both)
  // Returning platform_user_id for a Meta account hands the partner an
  // internal identifier labelled as a telephone number.
  const phoneNumber = !resolved
    ? null
    : mode === "evolution_qr"
    ? rawId
    : ((meta.display_phone_number as string | undefined) ?? null);

  return {
    account_id: row.id,
    phone_number: phoneNumber,
    display_name: (meta.display_name as string | undefined) ?? row.platform_username ?? null,
    connection_mode: mode,
    // Three states, not two. A placeholder that has never paired is `pending`;
    // a row that paired and later dropped is `disconnected`. Collapsing them
    // makes a pairing UI unable to tell "scan the QR" from "reconnect", which
    // is the one distinction that screen exists to draw.
    //
    // `resolved` is checked BEFORE `is_active`, deliberately: reconciliation
    // can activate a row before its identity resolves, and an active row still
    // carrying a `pending_` id has not finished pairing. Testing is_active
    // first would report it connected with a null phone number.
    status: !resolved ? "pending" : (row.is_active ? "connected" : "disconnected"),
    connected_at: row.connected_at ?? null,
  };
}

export async function listWhatsAppNumbers(
  ctx: WhatsAppNumberContext,
  page?: { limit: number; cursor: { timestamp: string; id: string } | null },
): Promise<
  | { ok: true; numbers: WhatsAppNumber[]; nextCursor: string | null }
  | { ok: false; reason: "read_failed" }
> {
  if (ctx.accountIds.length === 0) return { ok: true, numbers: [], nextCursor: null };

  const limit = page?.limit ?? 20;

  let query = ctx.admin
    .from("social_accounts")
    .select("id, workspace_id, platform, platform_user_id, platform_username, connection_mode, account_metadata, is_active, connected_at, updated_at")
    .eq("workspace_id", ctx.workspaceId)
    .eq("platform", "whatsapp")
    .in("id", ctx.accountIds)
    // Ordered by UPDATED_AT, not connected_at. The spec's reconciliation
    // guarantee (§8) is a changes-since feed, and a disconnect or reconnect
    // writes is_active and updated_at while leaving connected_at untouched. A
    // connected_at cursor would never surface that change, so a partner
    // reconciling after an outage would miss exactly the transitions it went
    // looking for.
    //
    // Paired with id, because a bulk provisioning run creates rows sharing a
    // timestamp and a timestamp-only boundary either repeats or drops them.
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (page?.cursor) {
    // Lexicographic on the pair: strictly older, or same instant with a
    // smaller id.
    query = query.or(
      `updated_at.lt.${page.cursor.timestamp},` +
        `and(updated_at.eq.${page.cursor.timestamp},id.lt.${page.cursor.id})`,
    );
  }

  // Exactly ONE .or() call. PostgREST's .or() does not compose — a second call
  // REPLACES the first rather than ANDing with it, which shipped as a real bug
  // in PR #35 and is documented at the top of _shared/partnerWebhookEvents.ts.
  // If a second disjunction is ever needed here, filter in TypeScript instead
  // of hand-building an or-string.
  const { data, error } = await query;

  if (error) {
    console.error(`[usecase] whatsapp number list failed (request ${ctx.requestId}):`, error);
    return { ok: false, reason: "read_failed" };
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];

  return {
    ok: true,
    numbers: visible.map(present),
    nextCursor: hasMore && last
      ? encodeCursor({ timestamp: last.updated_at, id: last.id })
      : null,
  };
}

export async function getWhatsAppNumber(
  ctx: WhatsAppNumberContext,
  accountId: string,
): Promise<{ ok: true; number: WhatsAppNumber } | { ok: false; reason: "read_failed" | "not_found" }> {
  // Refuse an unbound id BEFORE querying. Querying first and filtering after
  // would leak existence through timing, and the binding is the authorisation.
  if (!ctx.accountIds.includes(accountId)) return { ok: false, reason: "not_found" };

  const { data, error } = await ctx.admin
    .from("social_accounts")
    .select("id, workspace_id, platform, platform_user_id, platform_username, connection_mode, account_metadata, is_active, connected_at, updated_at")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    console.error(`[usecase] whatsapp number read failed (request ${ctx.requestId}):`, error);
    return { ok: false, reason: "read_failed" };
  }
  if (!data) return { ok: false, reason: "not_found" };
  return { ok: true, number: present(data) };
}
```

- [ ] **Step 4: Run the use-case test to verify it passes**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappNumberOps.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route test**

Create `supabase/functions/partner-api/v1/whatsappNumbers.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { getNumber, listNumbers } from "./whatsappNumbers.ts";

const AUTHED_BASE = {
  record: {
    id: "key-1",
    workspaceId: "ws-1",
    socialAccountId: "acct-1",
    keyPrefix: "pk_live_abcd",
    scopes: ["whatsapp:numbers.read"],
    rateLimitPerMin: 60,
    monthlyQuota: null,
    expiresAt: null,
    revokedAt: null,
  },
  requestId: "req-1",
  rateHeaders: {},
};

function adminStub(opts: { entitled?: boolean; rows?: unknown[] } = {}) {
  const entitled = opts.entitled ?? true;
  return {
    from(table: string) {
      // Entitlement reads three tables (Task 6): the provisioned owner, the
      // global app_settings flag, then that owner's overrides.
      if (table === "partner_provisioned_workspaces") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { owner_user_id: "svc-user-1" }, error: null });
          },
        };
      }
      if (table === "app_settings") {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { key: "k", value: entitled }, error: null });
          },
        };
      }
      if (table === "user_feature_overrides") {
        const result = Promise.resolve({ data: [], error: null });
        return {
          select() { return this; },
          eq() { return { eq: () => result, then: result.then.bind(result) }; },
        };
      }
      if (table === "partner_api_key_accounts") {
        return {
          select() { return this; },
          eq() { return this; },
          order() { return Promise.resolve({ data: [{ social_account_id: "acct-1" }], error: null }); },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        order() {
          return Promise.resolve({
            data: opts.rows ?? [{
              id: "acct-1",
              workspace_id: "ws-1",
              platform: "whatsapp",
              platform_username: "15550001111",
              account_metadata: { display_name: "Support", connection_mode: "cloud_api" },
              is_active: true,
              connected_at: "2026-09-01T00:00:00Z",
            }],
            error: null,
          });
        },
        maybeSingle() { return Promise.resolve({ data: (opts.rows ?? [])[0] ?? null, error: null }); },
      };
    },
  };
}

Deno.test("listing numbers renders the bound accounts", async () => {
  const req = new Request("https://x/v1/whatsapp/numbers");
  const res = await listNumbers(req, { ...AUTHED_BASE, admin: adminStub() }, {});
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.data.length, 1);
  assertEquals(body.data[0].connection_mode, "cloud_api");
});

Deno.test("an unentitled workspace gets feature_not_entitled, not insufficient_scope", async () => {
  const req = new Request("https://x/v1/whatsapp/numbers");
  const res = await listNumbers(req, { ...AUTHED_BASE, admin: adminStub({ entitled: false }) }, {});
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "feature_not_entitled");
});

Deno.test("an unbound account id is not found", async () => {
  const req = new Request("https://x/v1/whatsapp/numbers/acct-elsewhere");
  const res = await getNumber(req, { ...AUTHED_BASE, admin: adminStub() }, { id: "acct-elsewhere" });
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "resource_not_found");
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/partner-api/v1/whatsappNumbers.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Implement the handlers**

Create `supabase/functions/partner-api/v1/whatsappNumbers.ts`:

```typescript
// GET /v1/whatsapp/numbers, GET /v1/whatsapp/numbers/{id},
// POST /v1/whatsapp/numbers (spec §7.1).
//
// The handler is a translator: entitlement, binding, use-case, render. All
// business rules live in the use-case so the browser door enforces the same
// ones.

import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { boundAccountIds } from "./binding.ts";
import { readPageRequest } from "./pagination.ts";
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { getWhatsAppNumber, listWhatsAppNumbers } from "../../_shared/whatsappNumberOps.ts";
import type { V1AuthedContext } from "./authenticated.ts";

export async function listNumbers(
  req: Request,
  authed: V1AuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const denied = await assertEntitled(admin, record.workspaceId, "list_whatsapp_numbers", requestId);
  if (denied) return denied;

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;

  // The spec's reconciliation guarantee (§8) requires every event-bearing
  // collection to be cursor-paginated and ordered by update time. A bare
  // array would make a partner unable to reconcile after an outage, which is
  // the whole reason webhooks alone were rejected.
  const page = readPageRequest(req, requestId);
  if (!page.ok) return page.res;

  const result = await listWhatsAppNumbers({
    admin,
    workspaceId: record.workspaceId,
    accountIds: bound.ids,
    requestId,
  }, page.page);
  if (!result.ok) return v1ErrorResponse("internal_error", requestId);

  return v1JsonResponse({
    data: result.numbers,
    next_cursor: result.nextCursor,
    request_id: requestId,
  }, requestId);
}

export async function getNumber(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const denied = await assertEntitled(admin, record.workspaceId, "get_whatsapp_number", requestId);
  if (denied) return denied;

  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;

  const result = await getWhatsAppNumber({
    admin,
    workspaceId: record.workspaceId,
    accountIds: bound.ids,
    requestId,
  }, params.id);

  if (!result.ok) {
    return result.reason === "not_found"
      ? v1ErrorResponse("resource_not_found", requestId)
      : v1ErrorResponse("internal_error", requestId);
  }
  return v1JsonResponse({ ...result.number, request_id: requestId }, requestId);
}
```

- [ ] **Step 8: Register the routes and the policy**

In `supabase/functions/partner-api/v1/router.ts`, add to `V1_ROUTES`, placing the two-segment collection and the three-segment item in the file's existing order habit:

```typescript
  {
    pattern: "/v1/whatsapp/numbers",
    methods: {
      GET: withPartnerAuth("list_whatsapp_numbers", "A", listNumbers),
    },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}",
    methods: {
      GET: withPartnerAuth("get_whatsapp_number", "A", getNumber),
    },
  },
```

In `supabase/functions/partner-api/router.ts`, add to `ACTION_SCOPES`:

```typescript
  // Spec §7.1. Generic scopes only: whatsapp:numbers.read shares a PREFIX with
  // the three legacy whatsapp scopes but is not one of them — membership in
  // LegacyScope is what makes a scope legacy, not its prefix.
  list_whatsapp_numbers: ["whatsapp:numbers.read"],
  get_whatsapp_number: ["whatsapp:numbers.read"],
```

- [ ] **Step 9: Run the route test and the full partner-api suite**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/partner-api/
```

Expected: PASS, including `limiterPolicy.test.ts` (both new actions have a risk class) and `partnerScopes.test.ts` (neither new scope is legacy).

- [ ] **Step 10: Update the contract and run the drift gates**

Add `GET /v1/whatsapp/numbers` and `GET /v1/whatsapp/numbers/{id}` to `docs/api/openapi.yaml`, then:

```bash
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
deno run --allow-read scripts/check-openapi-drift.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
```

- [ ] **Step 11: Commit**

```bash
git commit -- supabase/functions/_shared/whatsappNumberOps.ts \
               supabase/functions/_shared/whatsappNumberOps.test.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.test.ts \
               supabase/functions/partner-api/v1/router.ts \
               supabase/functions/partner-api/router.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): read WhatsApp numbers through /v1"
```

---

### Task 8: Register a number and drive pairing

**Files:**
- Create: `supabase/functions/_shared/whatsappPairingOps.ts`
- Create: `supabase/functions/_shared/whatsappPairingOps.test.ts`
- Modify: `supabase/functions/partner-api/v1/whatsappNumbers.ts` (+ its test)
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts` (call the use-case)
- Modify: `supabase/functions/partner-api/v1/router.ts`, `supabase/functions/partner-api/router.ts`

**Interfaces:**
- Consumes: `WhatsAppNumberContext` (Task 7); `claimIdempotency`, `hashRequest` from `_shared/partnerApiIdempotency.ts`; `assertEntitled` (Task 6); `owner_user_id` from `partner_provisioned_workspaces` (Task 1).
- Produces:
  - `type ConnectionMode = "cloud_api" | "coexistence" | "evolution_qr"`
  - `interface RiskConsent { accepted: boolean; accepted_by: string; accepted_at: string; accepted_ip: string | null; }`
  - `registerNumber(ctx: WhatsAppNumberContext, input: { ownerUserId: string; connectionName: string; connectionMode: ConnectionMode; riskConsent: RiskConsent | null }): Promise<{ ok: true; accountId: string } | { ok: false; reason: "consent_required" | "invalid_name" | "quota_exceeded" | "write_failed" }>`
  - `startPairing(ctx, accountId: string): Promise<{ ok: true; qr: { code: string; expires_at: string } } | { ok: false; reason: "not_found" | "wrong_mode" | "provider_failed" }>`
  - `pairingStatus(ctx, accountId: string): Promise<{ ok: true; state: "pending" | "connected" | "expired"; phone_number: string | null } | { ok: false; reason: "not_found" | "provider_failed" }>`

- [ ] **Step 1: Write the failing use-case test**

Create `supabase/functions/_shared/whatsappPairingOps.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { registerNumber } from "./whatsappPairing.ts";

const CTX = { workspaceId: "ws-1", accountIds: [], requestId: "req-1" };

function adminStub(insertError: unknown = null) {
  return {
    from() {
      return {
        insert() { return Promise.resolve({ error: insertError }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  };
}

const CONSENT = {
  accepted: true,
  accepted_by: "tenant-admin@example.com",
  accepted_at: "2026-09-10T09:00:00Z",
  accepted_ip: "203.0.113.9",
};

Deno.test("evolution_qr without consent is refused", async () => {
  const result = await registerNumber({ ...CTX, admin: adminStub() }, {
    ownerUserId: "svc-user-1",
    connectionName: "Support",
    connectionMode: "evolution_qr",
    riskConsent: null,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "consent_required");
});

Deno.test("evolution_qr with an unaccepted consent object is still refused", async () => {
  const result = await registerNumber({ ...CTX, admin: adminStub() }, {
    ownerUserId: "svc-user-1",
    connectionName: "Support",
    connectionMode: "evolution_qr",
    riskConsent: { ...CONSENT, accepted: false },
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "consent_required");
});

Deno.test("cloud_api needs no consent gate", async () => {
  const result = await registerNumber({ ...CTX, admin: adminStub() }, {
    ownerUserId: "svc-user-1",
    connectionName: "Support",
    connectionMode: "cloud_api",
    riskConsent: null,
  });
  assertEquals(result.ok, true);
});

Deno.test("an empty connection name is rejected, never substituted", async () => {
  const result = await registerNumber({ ...CTX, admin: adminStub() }, {
    ownerUserId: "svc-user-1",
    connectionName: "   ",
    connectionMode: "cloud_api",
    riskConsent: null,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "invalid_name");
});

Deno.test("a name longer than 60 characters is rejected", async () => {
  const result = await registerNumber({ ...CTX, admin: adminStub() }, {
    ownerUserId: "svc-user-1",
    connectionName: "x".repeat(61),
    connectionMode: "cloud_api",
    riskConsent: null,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "invalid_name");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappPairingOps.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pairing use-case**

Create `supabase/functions/_shared/whatsappPairingOps.ts`. Read `whatsapp-evolution-bridge/index.ts` lines 175 to 270 first and lift the Evolution instance creation verbatim — the instance naming (`postora_<accountId>`), the JWT key generation and the metadata merge are load-bearing and must not be reinvented:

```typescript
// WhatsApp registration and pairing, scoped by WORKSPACE (spec §7.1, §5.4, §5.5).
//
// Lifted from whatsapp-evolution-bridge.createAndGetQr, which took
// context.user.id. The owner user now arrives explicitly as ownerUserId,
// resolved from partner_provisioned_workspaces for a partner call and from the
// caller for a browser call. social_accounts.user_id is NOT NULL, so this
// value is required, not optional.
//
// The Direct QR consent gate is preserved, not dropped. Postora cannot observe
// a partner's end user, so the partner attests (spec §5.5) and the attestation
// is recorded against the key that made it.

// Verified 2026-09-10: these live in evolutionQrAccount.ts, NOT whatsappAccess.ts.
import { mergeDisplayName, normalizeConnectionName } from "./evolutionQrAccount.ts";
import type { WhatsAppNumberContext } from "./whatsappNumberOps.ts";

export type ConnectionMode = "cloud_api" | "coexistence" | "evolution_qr";

export interface RiskConsent {
  accepted: boolean;
  accepted_by: string;
  accepted_at: string;
  accepted_ip: string | null;
}

export interface RegisterInput {
  ownerUserId: string;
  connectionName: string;
  connectionMode: ConnectionMode;
  riskConsent: RiskConsent | null;
  /** "observed" from the browser door, "partner_attestation" from /v1. Set by
   *  the caller: this module serves both doors and must not assume one. */
  consentEvidence: "observed" | "partner_attestation";
  /** Who Postora authenticated when the claim arrived — a user id for the
   *  browser door, a partner key id for /v1. A fact Postora observed. */
  recordedBy: string;
  /** The consent text version accepted. */
  consentVersion: string;
}

export type RegisterResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: "consent_required" | "invalid_name" | "quota_exceeded" | "write_failed" };

export async function registerNumber(
  ctx: WhatsAppNumberContext,
  input: RegisterInput,
): Promise<RegisterResult> {
  const name = normalizeConnectionName(input.connectionName);
  if (!name) return { ok: false, reason: "invalid_name" };

  // Direct QR is unofficial WhatsApp access with a real ban risk. The browser
  // door OBSERVES a click and a client IP; a partner ATTESTS to one it
  // collected. Those are different grades of evidence and the record must say
  // which it holds — relabelling an observed acceptance as an attestation
  // destroys the stronger provenance.
  if (input.connectionMode === "evolution_qr") {
    const consent = input.riskConsent;
    if (
      consent?.accepted !== true ||
      typeof consent.accepted_by !== "string" || consent.accepted_by.trim() === "" ||
      typeof consent.accepted_at !== "string" || Number.isNaN(Date.parse(consent.accepted_at))
    ) {
      // Validated, not merely present. `{accepted:true}` with no identity and
      // no timestamp is not evidence of anything.
      console.warn(`[usecase] evolution_qr refused: incomplete risk consent (request ${ctx.requestId})`);
      return { ok: false, reason: "consent_required" };
    }
  }

  const accountId = crypto.randomUUID();
  const consentMetadata = input.riskConsent
    ? {
      risk_consent_accepted_at: input.riskConsent.accepted_at,
      risk_consent_accepted_by: input.riskConsent.accepted_by,
      risk_consent_user_ip: input.riskConsent.accepted_ip,
      // "observed" when this door saw the acceptance itself (the browser),
      // "partner_attestation" when a partner reported it. Set by the CALLER,
      // never hardcoded here — this module serves both doors.
      risk_consent_evidence: input.consentEvidence,
      // Who Postora authenticated when the claim was made, and when Postora
      // received it. Both are facts Postora observed even for an attestation,
      // and they are what an audit can actually rely on.
      risk_consent_recorded_by: input.recordedBy,
      risk_consent_recorded_at: new Date().toISOString(),
      // Which text was accepted. Without it, a later wording change makes
      // every prior acceptance unattributable to anything specific.
      risk_consent_version: input.consentVersion,
    }
    : {};

  const metadata = mergeDisplayName({
    connection_mode: input.connectionMode,
    ...consentMetadata,
  }, name);

  const { error } = await ctx.admin.from("social_accounts").insert({
    id: accountId,
    user_id: input.ownerUserId,
    workspace_id: ctx.workspaceId,
    platform: "whatsapp",
    platform_user_id: `pending_${accountId}`,
    platform_username: name,
    access_token: "",
    connection_mode: input.connectionMode,
    account_metadata: metadata,
    is_active: false,
  });

  if (error) {
    console.error(`[usecase] whatsapp register failed (request ${ctx.requestId}):`, error);
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, accountId };
}
```

**Read the real idempotency module before writing any of this.**
`_shared/partnerApiIdempotency.ts` exports `claimIdempotency`,
`completeIdempotency`, `markIndeterminate` and `hashRequest`. Match its actual
`ClaimResult` variants and its settle signature — the names used above
(`replay`, `claimed`, `attemptToken`, `storedResponse`) are the intent, and the
module is the specification. `v1/messages.ts` lines 325 to 375 is the worked
example to copy.

**`registerNumber` must also insert the `partner_api_key_accounts` binding**,
in the same transaction as the `social_accounts` row. Without it the key that
created the number cannot see it: `binding.ts` has no fallback, so the list
would omit it and pairing would refuse it as unbound. Prefer a small RPC that
does both inserts atomically, mirroring `provision_partner_tenant` in Task 1; a
binding insert that fails after the account insert leaves an invisible account.

**Account-limit enforcement must survive the lift.** `createAndGetQr` calls
`enforceAccountQuota(admin, userId)` before creating anything. Dropping it
silently removes a server-side limit and makes the `quota_exceeded` branch
above unreachable. Re-express it against the workspace's owner id and keep it.

`startPairing` and `pairingStatus` lift `createAndGetQr`'s Evolution calls and
`getQrStatus` respectively, including `reconcileAccountConnection`. Read those
functions and move the bodies; change only the scoping unit from `userId` to
`ctx.workspaceId` plus the bound account check.

**Do not lift `resubscribeWebhook`.** Spec §7.1 keeps it operator-only.

- [ ] **Step 4: Run the use-case test to verify it passes**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappPairingOps.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Add the three write handlers**

Append to `supabase/functions/partner-api/v1/whatsappNumbers.ts`. Every write claims idempotency exactly as `messages.ts` does — read its lines 325 to 375 and match the claim, settle and indeterminate branches:

```typescript
export async function registerNumberRoute(
  req: Request,
  authed: V1AuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;

  const denied = await assertEntitled(admin, record.workspaceId, "register_whatsapp_number", requestId);
  if (denied) return denied;

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) return v1ErrorResponse("missing_idempotency_key", requestId);

  let body: {
    connection_name?: unknown;
    connection_mode?: unknown;
    risk_consent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return v1ErrorResponse("invalid_request", requestId, { message: "body must be JSON" });
  }

  const mode = body.connection_mode;
  if (mode !== "cloud_api" && mode !== "coexistence" && mode !== "evolution_qr") {
    return v1ErrorResponse("invalid_request", requestId, {
      message: "connection_mode must be cloud_api, coexistence or evolution_qr",
    });
  }

  // Phase 1 is Direct QR only (spec §7.1). Cloud API and coexistence need a
  // Meta credential exchange, phone-number/WABA association and business
  // verification, none of which is a partner-drivable flow today. Creating the
  // same placeholder row for them would return 201 for a number that can never
  // connect, so the boundary is stated at the call.
  if (mode !== "evolution_qr") {
    console.warn(`[partner-api] register refused: ${mode} onboarding not available (request ${requestId})`);
    return v1ErrorResponse("unsupported_capability", requestId, {
      message: `${mode} onboarding is not available through the Partner API yet`,
    });
  }

  // The hash covers EVERY field that changes the outcome, consent included. A
  // retry that flips risk_consent while reusing the key must conflict, not
  // replay as if it had always been accepted.
  const basis = {
    mode,
    connection_name: body.connection_name,
    risk_consent: body.risk_consent ?? null,
  };

  const claim = await claimIdempotency(admin, record.id, idempotencyKey, await hashRequest(basis));

  // Every outcome is handled. The previous draft omitted `replay` and ignored
  // the attempt token, so a replay fell through into a SECOND registration and
  // a success left a claim stuck in `processing` until its lease expired —
  // after which a retry created another account.
  // Verified signatures (2026-09-10) — ClaimResult is:
  //   { outcome: "claimed";  attemptToken: string }
  //   { outcome: "replay";   httpStatus: number; body: unknown }
  //   { outcome: "conflict" } | { outcome: "in_progress" } | { outcome: "indeterminate" }
  let attemptToken: string;
  switch (claim.outcome) {
    case "replay":
      return v1JsonResponse(claim.body, requestId, claim.httpStatus);
    case "conflict":
      return v1ErrorResponse("idempotency_conflict", requestId);
    case "in_progress":
      return v1ErrorResponse("idempotency_in_progress", requestId);
    case "indeterminate":
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    case "claimed":
      attemptToken = claim.attemptToken;
      break;
  }

  // The owner identity every social account needs (spec §5.4).
  const { data: provisioning, error: provisioningError } = await admin
    .from("partner_provisioned_workspaces")
    .select("owner_user_id")
    .eq("workspace_id", record.workspaceId)
    .maybeSingle();

  if (provisioningError) {
    console.error(`[partner-api] owner lookup failed (request ${requestId}):`, provisioningError);
    return v1ErrorResponse("internal_error", requestId);
  }
  if (!provisioning) {
    // A workspace not provisioned through the platform tier has no service
    // owner. Refuse rather than guessing a user: a guessed owner is a
    // cross-tenant write.
    console.warn(`[partner-api] register refused: workspace has no service owner (request ${requestId})`);
    return v1ErrorResponse("invalid_request", requestId, {
      message: "this workspace was not provisioned through the platform API",
    });
  }

  const result = await registerNumber({
    admin,
    workspaceId: record.workspaceId,
    // The creating key. registerNumber must insert the
    // partner_api_key_accounts binding for it, or the number it just created
    // is invisible to the key that asked for it.
    keyId: record.id,
    accountIds: [],
    requestId,
  }, {
    ownerUserId: provisioning.owner_user_id,
    connectionName: String(body.connection_name ?? ""),
    connectionMode: mode,
    riskConsent: (body.risk_consent ?? null) as RiskConsent | null,
    // Provenance (spec §5.5). This door did not witness the acceptance, so it
    // records a partner's claim, the key Postora authenticated when the claim
    // arrived, and the consent text version. The browser door passes
    // "observed" and the acting user id instead.
    consentEvidence: "partner_attestation",
    recordedBy: record.id,
    consentVersion: DIRECT_QR_CONSENT_VERSION,
  });

  if (!result.ok) {
    // A DETERMINISTIC failure: nothing was created, so settle the claim as a
    // clean failure and let the partner retry with the same key.
    let response: Response;
    if (result.reason === "consent_required") {
      response = v1ErrorResponse("invalid_request", requestId, {
        message: "risk_consent with accepted=true is required for evolution_qr",
      });
    } else if (result.reason === "invalid_name") {
      response = v1ErrorResponse("invalid_request", requestId, {
        message: "connection_name must be 1 to 60 characters",
      });
    } else if (result.reason === "quota_exceeded") {
      response = v1ErrorResponse("quota_exceeded", requestId);
    } else {
      // write_failed cannot be proven not to have written. Mark the claim
      // indeterminate rather than settling it: a retry must not create a
      // second account for a row that may exist.
      // markIndeterminate(client, keyId, idempotencyKey, attemptToken)
      await markIndeterminate(admin, record.id, idempotencyKey, attemptToken);
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    }
    // completeIdempotency(client, keyId, idempotencyKey, attemptToken, httpStatus, body)
    // — six positional arguments, not an options object.
    await completeIdempotency(
      admin,
      record.id,
      idempotencyKey,
      attemptToken,
      response.status,
      await response.clone().json(),
    );
    return response;
  }

  const body201 = {
    account_id: result.accountId,
    connection_mode: "evolution_qr",
    status: "pending",
    request_id: requestId,
  };

  // Settle BEFORE returning. A success that never settles leaves the claim in
  // `processing`, and once its lease expires the same key registers again.
  await completeIdempotency(admin, record.id, idempotencyKey, attemptToken, 201, body201);

  return v1JsonResponse(body201, requestId, 201);
}
```

**The settlement gap this does not close.** Creating the account and settling
the claim are still two commits. A crash between them, or a settle that fails,
leaves a created account under a `processing` claim; once the lease expires a
retry creates a second one.

Closing it properly means writing the settlement inside the same transaction as
the account insert — that is, the registration RPC records the idempotency
outcome itself, the way `provision_partner_tenant` does its five inserts. Do
that rather than accepting the window: this endpoint creates a billable,
externally visible resource, and "usually only once" is not idempotency.

`startPairingRoute` and `pairingStatusRoute` follow the same shape: entitlement, binding, use-case, render. `startPairingRoute` is a write and claims idempotency; `pairingStatusRoute` is a class-B read and does not.

- [ ] **Step 6: Register the routes and the policy**

`V1_ROUTES` — three-segment sub-resource before the two-segment collection:

```typescript
  {
    pattern: "/v1/whatsapp/numbers/{id}/pairing",
    methods: {
      POST: withPartnerAuth("create_whatsapp_pairing", "C", startPairingRoute),
      GET: withPartnerAuth("get_whatsapp_pairing", "B", pairingStatusRoute),
    },
  },
```

and add `POST` to the existing `/v1/whatsapp/numbers` entry:

```typescript
      POST: withPartnerAuth("register_whatsapp_number", "C", registerNumberRoute),
```

`ACTION_SCOPES`:

```typescript
  register_whatsapp_number: ["whatsapp:numbers.manage"],
  create_whatsapp_pairing: ["whatsapp:numbers.manage"],
  // A read, but class B: it polls Evolution rather than reading a local row.
  get_whatsapp_pairing: ["whatsapp:numbers.read"],
```

- [ ] **Step 7: Point the browser door at the use-case**

In `whatsapp-evolution-bridge/index.ts`, replace `createAndGetQr`'s body with a call to `registerNumber` plus `startPairing`, resolving the workspace as it already does through `resolveWorkspaceId` and passing `context.user.id` as `ownerUserId`. Delete the duplicated logic; do not leave both paths.

- [ ] **Step 8: Write the door-parity test**

Create `supabase/functions/_shared/whatsappPairingOps.parity.test.ts` asserting that the browser door and the `/v1` door produce the same `accountId` shape and the same refusal for a missing consent. This is the extraction-regression gate named in the hazard section.

- [ ] **Step 9: Run the full suite**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/
```

Expected: PASS, including the pre-existing `whatsapp-evolution-bridge` tests, which are the regression gate on this extraction.

- [ ] **Step 10: Update the contract and run the drift gates**

Add `POST /v1/whatsapp/numbers`, `POST /v1/whatsapp/numbers/{id}/pairing` and `GET /v1/whatsapp/numbers/{id}/pairing` to `docs/api/openapi.yaml`, documenting the `risk_consent` object and the `Idempotency-Key` requirement, then:

```bash
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
deno run --allow-read scripts/check-openapi-drift.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
```

- [ ] **Step 11: Commit**

```bash
git commit -- supabase/functions/_shared/whatsappPairingOps.ts \
               supabase/functions/_shared/whatsappPairingOps.test.ts \
               supabase/functions/_shared/whatsappPairingOps.parity.test.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.test.ts \
               supabase/functions/whatsapp-evolution-bridge/index.ts \
               supabase/functions/partner-api/v1/router.ts \
               supabase/functions/partner-api/router.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): register a WhatsApp number and drive pairing"
```

---

### Task 9: End a session, and run a history sync

**Files:**
- Modify: `supabase/functions/_shared/whatsappPairingOps.ts` (+ its test)
- Modify: `supabase/functions/partner-api/v1/whatsappNumbers.ts` (+ its test)
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts`
- Modify: `supabase/functions/partner-api/v1/router.ts`, `supabase/functions/partner-api/router.ts`

**Interfaces:**
- Consumes: everything Task 8 produced.
- Produces:
  - `endSession(ctx, accountId): Promise<{ ok: true; localDeactivated: boolean; remoteLogout: "succeeded" | "failed" | "skipped"; warnings: string[] } | { ok: false; reason: "not_found" | "wrong_mode" }>`
  - `startHistorySync(ctx, accountId): Promise<{ ok: true; claimed: true } | { ok: false; reason: "not_found" | "already_running" | "provider_failed" }>`
  - `historySyncStatus(ctx, accountId): Promise<{ ok: true; state: "idle" | "running" | "completed" | "partial" | "failed"; started_at: string | null; finished_at: string | null } | { ok: false; reason: "not_found" | "read_failed" }>`

**Two corrections from debate round 1.**

**History-sync state does not live in `account_metadata`.** It lives in
`whatsapp_evolution_instances` as `sync_started_at`, `last_sync_at` and
`last_sync_outcome`, and concurrency is controlled by the
`claim_whatsapp_history_sync` RPC. A metadata precheck cannot prove a job was
claimed — two callers both read "idle" and both start. Use the real lease, and
report the outcome the worker actually recorded, including `partial`. There is
no synthetic `job_id`: the account plus its lease is the identifier.

**Session teardown has three outcomes, not one.** The real
`disconnectWhatsAppAccount` distinguishes local deactivation from a remote
logout that failed or was skipped, and returns warnings. Collapsing that into
`{ ok: true }` tells a partner the remote WhatsApp session ended even when
Evolution was unreachable — a false success claim, and the endpoint's whole
purpose is to end that session.

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/_shared/whatsappPairingOps.test.ts`:

```typescript
import { endSession, startHistorySync } from "./whatsappPairing.ts";

Deno.test("ending a session for an unbound account is not found", async () => {
  const result = await endSession(
    { admin: adminStub(), workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" },
    "acct-elsewhere",
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "not_found");
});

Deno.test("ending a cloud_api session is refused as wrong_mode", async () => {
  const admin = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { id: "acct-1", connection_mode: "cloud_api", account_metadata: {} },
            error: null,
          });
        },
      };
    },
  };
  const result = await endSession(
    { admin, workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" },
    "acct-1",
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  // Logging out is an Evolution session concept. A Cloud API number has no
  // session to end, and silently succeeding would tell a partner it did.
  assertEquals(result.reason, "wrong_mode");
});

Deno.test("a second history sync while one runs is refused by the LEASE, not by a metadata read", async () => {
  let rpcCalled = false;
  const admin = {
    rpc(name: string) {
      if (name === "claim_whatsapp_history_sync") {
        rpcCalled = true;
        // The lease refuses the second caller. Two callers reading a metadata
        // flag would both see "idle" and both start.
        return Promise.resolve({ data: { claimed: false }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { id: "acct-1", connection_mode: "evolution_qr" },
            error: null,
          });
        },
      };
    },
  };
  const result = await startHistorySync(
    { admin, workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" },
    "acct-1",
  );
  assertEquals(rpcCalled, true, "concurrency must be decided by claim_whatsapp_history_sync");
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "already_running");
});

Deno.test("an unreachable Evolution reports the remote logout as failed, not as success", async () => {
  const admin = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        update() { return Promise.resolve({ error: null }); },
        maybeSingle() {
          return Promise.resolve({
            data: { id: "acct-1", connection_mode: "evolution_qr", account_metadata: {} },
            error: null,
          });
        },
      };
    },
  };
  const result = await endSession(
    { admin, workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" },
    "acct-1",
    // Injected fetcher that fails, standing in for Evolution being down.
    () => Promise.reject(new Error("ECONNREFUSED")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.localDeactivated, true);
  // The account is deactivated locally, but the WhatsApp session on the phone
  // is still live. Reporting plain success here is the false claim.
  assertEquals(result.remoteLogout, "failed");
  assertEquals(result.warnings.length > 0, true);
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappPairingOps.test.ts
```

Expected: FAIL — `endSession` and `startHistorySync` are not exported.

- [ ] **Step 3: Implement the three functions**

Lift `logoutInstance`, `syncPastChats` and `getSyncStatus` from `whatsapp-evolution-bridge/index.ts` into `whatsappPairing.ts`, changing the scoping unit from `userId` to `ctx.workspaceId` plus the bound-account check, and adding the two refusals the tests demand:

```typescript
export async function endSession(
  ctx: WhatsAppNumberContext,
  accountId: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "wrong_mode" | "provider_failed" }> {
  if (!ctx.accountIds.includes(accountId)) return { ok: false, reason: "not_found" };

  const { data, error } = await ctx.admin
    .from("social_accounts")
    .select("id, connection_mode, account_metadata")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", accountId)
    .maybeSingle();

  if (error) {
    console.error(`[usecase] end session read failed (request ${ctx.requestId}):`, error);
    return { ok: false, reason: "provider_failed" };
  }
  if (!data) return { ok: false, reason: "not_found" };
  if (data.connection_mode !== "evolution_qr") {
    console.warn(`[usecase] end session refused: mode ${data.connection_mode} (request ${ctx.requestId})`);
    return { ok: false, reason: "wrong_mode" };
  }

  // Body lifted verbatim from whatsapp-evolution-bridge.logoutInstance.
  return await callEvolutionLogout(ctx, data.id);
}
```

`endSession` returns the structured teardown outcome rather than `{ ok: true }`,
and the route renders it as `200` with a body naming what actually happened:

```json
{ "local_deactivated": true, "remote_logout": "failed",
  "warnings": ["Evolution unreachable; the session on the device may still be live"] }
```

Its idempotency claim settles as a success only when the operation completed as
reported. A `remote_logout: "failed"` is still a settled, deterministic outcome
— the partner learns the truth and may retry — so it settles rather than
marking indeterminate.

`startHistorySync` calls `claim_whatsapp_history_sync` and returns
`already_running` when the lease is not granted. `historySyncStatus` reads
`whatsapp_evolution_instances.sync_started_at`, `last_sync_at` and
`last_sync_outcome`, and maps `last_sync_outcome` onto the five reported
states. Read that table and RPC before writing either; the outcome vocabulary
is theirs, not this plan's.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappPairingOps.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Add the routes and the policy**

`V1_ROUTES`:

```typescript
  {
    pattern: "/v1/whatsapp/numbers/{id}/session",
    methods: { DELETE: withPartnerAuth("end_whatsapp_session", "C", endSessionRoute) },
  },
  {
    pattern: "/v1/whatsapp/numbers/{id}/history-sync",
    methods: {
      POST: withPartnerAuth("start_whatsapp_history_sync", "C", startHistorySyncRoute),
      GET: withPartnerAuth("get_whatsapp_history_sync", "A", historySyncStatusRoute),
    },
  },
```

`ACTION_SCOPES`:

```typescript
  end_whatsapp_session: ["whatsapp:numbers.manage"],
  start_whatsapp_history_sync: ["whatsapp:numbers.manage"],
  // Class A: reads a local metadata field, no provider call.
  get_whatsapp_history_sync: ["whatsapp:numbers.read"],
```

- [ ] **Step 6: Point the browser door at the use-case, then run the full suite**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/
```

- [ ] **Step 7: Update the contract, run the drift gates, and commit**

```bash
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
deno run --allow-read scripts/check-openapi-drift.ts
git commit -- supabase/functions/_shared/whatsappPairingOps.ts \
               supabase/functions/_shared/whatsappPairingOps.test.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.ts \
               supabase/functions/partner-api/v1/whatsappNumbers.test.ts \
               supabase/functions/whatsapp-evolution-bridge/index.ts \
               supabase/functions/partner-api/v1/router.ts \
               supabase/functions/partner-api/router.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): end a WhatsApp session and run a history sync"
```

---

### Task 10: Read and update the business profile

**Files:**
- Create: `supabase/functions/_shared/whatsappProfileOps.ts` (+ its test)
- Create: `supabase/functions/partner-api/v1/whatsappProfile.ts` (+ its test)
- Modify: `supabase/functions/whatsapp-profile/index.ts`
- Modify: `supabase/functions/partner-api/v1/router.ts`, `supabase/functions/partner-api/router.ts`

**Interfaces:**
- Consumes: `WhatsAppNumberContext` (Task 7); `assertEntitled` (Task 6).
- Produces:
  - `interface BusinessProfile { about: string | null; address: string | null; description: string | null; email: string | null; websites: string[]; vertical: string | null; profile_picture_url: string | null; }`
  - `getBusinessProfile(ctx, accountId): Promise<{ ok: true; profile: BusinessProfile } | { ok: false; reason: "not_found" | "provider_failed" }>`
  - `updateBusinessProfile(ctx, accountId, patch: Partial<BusinessProfile>): Promise<{ ok: true; profile: BusinessProfile } | { ok: false; reason: "not_found" | "invalid_patch" | "provider_failed" }>`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/whatsappProfileOps.test.ts`:

```typescript
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { updateBusinessProfile } from "./whatsappProfile.ts";

const CTX = { workspaceId: "ws-1", accountIds: ["acct-1"], requestId: "req-1" };

function adminStub() {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { id: "acct-1", access_token: "tok", platform_user_id: "1555", connection_mode: "cloud_api" },
            error: null,
          });
        },
      };
    },
  };
}

Deno.test("an empty patch is rejected rather than issuing a no-op provider write", async () => {
  const result = await updateBusinessProfile({ ...CTX, admin: adminStub() }, "acct-1", {});
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "invalid_patch");
});

Deno.test("a patch is a PATCH: absent fields are not blanked", async () => {
  const sent: Record<string, unknown>[] = [];
  const result = await updateBusinessProfile(
    { ...CTX, admin: adminStub() },
    "acct-1",
    { about: "New about" },
    (payload) => { sent.push(payload); return Promise.resolve({ ok: true }); },
  );
  assertEquals(result.ok, true);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].about, "New about");
  // The bug this pins: a partial update that sends every field would blank
  // address, description, email and websites. AGENTS.md reviewer rule 3
  // records this exact failure shape happening once already.
  assertEquals("address" in sent[0], false);
  assertEquals("description" in sent[0], false);
});

Deno.test("an unbound account is not found", async () => {
  const result = await updateBusinessProfile({ ...CTX, admin: adminStub() }, "acct-other", { about: "x" });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.reason, "not_found");
});
```

The second test is the important one. Blanking-by-partial-write is a documented
production incident in this repository.

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto \
  supabase/functions/_shared/whatsappProfileOps.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

Create `supabase/functions/_shared/whatsappProfileOps.ts`, lifting the provider calls from `whatsapp-profile/index.ts`. The update builds its provider payload from **only the keys present in the patch**:

```typescript
const PATCHABLE = ["about", "address", "description", "email", "websites", "vertical"] as const;

const payload: Record<string, unknown> = {};
for (const key of PATCHABLE) {
  if (Object.prototype.hasOwnProperty.call(patch, key)) payload[key] = patch[key];
}
if (Object.keys(payload).length === 0) return { ok: false, reason: "invalid_patch" };
```

- [ ] **Step 4: Run the test, add the routes and the policy**

`V1_ROUTES`:

```typescript
  {
    pattern: "/v1/whatsapp/numbers/{id}/profile",
    methods: {
      GET: withPartnerAuth("get_whatsapp_profile", "B", getProfileRoute),
      PATCH: withPartnerAuth("update_whatsapp_profile", "C", updateProfileRoute),
    },
  },
```

`ACTION_SCOPES`:

```typescript
  get_whatsapp_profile: ["whatsapp:profile.read"],
  update_whatsapp_profile: ["whatsapp:profile.manage"],
```

- [ ] **Step 5: Point the browser door at the use-case, run the full suite, run the drift gates, commit**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/
deno run --allow-read scripts/check-openapi-drift.ts
deno run --allow-read --allow-write scripts/generate-postman.ts
deno run --allow-read --allow-write scripts/generate-agent-context.ts
deno run --allow-read scripts/check-openapi-drift.ts
git commit -- supabase/functions/_shared/whatsappProfileOps.ts \
               supabase/functions/_shared/whatsappProfileOps.test.ts \
               supabase/functions/partner-api/v1/whatsappProfile.ts \
               supabase/functions/partner-api/v1/whatsappProfile.test.ts \
               supabase/functions/whatsapp-profile/index.ts \
               supabase/functions/partner-api/v1/router.ts \
               supabase/functions/partner-api/router.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): read and update the WhatsApp business profile"
```

---

### Task 11: Connection event types and their producers

**Files:**
- Create: `supabase/migrations/20260910110000_partner_connection_events.sql`
- Modify: `supabase/functions/_shared/partnerWebhookEvents.ts`
- Modify: `supabase/functions/_shared/partnerWebhookEvents.test.ts`
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts` (`reconcileAccountConnection`)

**Interfaces:**
- Consumes: `enqueuePartnerWebhookEvent` from `_shared/partnerWebhookEvents.ts`.
- Produces: certified event types `whatsapp_number.connected`, `whatsapp_number.disconnected`, `whatsapp_number.pairing_expired`, `history_sync.completed`.

- [ ] **Step 1: Write the failing test**

In `supabase/functions/_shared/partnerWebhookEvents.test.ts`, extend the existing exact-list assertion at line 222 to include the four new types, in the order they are added. That test asserts the whole array, so it fails until the source matches.

```typescript
  assertEquals(CERTIFIED_EVENT_TYPES, [
    "webhook.test",
    "message.received",
    "message.accepted",
    "message.delivered",
    "message.read",
    "message.failed",
    "account.reauthorization_required",
    // Verified 2026-09-10: the live list ends here, at post.scheduled. There
    // is no post.unscheduled, despite that alias action existing.
    "post.scheduled",
    "whatsapp_number.connected",
    "whatsapp_number.disconnected",
    "whatsapp_number.pairing_expired",
    "history_sync.completed",
  ]);
```

Read the current array first and preserve every existing entry in its existing
position. Reordering it is a breaking change for any partner matching on index.

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-read --no-check --node-modules-dir=auto \
  supabase/functions/_shared/partnerWebhookEvents.test.ts
```

Expected: FAIL — arrays differ.

- [ ] **Step 3: Add the four types**

Append to `CERTIFIED_EVENT_TYPES` in `_shared/partnerWebhookEvents.ts`, with a comment matching the file's existing style recording the phase and the producer.

- [ ] **Step 4: Write the migration that widens the database constraint**

`partner_webhooks` carries a CHECK constraint, `partner_webhooks_events_certified`, restricting a subscription's `events` to the certified list. It must be dropped and re-added, exactly as `20260902150000_partner_api_posts.sql` does. Create `supabase/migrations/20260910110000_partner_connection_events.sql`:

```sql
-- Connection lifecycle events (spec §8).
--
-- Follows 20260902150000's shape exactly: assert the constraint exists, drop
-- it, re-add it widened. Asserting first means a mis-ordered migration fails
-- loudly instead of silently creating a constraint that permits everything.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'partner_webhooks_events_certified'
  ) THEN
    RAISE EXCEPTION 'partner_webhooks_events_certified is missing -- apply 20260902130000 first';
  END IF;

  ALTER TABLE public.partner_webhooks
    DROP CONSTRAINT partner_webhooks_events_certified;

  -- cardinality(events) > 0 is part of the EXISTING predicate. Dropping it
  -- while widening the array would let a subscription hold no events at all,
  -- which is a subscription that can never fire and never errors. Copy the
  -- whole predicate, not just the list.
  ALTER TABLE public.partner_webhooks
    ADD CONSTRAINT partner_webhooks_events_certified
    CHECK (cardinality(events) > 0 AND events <@ ARRAY[
      -- Every pre-existing type, copied verbatim from 20260902150000. Read
      -- that migration and reproduce its list exactly before appending.
      'webhook.test',
      'message.received',
      'message.accepted',
      'message.delivered',
      'message.read',
      'message.failed',
      'account.reauthorization_required',
      'post.scheduled',
      -- New in this migration.
      'whatsapp_number.connected',
      'whatsapp_number.disconnected',
      'whatsapp_number.pairing_expired',
      'history_sync.completed'
    ]::TEXT[]);
END $$;
```

Re-read the live constraint before writing this and reproduce **its entire
predicate**, not the sketch above. Confirm the `cardinality` clause is worded
exactly as it is today; a `>= 1` where the original says `> 0` is harmless, but
a silently different predicate is how a constraint stops meaning what its name
says.

**Verified 2026-09-10:** the live certified list is exactly those eight entries,
ending at `post.scheduled`. `post.unscheduled` is **not** certified, despite
appearing in `V1_ROUTES` as an alias action — the action exists, the event does
not. Do not add it here.

Re-read `20260902150000_partner_api_posts.sql` before writing the migration. If
its list disagrees with the eight above, the migration file is right and this
plan is stale — say so and use the file. Getting this wrong in either direction
is severe: an omitted entry **narrows** the constraint and breaks every live
subscription holding that event, and an invented entry lets a subscription hold
an event `CERTIFIED_EVENT_TYPES` will never emit.

- [ ] **Step 5: Wire the producer**

**Correction from debate round 1: `reconcileAccountConnection` is NOT the one
convergence point.** The webhook path calls `syncEvolutionAccountConnection`
directly and never reaches it, so an emitter placed there alone fires only for
the poll — and a webhook-first activation makes the later poll observe no
transition and emit nothing at all. That is the same shape as the Direct QR
activation bug already in this repository's history.

**Certify an event only once every writer that can cause its transition emits
it.** An event type in `CERTIFIED_EVENT_TYPES` is a promise a partner may
subscribe to; certifying one with a partial producer publishes a promise
nothing keeps, and the gap is invisible until a customer reports missing
events.

**The convergence point does exist — it is
`syncEvolutionAccountConnection` in `_shared/evolutionQrAccount.ts`**, verified
2026-09-10. Both writers reach it:

| Writer | Path |
|---|---|
| `whatsapp-evolution-bridge/index.ts` lines 323 and 326 | via `reconcileAccountConnection` |
| `whatsapp-evolution-webhook/index.ts` line 7 | imports and calls it directly |

`reconcileAccountConnection` is one caller of it, which is why an emitter there
covers only the poll. Emitting inside `syncEvolutionAccountConnection` covers
both.

So for each of the four types:

1. Enumerate every writer that can cause the transition.
2. Emit from the **single shared helper** those writers all call, or from a
   database trigger on the row whose change *is* the transition. Prefer the
   trigger, exactly as `post.scheduled` does via migration `20260902150000`: it
   fires for every writer, including ones added later that nobody remembers to
   update. `social_accounts` already carries triggers
   (`update_social_accounts_updated_at`), so this is established ground.
3. Only then add the type to `CERTIFIED_EVENT_TYPES`.

`whatsapp_number.connected` and `whatsapp_number.disconnected` are transitions
of `social_accounts.is_active` on a WhatsApp row. A trigger comparing `OLD` and
`NEW` is both transactional and writer-agnostic, and is the recommended choice;
`syncEvolutionAccountConnection` is the fallback if a trigger proves impractical.

`history_sync.completed` belongs on `whatsapp_evolution_instances.last_sync_outcome`,
where the worker records its result.

`whatsapp_number.pairing_expired` has **no** authoritative writer today — QR
expiry is observed by a poll, not recorded as a transition. Either give it one,
or leave it uncertified and out of this task. Do not certify an event whose
producer does not exist.

**Activation and enqueue must not be separate commits.** A crash between them
loses the event silently. A trigger makes them one transaction; an
application-code emitter does not.

The sketch below shows the emit payload shape only. Do not take its placement
as the design — the placement is what this correction is about:

```typescript
  // Emit at the RECONCILIATION point, not at each caller. The webhook and the
  // status poll both land here, and an emitter at either caller alone would
  // silently miss the other path -- which is how Direct QR activation was
  // missed once already.
  if (wasInactive && nowActive) {
    await enqueuePartnerWebhookEvent(admin, {
      workspaceId,
      eventType: "whatsapp_number.connected",
      // Identifies the TRANSITION, not the resource. A number that
      // disconnects and reconnects produces two occurrences, and keying on
      // the account id alone would make the outbox drop the second as a
      // duplicate of the first.
      occurrenceId: `whatsapp_number.connected:${socialAccountId}:${connectedAt}`,
      payload: { account_id: socialAccountId, phone_number: resolvedNumber },
      platform: "whatsapp",
      accountId: socialAccountId,
    });
  }
```

**Verified signature (2026-09-10):** `enqueuePartnerWebhookEvent(admin, occurrence)`
where `WebhookEventOccurrence` is
`{ workspaceId, eventType, occurrenceId, payload, platform: string | null, accountId: string | null, occurredAt?: string }`.

Three things an implementer gets wrong here if they skip reading it:

- The account field is **`accountId`**, not `socialAccountId`.
- **`occurrenceId` is required** and must identify the transition. The module's
  own comment records why: `message.delivered` and `message.read` for one
  message share a provider id, so a resource-keyed occurrence silently collides
  and the outbox drops the event it exists to guarantee.
- `platform` and `accountId` are **narrowing filters**, not metadata. Omitting
  them means null, which the fan-out reads as "not specific to any account", so
  the event reaches subscriptions that filtered for a different number.

- [ ] **Step 6: Run the full suite and the drift gates**

```bash
deno test --allow-env --allow-net --allow-read --allow-write \
  --no-check --node-modules-dir=auto supabase/functions/
deno run --allow-read scripts/check-openapi-drift.ts
```

The event catalogue appears in the contract's webhook section; update
`docs/api/openapi.yaml` and regenerate before the drift check.

- [ ] **Step 7: Commit**

```bash
git commit -- supabase/migrations/20260910110000_partner_connection_events.sql \
               supabase/functions/_shared/partnerWebhookEvents.ts \
               supabase/functions/_shared/partnerWebhookEvents.test.ts \
               supabase/functions/whatsapp-evolution-bridge/index.ts \
               docs/api/openapi.yaml \
               docs/api/postman docs/developer/AGENT-CONTEXT.md \
  -m "feat(partner-api): certify WhatsApp connection lifecycle events"
```

---

### Task 12: Replace the stale PRD banner

**Files:**
- Modify: `POSTORA_PARTNER_API_PRD_v1.0.md`

- [ ] **Step 1: Replace the banner**

The current banner says "STATUS: DEFERRED — DO NOT IMPLEMENT YET" and lists five open contract questions, four of which shipped long ago. Replace the whole block with:

```markdown
> # STATUS: ACTIVE — phases 5, 7, 8 and 10 are merged; section expansion is in progress
>
> This PRD describes the v1 target for a partner API that **already exists and
> is live**. Do not create a parallel implementation; extend these modules:
>
> ```text
> supabase/functions/partner-api/
> supabase/functions/_shared/partnerApiKeys.ts
> supabase/functions/_shared/partnerApiMetering.ts
> supabase/functions/_shared/partnerApiIdempotency.ts
> ```
>
> **The canonical contract is `docs/api/openapi.yaml`**, guarded in CI by
> `scripts/check-openapi-drift.ts` against `docs/api/openapi.baseline.yaml`.
> Earlier revisions of this document said the contract directory did not exist.
> That was wrong.
>
> **The five "open contract questions" this document used to list are closed.**
> Account selection is `v1/binding.ts`; webhook HMAC is
> `process-partner-webhooks/worker.ts`; event naming is `CERTIFIED_EVENT_TYPES`;
> idempotency is `_shared/partnerApiIdempotency.ts`.
>
> The legacy-to-v1 scope mapping is **capability pinning**, not exclusion. A
> legacy scope grants exactly the capability it held when D3 froze it and no
> new one: `whatsapp:templates.read` satisfies `list_templates` through either
> door, `whatsapp:template.send` satisfies `send_template`, and
> `whatsapp:webhooks.manage` — which authorised nothing — satisfies nothing.
> Every capability added after the freeze takes generic scopes only.
> `partnerScopes.test.ts` asserts that pinning. Removing an existing legacy
> grant is a breaking change and needs its own review.
>
> Current work: `docs/superpowers/specs/2026-09-10-partner-api-sections-design.md`.
```

- [ ] **Step 2: Verify no other document repeats the stale claim**

```bash
grep -rn "DEFERRED\|does not exist\|not yet created" \
  POSTORA_PARTNER_API_PRD_v1.0.md docs/api/README.md ARCHITECTURE.md | head
```

Fix any survivors in the same commit. A fact lives in exactly one place in this
repository, and a stale copy is a documented failure mode here.

- [ ] **Step 3: Commit**

```bash
git commit -- POSTORA_PARTNER_API_PRD_v1.0.md \
  -m "docs(partner-api): the PRD banner said deferred; four of its five open questions shipped"
```

---

## Phases 2 to 5

Phase 1 above is the executable scope of this plan. Phases 2 to 5 follow the
spec's §11 table and each gets its own plan document, generated from the same
spec at the fidelity of the tasks above, when its turn arrives:

| Phase | Plan document | Covers |
|---|---|---|
| 2 | `2026-XX-XX-partner-api-conversations.md` | spec §7.2, §7.3 |
| 3 | `2026-XX-XX-partner-api-broadcasts.md` | spec §7.4 |
| 4 | `2026-XX-XX-partner-api-comments.md` | spec §7.5, comment events |
| 5 | `2026-XX-XX-partner-api-automation-agents.md` | spec §6, §7.6, §7.7 |

The spec fixes every contract decision those phases need, so they sequence
rather than design. Nothing in phase 1 forecloses them: the extraction pattern,
the entitlement check, the binding resolution and the contract ritual are all
established here and reused unchanged.

