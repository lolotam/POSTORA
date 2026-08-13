# WhatsApp Partner API Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external product's backend send an approved WhatsApp template through a client business's Postora-connected number, authenticated by a hashed, workspace-scoped, revocable, metered API key.

**Architecture:** A new `partner-api` edge function is an *auth adapter* — it authenticates a key, checks scopes, meters usage, claims an idempotency slot, then delegates to shared WhatsApp operations that `messaging-api` also calls. Authorization is independent per door: `messaging-api` resolves a human workspace *role*, `partner-api` resolves key *scopes*. Cross-workspace misuse is made structurally impossible by a composite foreign key rather than by application checks.

**Tech Stack:** Deno edge functions (`supabase/functions/`), PostgreSQL migrations, `@supabase/supabase-js@2.49.4`, Deno's std assert for tests, Meta Graph API v22.0.

**Spec:** `docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md`

## Scope: this is Plan 1 of 3

The spec's v1 covers three independently shippable subsystems. This plan is the foundation the other two depend on. Do **not** implement the others here.

| Plan | Contents | Status |
|---|---|---|
| **1. Partner API foundation** (this plan) | Migrations, key auth, scopes, metering, idempotency, shared ops, `get_status` / `send_template` / `list_templates` | **This document** |
| 2. Webhook outbox | `whatsapp_webhook_deliveries`, transactional enqueue, retry worker, `message.status` dispatch, `register_webhook` | Later plan |
| 3. Integrations UI + Danat provider swap | Key management screen; `sendWithWhatsApp` rewrite in the Danat repo | Later plans |

## Global Constraints

Exact values, copied from the spec and verified against the codebase — every task inherits these.

- **Tenancy tables are `workspaces` and `workspace_members`.** Never `whatsapp_workspaces` / `whatsapp_workspace_members`; those do not exist.
- **`social_accounts.workspace_id` exists and is nullable.** All 4 WhatsApp rows are populated; 2 non-WhatsApp rows are NULL. Never add a global `NOT NULL`.
- **Key format:** `pk_live_` + 32 random bytes, base62. Returned once. Stored only as SHA-256 hex in `key_hash`.
- **v1 scopes, exactly three:** `whatsapp:template.send`, `whatsapp:templates.read`, `whatsapp:webhooks.manage`.
- **Every key is pinned:** `partner_api_keys.social_account_id` is `NOT NULL`.
- **Quota is consumed only by a Meta-accepted send.** Never by idempotent replays or 4xx rejections.
- **`rate_limited` is retryable; `quota_exceeded` is not.**
- **Do not use `api_logs` for rate limiting.** Its schema is `(user_id, endpoint, method, status_code, …)` with no key column, and the existing limiter in `ecommerce-whatsapp-api/index.ts:120-146` is a non-atomic count-then-insert. `api_logs` stays for auditing only.
- **Graph API base:** `https://graph.facebook.com/v22.0` (from `GRAPH_VERSION` in `messaging-api/index.ts:17`).
- **Never log** message bodies, access tokens, or full API keys. Log `key_prefix` only.
- **Deno test imports:** `https://deno.land/std@0.208.0/assert/mod.ts`, matching every existing `*.test.ts` under `supabase/functions/`.
- **Migrations are forward-only.** Never edit an applied migration file.

---

### Task 1: Migration — partner API tables and database-enforced tenancy

**Files:**
- Create: `supabase/migrations/20260813120000_partner_api_foundation.sql`

**Interfaces:**
- Consumes: existing `workspaces`, `workspace_members`, `social_accounts`, `auth.users`.
- Produces: tables `partner_api_keys`, `partner_api_idempotency`, `partner_api_usage`, `partner_api_rate_buckets`; RPCs `reserve_partner_quota(uuid) -> (allowed boolean, usage_count integer)`, `release_partner_quota(uuid)`, `consume_partner_rate(uuid, integer) -> boolean`, `touch_partner_key(uuid)`.

> **The composite FK was proven empirically before this plan was written**
> (scratch database on the production Postgres, 2026-08-13). The concern worth
> checking was that Postgres's default `MATCH SIMPLE` skips enforcement when a
> referencing column is NULL — which would have made this control decorative.
> It does not apply here, because **both referencing columns are `NOT NULL`**.
> Measured results:
>
> | Case | Result |
> |---|---|
> | `UNIQUE (id, workspace_id)` where `workspace_id` is nullable | valid FK target |
> | Key whose `workspace_id` matches the account's | `INSERT` succeeds |
> | Key pointing at **another workspace's** account | **rejected**: `violates foreign key constraint` |
> | Key pointing at an account whose `workspace_id` is NULL | **rejected** — an unscoped account cannot be pinned at all |
> | Deleting the account | cascades, key removed |
>
> `update_updated_at_column` is confirmed present in production.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260813120000_partner_api_foundation.sql`:

```sql
-- Partner API: machine-authenticated, workspace-scoped access to WhatsApp sending.
-- Keys are hashed at rest and pinned to exactly one social account.

-- A composite FK needs a matching unique constraint on the referenced side.
-- Redundant with the PK, but it is what makes (id, workspace_id) referenceable.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_id_workspace_key UNIQUE (id, workspace_id);

-- WhatsApp accounts must be workspace-scoped. All 4 live rows already are;
-- other platforms are deliberately left alone.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_whatsapp_needs_workspace
  CHECK (platform <> 'whatsapp' OR workspace_id IS NOT NULL) NOT VALID;

-- Validate in the migration itself. Leaving it NOT VALID would enforce new
-- writes but leave the constraint catalogued as unvalidated in production,
-- so nothing would ever prove the existing rows comply. All 4 whatsapp rows
-- were verified populated on 2026-08-13; if this fails, a non-compliant row
-- appeared since and must be backfilled before deploying.
ALTER TABLE public.social_accounts
  VALIDATE CONSTRAINT social_accounts_whatsapp_needs_workspace;

CREATE TABLE public.partner_api_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  social_account_id   UUID NOT NULL,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,
  name                TEXT NOT NULL,
  key_prefix          TEXT NOT NULL,
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  monthly_quota       INTEGER,
  current_usage_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The control that makes cross-workspace key misuse impossible in the database.
  CONSTRAINT partner_api_keys_account_in_workspace
    FOREIGN KEY (social_account_id, workspace_id)
    REFERENCES public.social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- Referenced by partner_api_usage's composite FK below.
ALTER TABLE public.partner_api_keys
  ADD CONSTRAINT partner_api_keys_id_workspace_key UNIQUE (id, workspace_id);

CREATE INDEX partner_api_keys_hash_active_idx
  ON public.partner_api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX partner_api_keys_workspace_idx
  ON public.partner_api_keys (workspace_id);

CREATE TABLE public.partner_api_idempotency (
  key_id          UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','indeterminate')),
  http_status     INTEGER,
  response_body   JSONB,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX partner_api_idempotency_expiry_idx
  ON public.partner_api_idempotency (expires_at);

-- The two foreign keys below are each individually valid but, declared
-- separately, would allow a usage row whose workspace_id is not the key's
-- workspace -- silently corrupting per-workspace billing and reporting.
-- A composite FK against (id, workspace_id) makes the pairing impossible,
-- the same technique used for account tenancy on partner_api_keys.
CREATE TABLE public.partner_api_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT false,
  http_status  INTEGER NOT NULL,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT partner_api_usage_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX partner_api_usage_ws_time_idx
  ON public.partner_api_usage (workspace_id, created_at DESC);
CREATE INDEX partner_api_usage_key_time_idx
  ON public.partner_api_usage (key_id, created_at DESC);

-- Per-key, per-minute rate limit bucket. Counting rows in the usage ledger
-- would be the same non-atomic count-then-insert the spec rejects: concurrent
-- requests all read the same old count and all pass. INSERT .. ON CONFLICT
-- DO UPDATE .. RETURNING is a single atomic statement instead.
CREATE TABLE public.partner_api_rate_buckets (
  key_id       UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE OR REPLACE FUNCTION public.consume_partner_rate(p_key_id UUID, p_limit INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, date_trunc('minute', now()), 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

-- Quota is RESERVED before the send and SETTLED after, because the plan
-- promises quota is consumed only by a Meta-accepted send. A single
-- increment-then-check would charge the partner for 4xx rejections too.
--
-- reserve: increments and reports whether the reservation is within quota.
-- release: decrements, called when Meta definitely rejected the send.
-- Nothing is released for an indeterminate send — it may have been delivered.
CREATE OR REPLACE FUNCTION public.reserve_partner_quota(p_key_id UUID)
RETURNS TABLE (allowed BOOLEAN, usage_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quota INTEGER;
  v_count INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET current_usage_count =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.current_usage_count + 1 END,
         last_reset_at = date_trunc('month', now()),
         last_used_at  = now()
   WHERE k.id = p_key_id
   RETURNING k.monthly_quota, k.current_usage_count
        INTO v_quota, v_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_quota IS NULL OR v_count <= v_quota), v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET current_usage_count = GREATEST(current_usage_count - 1, 0)
   WHERE id = p_key_id;
$$;

-- Touch last_used_at for non-send actions, which never reserve quota.
CREATE OR REPLACE FUNCTION public.touch_partner_key(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys SET last_used_at = now() WHERE id = p_key_id;
$$;

-- The idempotency claim lives in SQL, not in the edge function.
--
-- Doing it in JS needs insert -> catch 23505 -> re-read, which cannot express
-- "take over a lease that expired" without another race. One statement here
-- is atomic, handles stale leases and row expiry in the same place, and is
-- directly testable with psql.
--
-- Returns one row: outcome in
--   claimed | replay | conflict | in_progress | indeterminate
CREATE OR REPLACE FUNCTION public.claim_partner_idempotency(
  p_key_id UUID,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  -- MUST exceed the maximum end-to-end send deadline, with margin.
  -- The auto-registration path allows send(30s) + register(15s) + retry(30s)
  -- = 75s. A 60s lease would let a SECOND caller take over a request that is
  -- still in flight, and both would send to the same customer. 300s leaves
  -- room for that worst case plus retries and clock skew; the cost of a lease
  -- that is too long is only a delayed recovery, while one that is too short
  -- is a duplicate message.
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (outcome TEXT, http_status INTEGER, response_body JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.partner_api_idempotency%ROWTYPE;
BEGIN
  -- Opportunistic pruning: expired rows must not resurrect as false replays.
  DELETE FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND expires_at < now();

  INSERT INTO public.partner_api_idempotency
    (key_id, idempotency_key, request_hash, state, locked_until)
  VALUES
    (p_key_id, p_idempotency_key, p_request_hash, 'processing',
     now() + make_interval(secs => p_lease_seconds))
  ON CONFLICT (key_id, idempotency_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB;
    RETURN;
  END IF;

  -- Lock the existing row so two concurrent duplicates cannot both take over
  -- the same expired lease.
  SELECT * INTO v_row
    FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Pruned between the insert and the read; retry is safe and cheap.
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB;
    RETURN;
  END IF;

  IF v_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::INTEGER, NULL::JSONB;
    RETURN;
  END IF;

  IF v_row.state = 'completed' THEN
    RETURN QUERY SELECT 'replay'::TEXT, v_row.http_status, v_row.response_body;
    RETURN;
  END IF;

  IF v_row.state = 'indeterminate' THEN
    -- The first attempt may have reached Meta. Never silently re-send.
    RETURN QUERY SELECT 'indeterminate'::TEXT, NULL::INTEGER, NULL::JSONB;
    RETURN;
  END IF;

  -- state = 'processing'. A live lease means a genuine concurrent duplicate;
  -- an expired one means the previous attempt died before settling, so this
  -- caller takes it over rather than wedging the key forever.
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB;
    RETURN;
  END IF;

  UPDATE public.partner_api_idempotency
     SET locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_partner_rate(UUID, INTEGER) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.reserve_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.release_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.touch_partner_key(UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.consume_partner_rate(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_partner_key(UUID) TO service_role;

ALTER TABLE public.partner_api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_idempotency  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_rate_buckets ENABLE ROW LEVEL SECURITY;

-- Idempotency and usage are service-role only: RLS on, no policies, no grants.

-- Keys: workspace admins/owners may read metadata and revoke. Never the hash.
CREATE POLICY "Workspace admins read partner keys"
ON public.partner_api_keys FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id = partner_api_keys.workspace_id
     AND m.user_id = auth.uid()
     AND m.role IN ('owner','admin')
));

-- No UPDATE policy: revocation goes through revoke_partner_key() below, so
-- there is no path by which a client can clear revoked_at.

-- Column-level grants, mirroring the mcp_oauth_tokens precedent: key_hash is
-- never selectable by a client, and only revocation fields are writable.
REVOKE ALL ON public.partner_api_keys FROM authenticated;
GRANT SELECT (id, workspace_id, social_account_id, created_by, revoked_by,
              revoked_reason, name, key_prefix, scopes, rate_limit_per_min,
              monthly_quota, current_usage_count, last_reset_at, last_used_at,
              expires_at, revoked_at, created_at, updated_at)
  ON public.partner_api_keys TO authenticated;

-- Revocation is a one-way door, so it is NOT a granted UPDATE.
-- Granting UPDATE(revoked_at) would let an admin set it back to NULL and
-- silently un-revoke a key that was revoked because it leaked. This function
-- refuses to act on an already-revoked key and stamps the actor server-side.
CREATE OR REPLACE FUNCTION public.revoke_partner_key(p_key_id UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = k.workspace_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner','admin'));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.revoke_partner_key(UUID, TEXT) TO authenticated;

CREATE TRIGGER update_partner_api_keys_updated_at
BEFORE UPDATE ON public.partner_api_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

- [ ] **Step 2: Rehearse on a throwaway database, not production**

Local `supabase start` is broken in this project, so rehearse inside the production container against a scratch database:

```bash
# via ssh-contabo-mcp. Separate invocations: psql wraps multiple -c statements
# in one transaction, and CREATE/DROP DATABASE cannot run inside a transaction
# block. Verified empirically — the combined form fails.
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -q -c "DROP DATABASE IF EXISTS rehearse;"
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -q -c "CREATE DATABASE rehearse;"
```

Expected: both succeed. Do NOT use `TEMPLATE postgres` — cloning the live
database fails while it has active connections.

- [ ] **Step 3: Apply the migration to the scratch database**

```bash
docker exec -i postorasupabase-supabase-j8axyh-supabase-db \
  psql -U postgres -d rehearse -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260813120000_partner_api_foundation.sql
```

Expected: no errors. If `update_updated_at_column` is missing in the scratch DB, that is a template artifact — confirm it exists in `postgres` before treating it as a real failure.

- [ ] **Step 4: Prove the composite FK actually blocks cross-workspace keys**

This is the single most important assertion in the plan. Run against `rehearse`:

```sql
-- Two workspaces, one account belonging to workspace A.
INSERT INTO workspaces (id, owner_id, name, is_personal)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM auth.users LIMIT 1), 'ws-a', false),
       ('22222222-2222-2222-2222-222222222222',
        (SELECT id FROM auth.users LIMIT 1), 'ws-b', false);

-- access_token is NOT NULL on social_accounts; omitting it fails before the
-- FK is ever exercised.
INSERT INTO social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id)
VALUES ('33333333-3333-3333-3333-333333333333',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '1234567890', 'test-token',
        '11111111-1111-1111-1111-111111111111');

-- MUST FAIL: key in workspace B pointing at workspace A's account.
INSERT INTO partner_api_keys (workspace_id, social_account_id, name, key_prefix, key_hash)
VALUES ('22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333', 'bad', 'pk_live_bad', 'hash-b');
```

Expected: the last statement fails with
`insert or update on table "partner_api_keys" violates foreign key constraint "partner_api_keys_account_in_workspace"`.

Then confirm the matching-workspace insert **succeeds**:

```sql
INSERT INTO partner_api_keys (workspace_id, social_account_id, name, key_prefix, key_hash)
VALUES ('11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333', 'good', 'pk_live_good', 'hash-a');
```

Expected: `INSERT 0 1`.

- [ ] **Step 5: Verify the CHECK constraint does not break existing data**

```sql
ALTER TABLE social_accounts VALIDATE CONSTRAINT social_accounts_whatsapp_needs_workspace;
```

Expected: succeeds — all 4 WhatsApp rows have `workspace_id`. If it fails, stop: a WhatsApp account was created without a workspace since the survey, and it must be backfilled before continuing.

- [ ] **Step 6: Drop the scratch database**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -c "DROP DATABASE rehearse;"
```

- [ ] **Step 7: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add partner key, idempotency, usage tables with DB-enforced tenancy" -- supabase/migrations/20260813120000_partner_api_foundation.sql
```

---

### Task 2: Key generation, hashing, and authentication

**Files:**
- Create: `supabase/functions/_shared/partnerApiKeys.ts`
- Create: `supabase/functions/_shared/partnerApiKeys.test.ts`

**Interfaces:**
- Consumes: `partner_api_keys` from Task 1.
- Produces:
  - `generatePartnerKey(): { key: string; prefix: string; hash: string }`
  - `hashPartnerKey(key: string): Promise<string>`
  - `authenticatePartnerKey(client, presentedKey, now?): Promise<PartnerKeyRecord>`
  - `assertScope(record: PartnerKeyRecord, scope: PartnerScope): void`
  - `class PartnerAuthError extends Error { code: string; status: number }`
  - `type PartnerScope = "whatsapp:template.send" | "whatsapp:templates.read" | "whatsapp:webhooks.manage"`
  - `interface PartnerKeyRecord { id, workspaceId, socialAccountId, keyPrefix, scopes, rateLimitPerMin, monthlyQuota, expiresAt, revokedAt }`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/partnerApiKeys.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assertScope,
  authenticatePartnerKey,
  generatePartnerKey,
  hashPartnerKey,
  PartnerAuthError,
} from "./partnerApiKeys.ts";

const ACTIVE_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send"],
  rate_limit_per_min: 60,
  monthly_quota: 1000,
  expires_at: null,
  revoked_at: null,
};

/**
 * Stub of the supabase-js query chain that actually HONOURS the filter.
 *
 * A stub that returns its row regardless of the `.eq()` argument would pass
 * even if authenticatePartnerKey looked up the wrong column or the plaintext
 * key instead of its hash. Recording the filter and matching on it is what
 * makes these assertions mean something.
 */
function stubClient(row: Record<string, unknown> | null, expectedHash?: string) {
  const filters: Record<string, unknown> = {};
  let table = "";
  return {
    from(name: string) {
      table = name;
      return {
        select() { return this; },
        eq(column: string, value: unknown) { filters[column] = value; return this; },
        maybeSingle() {
          if (table !== "partner_api_keys") {
            return Promise.resolve({ data: null, error: null });
          }
          // The module must query by key_hash, never by the raw key.
          if (expectedHash !== undefined && filters.key_hash !== expectedHash) {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("generatePartnerKey produces a pk_live_ key whose prefix and hash match", async () => {
  const { key, prefix, hash } = await generatePartnerKey();
  assertEquals(key.startsWith("pk_live_"), true);
  assertEquals(prefix, key.slice(0, 12));
  assertEquals(hash, await hashPartnerKey(key));
});

Deno.test("generatePartnerKey never repeats a key", async () => {
  const first = await generatePartnerKey();
  const second = await generatePartnerKey();
  assertNotEquals(first.key, second.key);
});

Deno.test("authenticatePartnerKey returns the record for an active key", async () => {
  const record = await authenticatePartnerKey(stubClient(ACTIVE_ROW), "pk_live_whatever");
  assertEquals(record.id, "key-1");
  assertEquals(record.workspaceId, "ws-1");
  assertEquals(record.socialAccountId, "acct-1");
});

Deno.test("authenticatePartnerKey looks the key up by its hash, never the plaintext", async () => {
  const key = "pk_live_whatever";
  const hash = await hashPartnerKey(key);
  // The stub only yields a row when filtered on exactly this hash, so a module
  // that queried `.eq("key_hash", key)` would get null and this would fail.
  const record = await authenticatePartnerKey(stubClient(ACTIVE_ROW, hash), key);
  assertEquals(record.id, "key-1");
});

Deno.test("authenticatePartnerKey rejects an unknown key as invalid_key", async () => {
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "pk_live_nope"),
    PartnerAuthError,
  );
  assertEquals(error.code, "invalid_key");
  assertEquals(error.status, 401);
});

Deno.test("authenticatePartnerKey rejects a revoked key as key_revoked", async () => {
  const revoked = { ...ACTIVE_ROW, revoked_at: "2026-01-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(revoked), "pk_live_whatever"),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_revoked");
  assertEquals(error.status, 401);
});

Deno.test("authenticatePartnerKey rejects an expired key", async () => {
  const expired = { ...ACTIVE_ROW, expires_at: "2020-01-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(expired), "pk_live_whatever",
      new Date("2026-08-13T00:00:00Z")),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_expired");
});

Deno.test("assertScope allows a granted scope and rejects a missing one", () => {
  const record = {
    id: "key-1", workspaceId: "ws-1", socialAccountId: "acct-1",
    keyPrefix: "pk_live_abcd", scopes: ["whatsapp:template.send"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  assertScope(record, "whatsapp:template.send");
  const error = assertThrows(
    () => assertScope(record, "whatsapp:templates.read"),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
  assertEquals(error.status, 403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiKeys.test.ts`
Expected: FAIL — `Module not found "./partnerApiKeys.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/partnerApiKeys.ts`:

```ts
// Partner API key generation and authentication.
//
// Keys are shown to the operator exactly once and stored only as a SHA-256
// hex digest, following the mcp_oauth_tokens precedent — a database leak
// yields no usable credentials.

const KEY_PREFIX = "pk_live_";
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type PartnerScope =
  | "whatsapp:template.send"
  | "whatsapp:templates.read"
  | "whatsapp:webhooks.manage";

export interface PartnerKeyRecord {
  id: string;
  workspaceId: string;
  socialAccountId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  monthlyQuota: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export class PartnerAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PartnerAuthError";
  }
}

/** Async because SubtleCrypto's digest is the only hash available in the
 *  edge runtime — node:crypto is not reliably present. */
export async function generatePartnerKey(): Promise<{
  key: string;
  prefix: string;
  hash: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = KEY_PREFIX + body;
  return { key, prefix: key.slice(0, 12), hash: await hashPartnerKey(key) };
}

export async function hashPartnerKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticatePartnerKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  presentedKey: string,
  now: Date = new Date(),
): Promise<PartnerKeyRecord> {
  if (!presentedKey || !presentedKey.startsWith(KEY_PREFIX)) {
    throw new PartnerAuthError("Invalid API key", "invalid_key", 401);
  }

  const hash = await hashPartnerKey(presentedKey);
  const { data, error } = await client
    .from("partner_api_keys")
    .select(
      "id, workspace_id, social_account_id, key_prefix, scopes, " +
        "rate_limit_per_min, monthly_quota, expires_at, revoked_at",
    )
    .eq("key_hash", hash)
    .maybeSingle();

  if (error) throw new PartnerAuthError("Key lookup failed", "internal_error", 500);
  // Same response for "no such key" as for a malformed one: non-enumerable.
  if (!data) throw new PartnerAuthError("Invalid API key", "invalid_key", 401);

  if (data.revoked_at) {
    throw new PartnerAuthError("API key revoked", "key_revoked", 401);
  }
  if (data.expires_at && new Date(data.expires_at) <= now) {
    throw new PartnerAuthError("API key expired", "key_expired", 401);
  }

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    socialAccountId: data.social_account_id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
    rateLimitPerMin: data.rate_limit_per_min,
    monthlyQuota: data.monthly_quota,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
  };
}

export function assertScope(
  record: PartnerKeyRecord,
  scope: PartnerScope,
): void {
  if (!record.scopes.includes(scope)) {
    throw new PartnerAuthError(
      `This key lacks the ${scope} scope`,
      "insufficient_scope",
      403,
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiKeys.test.ts`
Expected: PASS — 7 tests.

If the two `generatePartnerKey` tests fail with "key.startsWith is not a function", the test is not awaiting the promise — `generatePartnerKey` is async. Both generator tests must destructure from `await generatePartnerKey()`, exactly as written in Step 1.

- [ ] **Step 5: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add hashed key generation, authentication, and scope checks" -- supabase/functions/_shared/partnerApiKeys.ts supabase/functions/_shared/partnerApiKeys.test.ts
```

---

### Task 3: Rate limiting and metering

**Files:**
- Create: `supabase/functions/_shared/partnerApiMetering.ts`
- Create: `supabase/functions/_shared/partnerApiMetering.test.ts`

**Interfaces:**
- Consumes: `PartnerKeyRecord` (Task 2); RPCs `reserve_partner_quota`, `release_partner_quota`, `consume_partner_rate`, `touch_partner_key` (Task 1).
- Produces:
  - `reserveQuota(client, record): Promise<boolean>` — false when over quota; the caller settles the idempotency claim
  - `releaseQuota(client, record): Promise<void>` — refund after a DEFINITE Meta rejection only
  - `touchKey(client, record): Promise<void>` — updates `last_used_at` for non-send actions
  - `checkRateLimit(client, record, now?): Promise<void>` — throws `PartnerAuthError("rate_limited", 429)`
  - `recordUsage(client, input: UsageInput): Promise<void>`
  - `interface UsageInput { keyId, workspaceId, action, billable, httpStatus, errorCode? }`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/partnerApiMetering.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PartnerAuthError } from "./partnerApiKeys.ts";
import { recordUsage, releaseQuota, reserveQuota } from "./partnerApiMetering.ts";

const RECORD = {
  id: "key-1", workspaceId: "ws-1", socialAccountId: "acct-1",
  keyPrefix: "pk_live_abcd", scopes: ["whatsapp:template.send"],
  rateLimitPerMin: 60, monthlyQuota: 100, expiresAt: null, revokedAt: null,
};

function stubRpc(result: { allowed: boolean; usage_count: number }) {
  return {
    rpc() { return Promise.resolve({ data: [result], error: null }); },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("reserveQuota returns true when the key is under quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: true, usage_count: 5 }), RECORD), true);
});

Deno.test("reserveQuota returns false when the reservation exceeds quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: false, usage_count: 101 }), RECORD), false);
});

Deno.test("releaseQuota refunds a reservation without throwing", async () => {
  let called = false;
  const client = { rpc() { called = true; return Promise.resolve({ error: null }); } } as any;
  await releaseQuota(client, RECORD);
  assertEquals(called, true);
});

Deno.test("recordUsage writes one row with the billable flag it was given", async () => {
  const inserted: unknown[] = [];
  const client = {
    from() {
      return { insert(row: unknown) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });

  assertEquals(inserted.length, 1);
  assertEquals((inserted[0] as Record<string, unknown>).billable, true);
  assertEquals((inserted[0] as Record<string, unknown>).action, "send_template");
});

Deno.test("recordUsage never throws — metering must not fail a real send", async () => {
  const client = {
    from() {
      return { insert() { return Promise.resolve({ error: { message: "boom" } }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiMetering.test.ts`
Expected: FAIL — `Module not found "./partnerApiMetering.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/partnerApiMetering.ts`:

```ts
// Rate limiting, monthly quota, and the usage ledger for partner API keys.
//
// Deliberately NOT built on api_logs: that table is keyed by (user_id,
// endpoint) with no key column, and the existing ecommerce limiter counts
// then inserts, which two concurrent requests can both pass.

import { type PartnerKeyRecord, PartnerAuthError } from "./partnerApiKeys.ts";

export interface UsageInput {
  keyId: string;
  workspaceId: string;
  action: string;
  billable: boolean;
  httpStatus: number;
  errorCode?: string;
}

/**
 * Reserve one unit of monthly quota before sending. Returns false when the
 * reservation would exceed quota — the caller must then settle the pending
 * idempotency claim rather than leaving it in `processing`.
 *
 * Reserve/settle rather than consume-on-entry, because the plan promises a
 * partner is charged only for messages Meta accepted.
 */
export async function reserveQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<boolean> {
  const { data, error } = await client.rpc("reserve_partner_quota", {
    p_key_id: record.id,
  });
  if (error) {
    throw new PartnerAuthError("Quota check failed", "internal_error", 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.allowed);
}

/** Refund a reservation after Meta DEFINITELY rejected the send. Never call
 *  this for an indeterminate outcome — the message may have been delivered. */
export async function releaseQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("release_partner_quota", { p_key_id: record.id });
  if (error) console.error("[partner-api] quota release failed:", error.message);
}

/** Non-send actions never reserve quota, so they update last_used_at here. */
export async function touchKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  await client.rpc("touch_partner_key", { p_key_id: record.id }).catch?.(() => {});
}

/**
 * Per-minute rate limit via an atomic bucket.
 *
 * Counting rows in the usage ledger and inserting afterwards would be the
 * same count-then-insert race the spec rejects — concurrent requests all read
 * the same stale count and all pass. consume_partner_rate does the increment
 * and the read in one statement.
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { data, error } = await client.rpc("consume_partner_rate", {
    p_key_id: record.id,
    p_limit: record.rateLimitPerMin,
  });
  if (error) return; // Never fail a send because the limiter is unavailable.
  if (data === false) {
    throw new PartnerAuthError("Rate limit exceeded", "rate_limited", 429);
  }
}

/**
 * Append to the usage ledger. Swallows its own errors on purpose: losing an
 * audit row must never turn a delivered message into a reported failure.
 */
export async function recordUsage(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: UsageInput,
): Promise<void> {
  try {
    const { error } = await client.from("partner_api_usage").insert({
      key_id: input.keyId,
      workspace_id: input.workspaceId,
      action: input.action,
      billable: input.billable,
      http_status: input.httpStatus,
      error_code: input.errorCode ?? null,
    });
    if (error) console.error("[partner-api] usage ledger write failed:", error.message);
  } catch (err) {
    console.error("[partner-api] usage ledger threw:", err);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiMetering.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add atomic quota consumption, rate limiting, and usage ledger" -- supabase/functions/_shared/partnerApiMetering.ts supabase/functions/_shared/partnerApiMetering.test.ts
```

---

### Task 4: Idempotency state machine

**Files:**
- Create: `supabase/functions/_shared/partnerApiIdempotency.ts`
- Create: `supabase/functions/_shared/partnerApiIdempotency.test.ts`

**Interfaces:**
- Consumes: `partner_api_idempotency` and the `claim_partner_idempotency` RPC (Task 1).
- Produces:
  - `hashRequest(body: unknown): Promise<string>`
  - `claimIdempotency(client, keyId, idempotencyKey, requestHash): Promise<ClaimResult>`
  - `completeIdempotency(client, keyId, idempotencyKey, httpStatus, body): Promise<void>` — **throws** on write failure; a caller that has already sent must catch it and fall back to `markIndeterminate` rather than reporting the send as failed
  - `markIndeterminate(client, keyId, idempotencyKey): Promise<void>`
  - `type ClaimResult = { outcome: "claimed" } | { outcome: "replay"; httpStatus: number; body: unknown } | { outcome: "conflict" } | { outcome: "in_progress" } | { outcome: "indeterminate" }`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/partnerApiIdempotency.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
} from "./partnerApiIdempotency.ts";

/**
 * Stubs the RPC, because that is now the whole interface. These tests cover
 * ONLY the outcome mapping — they deliberately do not claim to test claim
 * semantics, which live in SQL and are tested for real in Task 9.
 */
function stubRpc(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    rpc() {
      return Promise.resolve({ data: [{ outcome, ...extra }], error: null });
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("hashRequest is stable for equal bodies and differs for different ones", async () => {
  const a = await hashRequest({ to: "965123", template: "invoice_due" });
  const b = await hashRequest({ to: "965123", template: "invoice_due" });
  const c = await hashRequest({ to: "965999", template: "invoice_due" });
  assertEquals(a, b);
  assertEquals(a === c, false);
});

Deno.test("hashRequest ignores key order but not key content", async () => {
  const a = await hashRequest({ to: "965123", template: "x" });
  const b = await hashRequest({ template: "x", to: "965123" });
  assertEquals(a, b);
});

Deno.test("hashRequest distinguishes bodies that differ only deep inside", async () => {
  // The regression guard: a replacer-based canonicalizer collapses both of
  // these to [{}], so a 99.000 KWD invoice would replay a 12.500 KWD send.
  const cheap = await hashRequest({
    template_components: [{ type: "body", parameters: [{ type: "text", text: "12.500" }] }],
  });
  const dear = await hashRequest({
    template_components: [{ type: "body", parameters: [{ type: "text", text: "99.000" }] }],
  });
  assertEquals(cheap === dear, false);
});

Deno.test("hashRequest accepts null and undefined without throwing", async () => {
  await hashRequest(null);
  await hashRequest(undefined);
});

Deno.test("claimIdempotency maps each RPC outcome to its ClaimResult", async () => {
  assertEquals(
    (await claimIdempotency(stubRpc("claimed"), "k", "i", "h")).outcome,
    "claimed",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("conflict"), "k", "i", "h")).outcome,
    "conflict",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("in_progress"), "k", "i", "h")).outcome,
    "in_progress",
  );
  assertEquals(
    (await claimIdempotency(stubRpc("indeterminate"), "k", "i", "h")).outcome,
    "indeterminate",
  );
});

Deno.test("claimIdempotency carries the stored response through a replay", async () => {
  const result = await claimIdempotency(
    stubRpc("replay", { http_status: 200, response_body: { message_id: "wamid.X" } }),
    "k", "i", "h",
  );
  assertEquals(result.outcome, "replay");
  if (result.outcome === "replay") {
    assertEquals(result.httpStatus, 200);
    assertEquals((result.body as Record<string, unknown>).message_id, "wamid.X");
  }
});

Deno.test("claimIdempotency treats an unrecognized outcome as in_progress", async () => {
  // Fail closed: an unknown outcome must never be read as permission to send.
  assertEquals(
    (await claimIdempotency(stubRpc("something_new"), "k", "i", "h")).outcome,
    "in_progress",
  );
});

Deno.test("claimIdempotency surfaces an RPC error instead of sending anyway", async () => {
  const client = {
    rpc() { return Promise.resolve({ data: null, error: { message: "boom" } }); },
  // deno-lint-ignore no-explicit-any
  } as any;
  await assertRejects(() => claimIdempotency(client, "k", "i", "h"), Error);
});

Deno.test("completeIdempotency throws when the settle write fails", async () => {
  const client = {
    from() {
      return {
        update() { return this; },
        eq() {
          return { eq: () => Promise.resolve({ error: { message: "db down" } }) };
        },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  // A silently dropped settle leaves the row `processing`; it must be loud.
  await assertRejects(
    () => completeIdempotency(client, "k", "i", 200, { ok: true }),
    Error,
  );
});

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiIdempotency.test.ts`
Expected: FAIL — `Module not found "./partnerApiIdempotency.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/partnerApiIdempotency.ts`:

```ts
// Idempotency for partner sends.
//
// The claim is an INSERT that races on the primary key: whoever inserts first
// owns the send, and everyone else reads the existing row and reacts to its
// state. A check-then-insert would let two concurrent retries both send.

export type ClaimResult =
  | { outcome: "claimed" }
  | { outcome: "replay"; httpStatus: number; body: unknown }
  | { outcome: "conflict" }
  | { outcome: "in_progress" }
  | { outcome: "indeterminate" };

/**
 * Recursively canonicalize before hashing.
 *
 * The obvious one-liner is WRONG and dangerously so:
 *   JSON.stringify(body, Object.keys(body).sort())
 * The second argument is a replacer ALLOW-LIST, not a sort order. It strips
 * every nested property whose name is absent from the top level, so
 * `[{type:"body",parameters:[{text:"12.500"}]}]` and the same structure with
 * `"99.000"` both collapse to `[{}]` — two genuinely different messages hash
 * identically, and the second silently replays the first's response.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) out[key] = canonicalize(source[key]);
  }
  return out;
}

/** Stable digest of the request body, so a reused key with different content
 *  is detected rather than silently replayed. Accepts null/undefined. */
export async function hashRequest(body: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalize(body));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function claimIdempotency(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<ClaimResult> {
  // All of the atomicity lives in the RPC: insert-or-inspect, stale-lease
  // takeover, and expiry pruning happen in one statement under a row lock.
  const { data, error } = await client.rpc("claim_partner_idempotency", {
    p_key_id: keyId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: requestHash,
    // Must stay above the 75s worst-case send deadline in Task 5. See the
    // comment on claim_partner_idempotency for why a short lease double-sends.
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`Idempotency claim failed: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  switch (row?.outcome) {
    case "claimed":
      return { outcome: "claimed" };
    case "replay":
      return { outcome: "replay", httpStatus: row.http_status, body: row.response_body };
    case "conflict":
      return { outcome: "conflict" };
    case "indeterminate":
      return { outcome: "indeterminate" };
    default:
      return { outcome: "in_progress" };
  }
}

export async function completeIdempotency(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
  httpStatus: number,
  body: unknown,
): Promise<void> {
  const { error } = await client
    .from("partner_api_idempotency")
    .update({
      state: "completed",
      http_status: httpStatus,
      response_body: body,
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey)
    // Only settle a row still in flight. Without this, a slow request whose
    // lease was taken over could overwrite the newer attempt's result.
    .eq("state", "processing");

  // Swallowing this would leave the row `processing` with no live lease. The
  // stale-lease path in the RPC recovers it, but a silent failure here means
  // a duplicate could re-send, so it must at least be visible.
  if (error) {
    console.error("[partner-api] idempotency settle failed:", error.message);
    throw new Error(`Idempotency settle failed: ${error.message}`);
  }
}

export async function markIndeterminate(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
): Promise<void> {
  const { error } = await client
    .from("partner_api_idempotency")
    .update({ state: "indeterminate", locked_until: null })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey)
    // Never downgrade an already-settled success to `indeterminate`: if the
    // completion committed and only the response was lost, the row is correct
    // as it stands.
    .eq("state", "processing");

  // If this write is lost the row stays `processing`; once its lease expires
  // a retry would take it over and re-send a message that may already have
  // been delivered. Loud failure is the lesser evil.
  if (error) {
    console.error("[partner-api] indeterminate mark failed:", error.message);
    throw new Error(`Indeterminate mark failed: ${error.message}`);
  }
}```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiIdempotency.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add idempotency claim state machine" -- supabase/functions/_shared/partnerApiIdempotency.ts supabase/functions/_shared/partnerApiIdempotency.test.ts
```

---

### Task 5: Shared WhatsApp operations (characterization first)

> **Read this before starting.** An earlier draft of this task extracted only the
> Graph call and would have caused a **live regression in the Postora UI**. The
> current handler (`messaging-api/index.ts:951-1008`) does four things the naive
> extraction dropped. All four are now in scope:
>
> | Behaviour | Where it lives today | Consequence if dropped |
> |---|---|---|
> | **Auto-register on Meta error `133010` / `100`+subcode `33`**, then retry the send | `sendWhatsAppWithRetry` (`:820-870`) | Coexistence accounts that currently self-heal would start hard-failing |
> | **`upsertOutboundConversation`** — surfaces the conversation in the inbox and auto-saves the contact | `:997-1005`, helper at `:35` | Sent templates would **not appear in the inbox** — violating spec Goal #2 |
> | Message preview text `[Template: <name>]` | `:988` | Inbox rows would read `[Template message]`, losing which template was sent |
> | Response includes `data` (the raw Meta body) | `:1008` | `WhatsAppDiagnostics.tsx:215` and `useMessaging.ts:220` read this response |
>
> So this task extracts the **whole chain**: `registerWhatsAppPhone`,
> `sendWhatsAppWithRetry`, `upsertOutboundConversation`, and `sendTemplate`.
> That is larger than "extract two ops", and it is the honest cost of having one
> implementation behind both doors.

**Files:**
- Create: `supabase/functions/_shared/whatsappPartnerOps.ts`
- Create: `supabase/functions/_shared/whatsappPartnerOps.test.ts`
- Modify: `supabase/functions/messaging-api/index.ts` — repoint the `whatsapp_send_template` handler (`:951-1008`) at the shared op, and delete the local `upsertOutboundConversation` (`:35-88`) in favour of the imported one. **`registerWhatsAppPhone` (`:787-818`) and `sendWhatsAppWithRetry` (`:820-870`) stay** — four other handlers still call them; see Step 5.

**Interfaces:**
- Consumes: `WhatsAppAccountAccess` from `_shared/whatsappWorkspaceAccess.ts` — fields `accountId, ownerId, workspaceId, role, platformUserId, platformUsername, accessToken, accountMetadata`.
- Produces:
  - `interface WhatsAppOpsContext { admin; accountId; ownerId; workspaceId; phoneNumberId; accessToken }` — deliberately **role-free**; a machine key has scopes, not a human workspace role.
  - `sendTemplate(ctx, input: SendTemplateInput, fetcher?: Fetcher): Promise<SendResult>`
  - `listTemplates(ctx, wabaId: string, fetcher?: Fetcher): Promise<TemplateSummary[]>` — the WABA id comes from `social_accounts.account_metadata.waba_id`, not from the context
  - `upsertOutboundConversation(admin, params): Promise<boolean>` — moved verbatim from `messaging-api/index.ts:35`, now returning success instead of ignoring its error
  - `type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>` — injected so tests never hit the network
  - `interface SendTemplateInput { recipientPhone: string; templateName: string; templateLanguage: string; components?: unknown[] }`
  - `interface SendResult { messageId: string; persisted: boolean; raw: unknown }` — `raw` is the Meta body. **`messaging-api` passes it through as `data` to preserve the existing frontend contract; `partner-api` must NOT return it**, per spec §5.3 (partners get a normalized response only).
  - `interface TemplateSummary { name: string; language: string; status: string; category: string; components: unknown[] }` — `components` is required by `WhatsAppTemplatesContent.tsx`
  - `class WhatsAppOpError extends Error { code: string; status: number; metaCode?: number }`

- [ ] **Step 1: Write the characterization test**

This test locks in the behaviour `messaging-api` has **today**, so the extraction cannot silently change it. Create `supabase/functions/_shared/whatsappPartnerOps.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  sendTemplate,
  WhatsAppOpError,
} from "./whatsappPartnerOps.ts";

function stubAdmin(captured: { rows: unknown[] }) {
  return {
    from() {
      return {
        insert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        upsert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

function ctx(captured: { rows: unknown[] }) {
  return {
    admin: stubAdmin(captured),
    accountId: "acct-1",
    ownerId: "owner-1",
    workspaceId: "ws-1",
    phoneNumberId: "999888777",
    accessToken: "tok",
  };
}

Deno.test("sendTemplate posts the Meta template payload and returns the message id", async () => {
  const captured = { rows: [] as unknown[] };
  let requestBody: Record<string, unknown> = {};

  const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }),
    );
  };

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
    components: [{ type: "body", parameters: [{ type: "text", text: "12.500 KWD" }] }],
  }, fetcher);

  assertEquals(result.messageId, "wamid.ABC");
  assertEquals(requestBody.messaging_product, "whatsapp");
  assertEquals(requestBody.type, "template");
  assertEquals((requestBody.template as Record<string, unknown>).name, "invoice_due_v1");
  assertEquals(
    ((requestBody.template as Record<string, unknown>).language as Record<string, string>).code,
    "ar",
  );
});

Deno.test("sendTemplate records the outbound message so it appears in the inbox", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  const message = captured.rows.find((r) =>
    (r as Record<string, unknown>).direction === "outbound"
  ) as Record<string, unknown> | undefined;

  assertEquals(message?.user_id, "owner-1");
  assertEquals(message?.social_account_id, "acct-1");
  assertEquals(message?.message_id, "wamid.ABC");
  assertEquals(message?.conversation_id, "wa_999888777_96512345678");
  assertEquals(message?.message_type, "template");
});

Deno.test("sendTemplate auto-registers on 133010 and retries the send", async () => {
  const captured = { rows: [] as unknown[] };
  const calls: string[] = [];

  const fetcher = (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/register")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    // First send fails "not registered"; the retry after registration succeeds.
    const isRetry = calls.filter((c) => c.endsWith("/messages")).length > 1;
    return Promise.resolve(new Response(
      JSON.stringify(isRetry
        ? { messages: [{ id: "wamid.AFTER" }] }
        : { error: { code: 133010, message: "not registered" } }),
      { status: isRetry ? 200 : 400 },
    ));
  };

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  assertEquals(result.messageId, "wamid.AFTER");
  assertEquals(calls.filter((c) => c.endsWith("/register")).length, 1);
  assertEquals(calls.filter((c) => c.endsWith("/messages")).length, 2);
});

Deno.test("sendTemplate upserts the conversation so it appears in the inbox", async () => {
  const captured = { rows: [] as unknown[] };
  const tables: string[] = [];

  const admin = {
    from(table: string) {
      tables.push(table);
      return {
        insert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        upsert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate({
    admin, accountId: "acct-1", ownerId: "owner-1", workspaceId: "ws-1",
    phoneNumberId: "999888777", accessToken: "tok",
  }, {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  // Without messaging_cache the inbox never shows the conversation.
  assertEquals(tables.includes("whatsapp_messages"), true);
  assertEquals(tables.includes("whatsapp_contacts"), true);
  assertEquals(tables.includes("messaging_cache"), true);

  const cacheRow = captured.rows.find((r) =>
    (r as Record<string, unknown>).platform === "whatsapp" &&
    (r as Record<string, unknown>).last_message_preview !== undefined
  ) as Record<string, unknown> | undefined;
  assertEquals(cacheRow?.last_message_preview, "[Template: invoice_due_v1]");
});

Deno.test("sendTemplate labels the message with the template name", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  const message = captured.rows.find((r) =>
    (r as Record<string, unknown>).direction === "outbound"
  ) as Record<string, unknown> | undefined;
  // The UI shows this string in the inbox; "[Template message]" would lose the name.
  assertEquals(message?.message_text, "[Template: invoice_due_v1]");
});

Deno.test("sendTemplate returns the raw Meta body for the existing UI contract", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ messages: [{ id: "wamid.ABC" }], messaging_product: "whatsapp" }),
      { status: 200 },
    ));

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  assertEquals((result.raw as Record<string, unknown>).messaging_product, "whatsapp");
});

Deno.test("sendTemplate maps Meta error 131047 to outside_session_window", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }),
      { status: 400 },
    ));

  const error = await assertRejects(
    () => sendTemplate(ctx(captured), {
      recipientPhone: "96512345678",
      templateName: "invoice_due_v1",
      templateLanguage: "ar",
    }, fetcher),
    WhatsAppOpError,
  );
  assertEquals(error.code, "outside_session_window");
  assertEquals(error.metaCode, 131047);
});

Deno.test("sendTemplate maps an unapproved template to template_not_approved", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 132001, message: "Template does not exist" } }),
      { status: 400 },
    ));

  const error = await assertRejects(
    () => sendTemplate(ctx(captured), {
      recipientPhone: "96512345678",
      templateName: "nope_v1",
      templateLanguage: "ar",
    }, fetcher),
    WhatsAppOpError,
  );
  assertEquals(error.code, "template_not_approved");
});

Deno.test("sendTemplate reports persisted=false when Meta accepted but the DB write failed", async () => {
  const failingAdmin = {
    from() {
      return {
        insert() { return Promise.resolve({ error: { message: "db down" } }); },
        upsert() { return Promise.resolve({ error: { message: "db down" } }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  const result = await sendTemplate({
    admin: failingAdmin, accountId: "acct-1", ownerId: "owner-1",
    workspaceId: "ws-1", phoneNumberId: "999888777", accessToken: "tok",
  }, {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  // The message really was sent; the caller must be able to tell it was not recorded.
  assertEquals(result.messageId, "wamid.ABC");
  assertEquals(result.persisted, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/_shared/whatsappPartnerOps.test.ts`
Expected: FAIL — `Module not found "./whatsappPartnerOps.ts"`.

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/whatsappPartnerOps.ts`:

```ts
// WhatsApp operations shared by the JWT door (messaging-api) and the key door
// (partner-api). The context is deliberately role-free: each door authorizes
// in its own terms before constructing one.

const GRAPH_API = "https://graph.facebook.com/v22.0";

export interface WhatsAppOpsContext {
  // deno-lint-ignore no-explicit-any
  admin: any;
  accountId: string;
  ownerId: string;
  workspaceId: string;
  phoneNumberId: string;
  accessToken: string;
}

export interface SendTemplateInput {
  recipientPhone: string;
  templateName: string;
  templateLanguage: string;
  components?: unknown[];
}

export interface SendResult {
  messageId: string;
  /** False when Meta accepted the send but Postora failed to record it. */
  persisted: boolean;
  /**
   * The raw Meta body. messaging-api passes this through as `data` to keep
   * the existing frontend contract; partner-api must NOT return it, because
   * partners get a normalized response only (spec 5.3).
   */
  raw: unknown;
}

export interface TemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string;
  // WhatsAppTemplatesContent.tsx renders headers, buttons, and body previews
  // from this. Dropping it would break the template UI the moment the
  // messaging-api list handler is repointed at this op.
  components: unknown[];
}

export class WhatsAppOpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly metaCode?: number,
    /**
     * True when we cannot prove Meta did NOT accept the message.
     *
     * This distinction decides whether the caller may refund quota and settle
     * the request as a clean failure. A 4xx with a specific Meta code is a
     * definite rejection. A 5xx, a missing message id, or a body we could not
     * parse are NOT: the message may be on its way to a real customer, so the
     * request must become non-resendable and keep its quota unit.
     */
    public readonly indeterminate: boolean = false,
  ) {
    super(message);
    this.name = "WhatsAppOpError";
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Meta is the authority on messaging policy, so we send and translate its
 * errors rather than pre-judging locally against our own message history,
 * which can be incomplete and cannot model every window variant.
 */
function translateMetaError(status: number, payload: Record<string, unknown>): WhatsAppOpError {
  const err = (payload.error ?? {}) as Record<string, unknown>;
  const metaCode = typeof err.code === "number" ? err.code : undefined;
  const message = String(err.message ?? "WhatsApp send failed");

  switch (metaCode) {
    case 131047:
      return new WhatsAppOpError(
        "Recipient has not messaged in the last 24h — send an approved template.",
        "outside_session_window", 422, metaCode,
      );
    case 132000:
    case 132001:
    case 132005:
    case 132007:
      return new WhatsAppOpError(
        `Template rejected by Meta: ${message}`,
        "template_not_approved", 422, metaCode,
      );
    case 131026:
      return new WhatsAppOpError(
        "Recipient is not reachable on WhatsApp.",
        "invalid_recipient", 422, metaCode,
      );
    case 190:
      return new WhatsAppOpError(
        "WhatsApp access token is invalid or expired — reconnect the account.",
        "account_needs_reauth", 401, metaCode,
      );
    default:
      // A 5xx tells us Meta failed to RESPOND, not that it failed to accept.
      return status >= 500
        ? new WhatsAppOpError(message, "meta_error", 502, metaCode, true)
        : new WhatsAppOpError(message, "meta_error", 422, metaCode, false);
  }
}

/**
 * Register a phone number on the Cloud API. Moved verbatim from
 * messaging-api so both doors keep the Coexistence self-heal behaviour.
 */
async function registerWhatsAppPhone(
  phoneNumberId: string,
  token: string,
  fetcher: Fetcher,
): Promise<void> {
  const pin = Deno.env.get("WHATSAPP_VERIFY_PIN") || "000000";
  // Timed like the send: this call sits BETWEEN the two message posts on the
  // auto-registration path, so an untimed hang here would strand the whole
  // request and leave its idempotency row in `processing`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const res = await fetcher(`${GRAPH_API}/${phoneNumberId}/register`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    // Subcode 2388001: two-step verification is on in the WhatsApp Business app.
    if (err.code === 100 && err.error_subcode === 2388001) {
      throw new WhatsAppOpError(
        "Two-step verification is enabled on the WhatsApp Business mobile app for " +
          "this number. Turn it off under Settings → Account → Two-step verification, " +
          "then try again.",
        "account_needs_reauth", 409, 2388001,
      );
    }
    throw new WhatsAppOpError(
      `Phone registration failed: ${JSON.stringify(err)}`,
      "account_not_connected", 409, err.code,
    );
  }
}

export async function sendTemplate(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  fetcher: Fetcher = fetch,
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.templateLanguage },
      components: input.components ?? [],
    },
  };

  // A hung Graph request must not outlive the function: if the runtime kills
  // us mid-flight, the idempotency row stays `processing` forever and that
  // key is poisoned.
  //
  // Worst case on the auto-registration path is send(30s) + register(15s) +
  // retry(30s) = 75s. Two constraints bind these numbers:
  //   1. the edge runtime's own request limit must exceed 75s;
  //   2. the idempotency LEASE (300s) must exceed 75s by a wide margin, or a
  //      still-running request loses its claim and a retry sends a duplicate.
  // If you shorten the lease or lengthen these timeouts, re-check both.
  const post = () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    return fetcher(`${GRAPH_API}/${ctx.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  };

  let response = await post();
  let body = await response.json().catch(() => ({}));

  // Coexistence numbers are not on the Cloud API until first registered.
  // Register once and retry, exactly as messaging-api does today.
  const needsRegistration = body?.error?.code === 133010 ||
    (body?.error?.code === 100 && body?.error?.error_subcode === 33);

  if (needsRegistration) {
    await registerWhatsAppPhone(ctx.phoneNumberId, ctx.accessToken, fetcher);
    response = await post();
    body = await response.json().catch(() => ({}));
  }

  if (!response.ok || body?.error) throw translateMetaError(response.status, body);

  const messageId = body?.messages?.[0]?.id;
  if (!messageId) {
    // Meta returned 2xx, so it very likely accepted the message; we simply
    // cannot name it. Never treat this as a rejection.
    throw new WhatsAppOpError(
      "Meta accepted the send but returned no message id",
      "meta_error", 502, undefined, true,
    );
  }

  const persisted = await persistOutbound(ctx, input, messageId);
  return { messageId, persisted, raw: body };
}

/**
 * Record the outbound message AND surface the conversation in the inbox.
 * Returns false rather than throwing: Meta has already accepted the message,
 * so a storage failure must not be reported to the caller as a failed send.
 */
async function persistOutbound(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  messageId: string,
): Promise<boolean> {
  const preview = `[Template: ${input.templateName}]`;
  const normalizedPhone = input.recipientPhone.replace(/^\+/, "");
  const conversationId = `wa_${ctx.phoneNumberId}_${normalizedPhone}`;

  const { error } = await ctx.admin.from("whatsapp_messages").insert({
    user_id: ctx.ownerId,
    social_account_id: ctx.accountId,
    conversation_id: conversationId,
    message_id: messageId,
    from_phone: ctx.phoneNumberId,
    from_name: "You",
    to_phone: input.recipientPhone,
    message_text: preview,
    message_type: "template",
    direction: "outbound",
    status: "sent",
    timestamp: new Date().toISOString(),
  });

  if (error) {
    console.error("[whatsappPartnerOps] message persist failed:", error.message);
    return false;
  }

  // Without this the message is stored but the conversation never appears in
  // the inbox — the exact regression this task's header warns about.
  return await upsertOutboundConversation(ctx.admin, {
    user_id: ctx.ownerId,
    social_account_id: ctx.accountId,
    workspace_id: ctx.workspaceId,
    phone_number_id: ctx.phoneNumberId,
    recipient_phone: input.recipientPhone,
    preview,
  });
}

/**
 * Moved from messaging-api/index.ts:35. Copy the body verbatim — it upserts
 * the contact and the conversation row — changing only the signature to
 * return a boolean instead of swallowing failures silently.
 *
 * NOTE: it normalizes with replace(/\D/g, "") while the message insert above
 * uses replace(/^\+/, ""). Preserve both as they are; unifying them would
 * change existing conversation_id values. Flagged in the spec, not fixed here.
 */
export async function upsertOutboundConversation(
  // deno-lint-ignore no-explicit-any
  admin: any,
  params: {
    user_id: string;
    social_account_id: string;
    workspace_id: string;
    phone_number_id: string;
    recipient_phone: string;
    preview: string;
  },
): Promise<boolean> {
  const normalizedPhone = params.recipient_phone.replace(/\D/g, "");
  const conversationId = `wa_${params.phone_number_id}_${normalizedPhone}`;
  const nowIso = new Date().toISOString();

  const { data: existingContact } = await admin
    .from("whatsapp_contacts")
    .select("display_name")
    .eq("workspace_id", params.workspace_id)
    .eq("phone_number", normalizedPhone)
    .maybeSingle();

  const participantName = existingContact?.display_name || `+${normalizedPhone}`;

  // Auto-save contact (no-op on conflict).
  const { error: contactError } = await admin.from("whatsapp_contacts").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      phone_number: normalizedPhone,
      display_name: participantName,
      last_message_at: nowIso,
    },
    { onConflict: "user_id,phone_number", ignoreDuplicates: false },
  );

  // messaging_cache is what makes the conversation show up in the inbox.
  const { error: cacheError } = await admin.from("messaging_cache").upsert(
    {
      user_id: params.user_id,
      workspace_id: params.workspace_id,
      social_account_id: params.social_account_id,
      platform: "whatsapp",
      conversation_id: conversationId,
      participant_name: participantName,
      last_message_preview: params.preview.slice(0, 200),
      last_message_at: nowIso,
      unread_count: 0,
      updated_at: nowIso,
    },
    { onConflict: "user_id,conversation_id" },
  );

  if (contactError || cacheError) {
    console.error(
      "[whatsappPartnerOps] conversation upsert failed:",
      contactError?.message ?? cacheError?.message,
    );
    return false;
  }
  return true;
}

export async function listTemplates(
  ctx: WhatsAppOpsContext,
  wabaId: string,
  fetcher: Fetcher = fetch,
): Promise<TemplateSummary[]> {
  // Keep the explicit field selection the current handler uses
  // (messaging-api/index.ts:1025); without `fields=` Meta omits `components`,
  // which the template UI renders.
  const response = await fetcher(
    `${GRAPH_API}/${wabaId}/message_templates` +
      `?fields=name,status,category,language,components&limit=100`,
    { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw translateMetaError(response.status, body);

  // deno-lint-ignore no-explicit-any
  return (body.data ?? []).map((t: any) => ({
    name: t.name,
    language: t.language,
    status: t.status,
    category: t.category,
    components: t.components ?? [],
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env supabase/functions/_shared/whatsappPartnerOps.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Repoint `messaging-api` at the shared op**

In `supabase/functions/messaging-api/index.ts`, the `whatsapp_send_template` handler currently begins at line 951. Keep the existing `withWhatsAppActionAccess` authorization exactly as it is, and replace only the Graph call plus persistence with the shared op:

```ts
    if (action === "whatsapp_send_template") {
      const { social_account_id, recipient_phone, template_name, template_language, template_components } = body;
      if (!social_account_id || !recipient_phone || !template_name) {
        throw new Error("social_account_id, recipient_phone, and template_name required");
      }

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_template",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      const result = await sendTemplate({
        admin: adminClient,
        accountId: account.accountId,
        ownerId: account.ownerId,
        workspaceId: account.workspaceId,
        phoneNumberId: account.platformUserId,
        accessToken: getWhatsAppToken(account),
      }, {
        recipientPhone: recipient_phone,
        templateName: template_name,
        templateLanguage: template_language || "en_US",
        components: template_components,
      });

      // `data` preserves the existing frontend contract — WhatsAppDiagnostics.tsx:215
      // and useMessaging.ts:220 consume this response shape.
      return jsonResponse({ success: true, message_id: result.messageId, data: result.raw });
    }
```

Add the import at the top of the file, beside the existing `_shared` imports:

```ts
import { sendTemplate, upsertOutboundConversation } from "../_shared/whatsappPartnerOps.ts";
```

Then delete the now-duplicated local definitions, keeping every other handler working:

- `upsertOutboundConversation` at `:35-88` — deleted; the import replaces it. Other callers (`whatsapp_send_message`, `whatsapp_send_media`) now use the shared version, whose signature is identical apart from returning a boolean they may ignore.
- `registerWhatsAppPhone` at `:787-818` and `sendWhatsAppWithRetry` at `:820-870` — these are nested inside `Deno.serve` and are still called by `whatsapp_send_message`, `whatsapp_send_media`, `whatsapp_send_interactive`, and the manual `whatsapp_register_phone` action. **Leave them in place for now.** Only `whatsapp_send_template` moves to the shared op in this plan; the remaining callers migrate in a later plan. Duplication here is deliberate and temporary — deleting them now would force all four other handlers into this task and blow its blast radius.

- [ ] **Step 6: Verify the existing suites still pass**

Run: `deno test --allow-env supabase/functions/_shared/ supabase/functions/messaging-api/`
Expected: PASS — every pre-existing test unchanged. If `whatsappAccess.test.ts` or `whatsappWorkspaceAccess.test.ts` fails, the extraction changed authorization behaviour; revert and re-do Step 5.

Then type-check the handler you modified — the existing tests import
`whatsappAccess.ts`, **not** `index.ts`, so they would not catch a type error
in the file you just edited:

Run: `deno check --no-lock supabase/functions/messaging-api/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "refactor(whatsapp): extract sendTemplate/listTemplates into shared role-free ops" -- supabase/functions/_shared/whatsappPartnerOps.ts supabase/functions/_shared/whatsappPartnerOps.test.ts supabase/functions/messaging-api/index.ts
```

---

### Task 6: The `partner-api` edge function

**Files:**
- Create: `supabase/functions/partner-api/index.ts`
- Create: `supabase/functions/partner-api/router.ts`
- Create: `supabase/functions/partner-api/router.test.ts`
- **No change to `supabase/config.toml`** — see Step 1; that file is local-CLI-only and is never deployed.

**Interfaces:**
- Consumes: everything produced by Tasks 2-5.
- Produces: `HTTP POST /functions/v1/partner-api` accepting `{ action }` of `get_status`, `send_template`, `list_templates`.

- [ ] **Step 1: Confirm the gateway lets an unauthenticated request through**

**Do not add a `[functions.partner-api]` block to `supabase/config.toml`.**
That file's first line reads *"Local CLI namespace only — does not affect
runtime"*, and the deploy copies only function directories into the functions
volume — `config.toml` is never deployed. Adding a block there would create a
false sense that the gateway had been configured.

The live stack instead has JWT verification disabled **globally**: the
functions container carries `VERIFY_JWT=false` and `FUNCTIONS_VERIFY_JWT=false`
(verified on the Contabo host, 2026-08-13). So `partner-api` needs no gateway
change — and, importantly, **every edge function on this stack is solely
responsible for authenticating its own callers**, which is exactly what Task 2
provides.

Re-confirm before relying on it:

```bash
# via ssh-contabo-mcp
docker inspect $(docker ps --format '{{.Names}}' | grep -i functions | head -1)   | grep -iE "VERIFY_JWT"
```

Expected: `VERIFY_JWT=false` and `FUNCTIONS_VERIFY_JWT=false`. If either is
`true`, stop — the Kong/edge-runtime route configuration must be changed
before this function can work, and that is a deployment task not covered here.

- [ ] **Step 2: Write the failing router test**

Create `supabase/functions/partner-api/router.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { requiredScopeFor, isSendAction } from "./router.ts";

Deno.test("each action maps to its required scope", () => {
  assertEquals(requiredScopeFor("send_template"), "whatsapp:template.send");
  assertEquals(requiredScopeFor("list_templates"), "whatsapp:templates.read");
  assertEquals(requiredScopeFor("get_status"), null);
});

Deno.test("unknown actions have no scope and are rejected upstream", () => {
  assertEquals(requiredScopeFor("drop_database"), undefined);
  // Inherited Object properties must not be mistaken for actions.
  assertEquals(requiredScopeFor("toString"), undefined);
  assertEquals(requiredScopeFor("constructor"), undefined);
});

Deno.test("only send actions require an idempotency key", () => {
  assertEquals(isSendAction("send_template"), true);
  assertEquals(isSendAction("list_templates"), false);
  assertEquals(isSendAction("get_status"), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno test --allow-env supabase/functions/partner-api/router.test.ts`
Expected: FAIL — `Module not found "./router.ts"`.

- [ ] **Step 4: Write the router**

Create `supabase/functions/partner-api/router.ts`:

```ts
import type { PartnerScope } from "../_shared/partnerApiKeys.ts";

/** null = no scope required; undefined = unknown action. */
const ACTION_SCOPES: Record<string, PartnerScope | null> = {
  get_status: null,
  send_template: "whatsapp:template.send",
  list_templates: "whatsapp:templates.read",
};

export function requiredScopeFor(action: string): PartnerScope | null | undefined {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an action
  // named "toString" or "constructor" would resolve as a known action.
  return Object.hasOwn(ACTION_SCOPES, action) ? ACTION_SCOPES[action] : undefined;
}

/** Send actions cost money and reach a real customer, so they demand an
 *  Idempotency-Key and consume quota. Reads do neither. */
export function isSendAction(action: string): boolean {
  return action === "send_template";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno test --allow-env supabase/functions/partner-api/router.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Write the function entrypoint**

Create `supabase/functions/partner-api/index.ts`:

```ts
// Partner API — machine-authenticated door into WhatsApp sending.
//
// This function authenticates and authorizes; all WhatsApp behaviour lives in
// _shared/whatsappPartnerOps.ts, which the JWT door also calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertScope,
  authenticatePartnerKey,
  PartnerAuthError,
  type PartnerKeyRecord,
} from "../_shared/partnerApiKeys.ts";
import {
  checkRateLimit,
  recordUsage,
  releaseQuota,
  reserveQuota,
  touchKey,
} from "../_shared/partnerApiMetering.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
  markIndeterminate,
} from "../_shared/partnerApiIdempotency.ts";
import {
  listTemplates,
  sendTemplate,
  WhatsAppOpError,
} from "../_shared/whatsappPartnerOps.ts";
import { isSendAction, requiredScopeFor } from "./router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-postora-key, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function errorBody(code: string, message: string, retryable: boolean, details?: unknown) {
  return { success: false, error: { code, message, retryable, ...(details ? { details } : {}) } };
}

/**
 * Every response carries a request id, success or failure.
 *
 * Without one a partner reporting "the 09:14 send failed" gives us nothing to
 * grep for: the partner key is hashed, message bodies are never logged, and a
 * failed send has no Meta message id. This is the only correlation handle
 * between their logs and ours, and the spec requires it in the normalized
 * response.
 */
function withRequestId<T extends Record<string, unknown>>(
  body: T,
  requestId: string,
): T & { request_id: string } {
  return { ...body, request_id: requestId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Declared first: every exit path below stamps it, including the ones that
  // run before a key is authenticated. `const` is not hoisted, so declaring it
  // later would make the method-not-allowed branch a ReferenceError.
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") {
    // Before authentication, so there is no key to bill and no ledger row -
    // but the caller still gets a correlatable id.
    return json(withRequestId(errorBody("method_not_allowed", "Use POST", false), requestId),
                405, { "X-Postora-Request-Id": requestId });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let record: PartnerKeyRecord | null = null;
  let action = "unknown";
  let idempotencyKey: string | null = null;

  // Bound once so every exit path stamps the request id automatically. The
  // alternative - adding a trailing argument at each call site - is how
  // touchKey ended up implemented but never called.
  const finish = (
    status: number,
    billable: boolean,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    errorCode?: string,
  ) => respond(admin, record!, action, status, billable, body, extraHeaders,
               errorCode, requestId);

  try {
    record = await authenticatePartnerKey(admin, req.headers.get("x-postora-key") ?? "");

    const body = await req.json().catch(() => ({}));
    action = String(body.action ?? "");

    const scope = requiredScopeFor(action);
    if (scope === undefined) {
      return await finish(400, false,
        errorBody("unknown_action", `Unknown action: ${action}`, false), {}, "unknown_action");
    }
    if (scope !== null) assertScope(record, scope);

    await checkRateLimit(admin, record);

    // Resolve the key's pinned account. The composite FK already guarantees it
    // belongs to this workspace, so this read cannot cross a tenant boundary.
    const { data: account, error: accountError } = await admin
      .from("social_accounts")
      .select("id, user_id, workspace_id, platform, platform_user_id, access_token, " +
              "is_active, needs_reauth, token_expires_at, account_metadata")
      .eq("id", record.socialAccountId)
      .maybeSingle();

    // A database error is not "not connected" — do not disguise one as the other.
    if (accountError) {
      return await respond(
        admin, record, action, 500, false,
        errorBody("internal_error", "Could not resolve the account", true),
        {}, "internal_error",
      );
    }

    // The composite FK proves the account is in this workspace. It does NOT
    // prove the account is WhatsApp — a mis-created key could pin a Facebook
    // page, so check platform explicitly, as the human resolver does
    // (_shared/whatsappWorkspaceAccess.ts:124-136).
    if (!account || account.platform !== "whatsapp" || !account.is_active) {
      return await respond(
        admin, record, action, 409, false,
        errorBody("account_not_connected", "The WhatsApp account is not connected", false),
        {}, "account_not_connected",
      );
    }

    // Spec §9: preflight health, so a partner gets a typed, actionable error
    // instead of a raw Meta rejection. refresh-tokens has no WhatsApp path,
    // so an expired token stays expired until someone reconnects.
    const tokenExpired = account.token_expires_at &&
      new Date(account.token_expires_at) <= new Date();
    if (account.needs_reauth || tokenExpired) {
      return await respond(
        admin, record, action, 401, false,
        errorBody("account_needs_reauth",
          "The WhatsApp connection needs to be re-authorized in Postora", false),
        {}, "account_needs_reauth",
      );
    }

    const ctx = {
      admin,
      accountId: account.id,
      ownerId: account.user_id,
      workspaceId: account.workspace_id,
      phoneNumberId: account.platform_user_id,
      accessToken: account.access_token,
    };

    if (action === "get_status") {
      await touchKey(admin, record);
      return await finish(200, false, {
        success: true,
        whatsapp_connected: true,
        phone_number_id: account.platform_user_id,
        workspace_id: account.workspace_id,
      });
    }

    if (action === "list_templates") {
      const wabaId = (account.account_metadata as Record<string, unknown> | null)?.waba_id;
      if (!wabaId) {
        return await respond(
          admin, record, action, 409, false,
          errorBody("account_not_connected", "No WABA id recorded for this account", false),
        );
      }
      const templates = await listTemplates(ctx, String(wabaId));
      await touchKey(admin, record);
      return await finish(200, false, { success: true, templates });
    }

    // ---- send_template ----
    idempotencyKey = req.headers.get("idempotency-key");
    if (isSendAction(action) && !idempotencyKey) {
      return await respond(
        admin, record, action, 400, false,
        errorBody("missing_idempotency_key", "Idempotency-Key header is required for sends", false),
      );
    }

    // Validate BEFORE claiming. Claiming first would leave an invalid request
    // stuck in `processing` forever, poisoning that idempotency key.
    if (!body.recipient_phone || !body.template_name) {
      return await respond(
        admin, record, action, 400, false,
        errorBody("invalid_request", "recipient_phone and template_name are required", false),
      );
    }

    const requestHash = await hashRequest({
      action,
      recipient_phone: body.recipient_phone,
      template_name: body.template_name,
      template_language: body.template_language,
      template_components: body.template_components ?? null,
    });

    const claim = await claimIdempotency(admin, record.id, idempotencyKey!, requestHash);

    if (claim.outcome === "replay") {
      // A replay costs nothing and must not consume quota.
      return json(
        withRequestId(claim.body as Record<string, unknown>, requestId),
        claim.httpStatus,
        { "Idempotency-Replayed": "true", "X-Postora-Request-Id": requestId },
      );
    }
    if (claim.outcome === "conflict") {
      return await respond(
        admin, record, action, 409, false,
        errorBody("idempotency_conflict", "This Idempotency-Key was used with a different body", false),
      );
    }
    if (claim.outcome === "in_progress") {
      return await respond(
        admin, record, action, 409, false,
        errorBody("idempotency_in_progress", "An identical request is still processing", true),
        { "Retry-After": "2" },
      );
    }
    if (claim.outcome === "indeterminate") {
      return await respond(
        admin, record, action, 409, false,
        errorBody("idempotency_indeterminate",
          "A previous attempt may have been delivered; resolve it before retrying", false),
      );
    }

    // Reserve quota only once we are actually about to send. On any definite
    // rejection below we release it, so a partner is charged only for messages
    // Meta accepted. On an indeterminate outcome we deliberately do NOT
    // release: the message may have been delivered.
    const reserved = await reserveQuota(admin, record);
    if (!reserved) {
      // reserve_partner_quota increments before it reports, so a refused
      // attempt must give its unit back. Otherwise every rejected call pushes
      // current_usage_count further past the quota and the number stops
      // meaning anything for reporting.
      await releaseQuota(admin, record);
      // Settle the idempotency claim before returning, or a retry of this same
      // request would see `processing` forever instead of a clear quota error.
      const body = errorBody("quota_exceeded", "Monthly quota exhausted for this key", false);
      await completeIdempotency(admin, record.id, idempotencyKey!, 429, body)
        .catch((e) => console.error("[partner-api] settle after quota refusal failed:", e));
      return await finish(429, false, body, {}, "quota_exceeded");
    }

    try {
      const result = await sendTemplate(ctx, {
        recipientPhone: String(body.recipient_phone),
        templateName: String(body.template_name),
        templateLanguage: String(body.template_language ?? "en_US"),
        components: body.template_components,
      });

      const success = {
        success: true,
        message_id: result.messageId,
        state: "accepted_by_meta",
        recorded_in_inbox: result.persisted,
      };

      // Meta has ACCEPTED the message at this point — the customer may already
      // have it. A bookkeeping failure here must never be reported as a failed
      // or indeterminate send, or the partner will show a delivered message as
      // undelivered. But the claim still has to be settled somehow: if the row
      // stays `processing`, its lease expires, and the partner's retry would
      // take it over and send a SECOND message to a real customer.
      try {
        await completeIdempotency(admin, record.id, idempotencyKey!, 200, success);
      } catch (settleError) {
        console.error("[partner-api] settle failed after a successful send:", settleError);
        // Best effort, and deliberately not awaited into the failure path:
        // `indeterminate` is the one state no retry will ever re-send from,
        // which is exactly the protection needed here.
        await markIndeterminate(admin, record.id, idempotencyKey!).catch(() => {});
      }

      return await finish(200, true, success);
    } catch (err) {
      // A network failure after the request left leaves us unable to know
      // whether Meta delivered it. Never auto-retry, and never release the
      // quota reservation — the message may well have been sent.
      if (!(err instanceof WhatsAppOpError)) {
        await markIndeterminate(admin, record.id, idempotencyKey!);
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      // Only a DEFINITE rejection may be refunded and settled as a failure.
      // An indeterminate one (5xx, missing message id) may already have
      // reached the customer, so it keeps its quota unit and becomes
      // non-resendable — the same treatment as a transport failure.
      if (err.indeterminate) {
        await markIndeterminate(admin, record.id, idempotencyKey!)
          .catch((e) => console.error("[partner-api] indeterminate mark failed:", e));
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false,
          err.metaCode ? { meta_code: err.metaCode } : undefined);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      await releaseQuota(admin, record);
      const failure = errorBody(err.code, err.message, false,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      // Settling must not turn a clean rejection into a generic 500.
      await completeIdempotency(admin, record.id, idempotencyKey!, err.status, failure)
        .catch((e) => console.error("[partner-api] settle after rejection failed:", e));
      return await finish(err.status, false, failure, {}, err.code);
    }
  } catch (err) {
    // listTemplates and the account lookups can also throw WhatsAppOpError.
    // Without this branch a token failure while listing templates would be
    // reported as a generic internal_error instead of account_needs_reauth.
    if (err instanceof WhatsAppOpError) {
      const body = errorBody(err.code, err.message, err.status >= 500,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      if (record) return await finish(err.status, false, body, {}, err.code);
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    if (err instanceof PartnerAuthError) {
      const retryable = err.code === "rate_limited";
      const body = errorBody(err.code, err.message, retryable);
      if (record) {
        return await finish(err.status, false, body, {}, err.code);
      }
      // No key resolved yet, so there is no ledger row to write - but the
      // caller still gets a correlatable id.
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    console.error(`[partner-api] unhandled (request ${requestId}, key ${record?.keyPrefix ?? "none"}):`, err);
    const body = errorBody("internal_error", "Unexpected error", true);
    if (record) return await finish(500, false, body, {}, "internal_error");
    return json(withRequestId(body, requestId), 500,
                { "X-Postora-Request-Id": requestId });
  }
});

/** Emit the response, stamp it with the request id, and append exactly one
 *  usage-ledger row for it. */
async function respond(
  // deno-lint-ignore no-explicit-any
  admin: any,
  record: PartnerKeyRecord,
  action: string,
  status: number,
  billable: boolean,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  errorCode?: string,
  requestId?: string,
) {
  await recordUsage(admin, {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable,
    httpStatus: status,
    errorCode,
  });
  const stamped = requestId && body && typeof body === "object"
    ? withRequestId(body as Record<string, unknown>, requestId)
    : body;
  // Also a header, so a partner can correlate without parsing the body -
  // which matters for the 5xx paths where the body may not be ours.
  return json(stamped, status, {
    ...extraHeaders,
    ...(requestId ? { "X-Postora-Request-Id": requestId } : {}),
  });
}
```

- [ ] **Step 7: Type-check the function**

Run: `deno check supabase/functions/partner-api/index.ts`
Expected: no errors.

- [ ] **Step 8: Run every partner test**

Run: `deno test --allow-env supabase/functions/partner-api/ supabase/functions/_shared/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add machine-authenticated WhatsApp template send endpoint" -- supabase/functions/partner-api/
```

---

### Task 7: Scope-enforcement tests (application layer)

**Files:**
- Create: `supabase/functions/partner-api/isolation.test.ts`

**Interfaces:**
- Consumes: `authenticatePartnerKey`, `assertScope` (Task 2); `requiredScopeFor` (Task 6).

**What this task does and does not prove.** These are unit tests over
hand-written stubs, so they verify the *application layer*: that each action
demands the right scope, that a revoked or expired key is refused, and that an
unknown key is indistinguishable from a malformed one. They deliberately do
**not** claim to prove cross-workspace isolation - a stub returning a
workspace-A row proves nothing about what Postgres would allow. The isolation
guarantee itself is enforced by the composite foreign key and tested for real
in **Task 9**. Read the two together; neither is sufficient alone.

It follows the pattern established by the cross-workspace suite in commit
`c5f16035`.

- [ ] **Step 1: Write the isolation tests**

Create `supabase/functions/partner-api/isolation.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  assertScope,
  authenticatePartnerKey,
  PartnerAuthError,
} from "../_shared/partnerApiKeys.ts";
import { requiredScopeFor } from "./router.ts";

const WS_A_KEY = {
  id: "key-a", workspace_id: "ws-a", social_account_id: "acct-a",
  key_prefix: "pk_live_aaaa", scopes: ["whatsapp:template.send"],
  rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
};

function stubClient(row: unknown) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("the target account comes from the key row, not the request body", async () => {
  const record = await authenticatePartnerKey(stubClient(WS_A_KEY), "pk_live_whatever");
  assertEquals(record.workspaceId, "ws-a");
  assertEquals(record.socialAccountId, "acct-a");
  // This is the point worth asserting: PartnerKeyRecord exposes no way for a
  // caller to name a different account, so partner-api has nothing to trust
  // from the request. Whether the pairing is legal at all is enforced by the
  // composite FK and proven in Task 9, not here.
});

Deno.test("a send-only key cannot read templates", () => {
  const record = {
    id: "key-a", workspaceId: "ws-a", socialAccountId: "acct-a",
    keyPrefix: "pk_live_aaaa", scopes: ["whatsapp:template.send"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  const error = assertThrows(
    () => assertScope(record, requiredScopeFor("list_templates")!),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
  assertEquals(error.status, 403);
});

Deno.test("a read-only key cannot send", () => {
  const record = {
    id: "key-b", workspaceId: "ws-b", socialAccountId: "acct-b",
    keyPrefix: "pk_live_bbbb", scopes: ["whatsapp:templates.read"],
    rateLimitPerMin: 60, monthlyQuota: null, expiresAt: null, revokedAt: null,
  };
  const error = assertThrows(
    () => assertScope(record, requiredScopeFor("send_template")!),
    PartnerAuthError,
  );
  assertEquals(error.code, "insufficient_scope");
});

Deno.test("a revoked key is rejected even with correct scopes", async () => {
  const revoked = { ...WS_A_KEY, revoked_at: "2026-08-01T00:00:00Z" };
  const error = await assertRejects(
    () => authenticatePartnerKey(stubClient(revoked), "pk_live_whatever"),
    PartnerAuthError,
  );
  assertEquals(error.code, "key_revoked");
});

Deno.test("an unknown key is indistinguishable from a malformed one", async () => {
  const unknown = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "pk_live_unknown"),
    PartnerAuthError,
  );
  const malformed = await assertRejects(
    () => authenticatePartnerKey(stubClient(null), "not-a-key"),
    PartnerAuthError,
  );
  // Identical code and status: keys are not enumerable by probing.
  assertEquals(unknown.code, malformed.code);
  assertEquals(unknown.status, malformed.status);
});
```

- [ ] **Step 2: Run the tests**

Run: `deno test --allow-env supabase/functions/partner-api/isolation.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 3: Re-verify the database-level guarantee**

The tests above cover the application layer only. The isolation guarantee is
the composite FK, exercised by the tenancy case in the Task 9 suite. Run Task 9
after this task and confirm `ok - cross-workspace key rejected by the database`
appears in its output. If the migration changed since, re-run it in full.

- [ ] **Step 4: Run the full suite**

Run: `deno test --allow-env supabase/functions/_shared/ supabase/functions/partner-api/ supabase/functions/messaging-api/`
Expected: PASS.

**Do not run `deno test supabase/functions/`.** Several existing suites
(`check-user-mfa/index.test.ts`, `check-connection-health/index.test.ts`)
perform live `fetch()` calls against a running Supabase stack: without
`--allow-net` Deno denies them, and with it they fail anyway because the local
stack is broken in this project. The three directories above are the hermetic
unit-test gate.

- [ ] **Step 5: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "test(partner-api): cover scope enforcement and key rejection paths" -- supabase/functions/partner-api/isolation.test.ts
```

---

---

### Task 8: Operator key-creation script

**Files:**
- Create: `scripts/create-partner-key.ts`

**Interfaces:**
- Consumes: `generatePartnerKey` (Task 2); tables from Task 1.
- Produces: the only way to mint a key until the UI lands in Plan 3.

Without this, Task 6 is unreachable: the endpoint authenticates keys that
nothing can create, and the only testable path is the invalid-key case. The
spec puts key management in Phase 1 for that reason.

- [ ] **Step 1: Write the script**

```ts
// Mint a partner API key. Operator-only: run with the service-role key.
//
//   deno run --allow-env --allow-net scripts/create-partner-key.ts //     --workspace <uuid> --account <uuid> --name "Danat backend" //     --scopes whatsapp:template.send,whatsapp:webhooks.manage //     --quota 5000
//
// The plaintext key is printed ONCE and never stored.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { generatePartnerKey } from "../supabase/functions/_shared/partnerApiKeys.ts";

function arg(name: string): string | undefined {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const workspaceId = arg("workspace");
const accountId = arg("account");
const name = arg("name");
const scopes = (arg("scopes") ?? "").split(",").filter(Boolean);
// Number("--account") is NaN, and NaN serializes to null, which means
// UNLIMITED quota. Validate rather than silently minting an uncapped key.
const rawQuota = arg("quota");
let quota: number | null = null;
if (rawQuota !== undefined) {
  quota = Number(rawQuota);
  if (!Number.isSafeInteger(quota) || quota < 0) {
    console.error(`--quota must be a non-negative integer, got: ${rawQuota}`);
    Deno.exit(2);
  }
}

const ALLOWED_SCOPES = [
  "whatsapp:template.send",
  "whatsapp:templates.read",
  "whatsapp:webhooks.manage",
];

if (!workspaceId || !accountId || !name || scopes.length === 0) {
  console.error("Missing --workspace, --account, --name, or --scopes");
  Deno.exit(2);
}

const badScopes = scopes.filter((sc) => !ALLOWED_SCOPES.includes(sc));
if (badScopes.length > 0) {
  console.error(`Unknown scope(s): ${badScopes.join(", ")}`);
  console.error(`Allowed: ${ALLOWED_SCOPES.join(", ")}`);
  Deno.exit(2);
}

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Refuse to pin a non-WhatsApp or unhealthy account. The composite FK proves
// only that the account is in the workspace, never that it can send.
const { data: account, error } = await admin
  .from("social_accounts")
  .select("id, platform, workspace_id, is_active, needs_reauth")
  .eq("id", accountId)
  .maybeSingle();

if (error) { console.error("Lookup failed:", error.message); Deno.exit(1); }
if (!account) { console.error("No such social account"); Deno.exit(1); }
if (account.platform !== "whatsapp") {
  console.error(`Account is ${account.platform}, not whatsapp`); Deno.exit(1);
}
if (account.workspace_id !== workspaceId) {
  console.error("Account does not belong to that workspace"); Deno.exit(1);
}
if (!account.is_active || account.needs_reauth) {
  console.error("Account is inactive or needs re-authorization"); Deno.exit(1);
}

const { key, prefix, hash } = await generatePartnerKey();

const { error: insertError } = await admin.from("partner_api_keys").insert({
  workspace_id: workspaceId,
  social_account_id: accountId,
  name,
  key_prefix: prefix,
  key_hash: hash,
  scopes,
  monthly_quota: quota,
});

if (insertError) { console.error("Insert failed:", insertError.message); Deno.exit(1); }

console.log("
Key created. Copy it now — it is never shown again:
");
console.log(`  ${key}
`);
console.log(`  prefix: ${prefix}  scopes: ${scopes.join(", ")}`);
```

- [ ] **Step 2: Verify it refuses a non-WhatsApp account**

Run it against a Facebook account id from the same workspace.
Expected: `Account is facebook, not whatsapp`, exit code 1, no row inserted.

- [ ] **Step 3: Create a real key against the WhatsApp account**

Expected: a `pk_live_…` key printed once. Confirm the stored row holds only
the hash:

```sql
SELECT key_prefix, scopes, monthly_quota, key_hash IS NOT NULL AS hashed
  FROM partner_api_keys ORDER BY created_at DESC LIMIT 1;
```

Expected: the prefix matches the printed key's first 12 characters, and the
plaintext appears nowhere in the table.

> **Precondition, verified live 2026-08-13.** The machine-auth path itself works
> end to end: a call from the Danat host to
> `https://api.postora.cloud/functions/v1/ecommerce-whatsapp-api` with a real
> `x-api-key` returned `200` with
> `{"success":true,"api_key_valid":true,"whatsapp_connected":false,...}` — proving
> the full chain (Danat host → Cloudflare → Kong → edge function → database
> lookup → response) is sound with no gateway change.
>
> But `whatsapp_connected: false` on the account tested means **no WhatsApp
> account is connected to it yet**. This script refuses to mint a key for a
> non-WhatsApp or unhealthy account, so Phase 2 of the integration guide
> (Embedded Signup, §13 of the spec) is a hard prerequisite for this task, not a
> parallel activity. Until a WABA is connected, Step 3 will correctly exit with
> "No such social account" or "Account is ... not whatsapp".

- [ ] **Step 4: Smoke-test the endpoint end to end**

```bash
curl -s -X POST https://api.postora.cloud/functions/v1/partner-api   -H "X-Postora-Key: <the key>" -H 'content-type: application/json'   -d '{"action":"get_status"}'
```

Expected: `{"success":true,"whatsapp_connected":true,...}`.

- [ ] **Step 5: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` — this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "feat(partner-api): add operator key-creation script" -- scripts/create-partner-key.ts
```

---

---

### Task 9: SQL integration tests against a real database

**Files:**
- Create: `supabase/tests/partner_api_test.sql`
- Create: `supabase/tests/partner_api_race_fixture.sql`

**Interfaces:**
- Consumes: every object created in Task 1.

> **These behaviours were verified against real Postgres before this task was
> written** (scratch database on the production instance, 2026-08-13). The
> `claim_partner_idempotency` function compiled and produced:
>
> | Scenario | Outcome |
> |---|---|
> | First claim | `claimed` |
> | Concurrent duplicate, same body | `in_progress` |
> | Same key, different body | `conflict` |
> | Settled row, same body | `replay`, returning the stored `wamid.X` |
> | Row marked `indeterminate` | `indeterminate` — never re-sends |
> | `processing` row whose lease expired | `claimed` — takes over, so a crashed attempt cannot wedge the key |
> | Row past `expires_at` | `claimed` — pruned rather than replayed as a stale success |
>
> The scratch database was dropped afterwards. Task 9 turns these into a
> repeatable suite; the results above are why the design is trusted, rather
> than the stub assertions in Tasks 2-8.

**Why this task exists.** The Deno tests in Tasks 2-8 hand-write their own
stubs, so they verify the *mapping* between a stubbed response and a return
value - not that the database does what the design claims. A stub returning
`{allowed: false}` proves nothing about whether the quota SQL is atomic. Every
load-bearing guarantee in this plan lives in SQL, and this is where those
guarantees are actually tested.

**What this task still does NOT cover**, stated plainly so nobody mistakes a
green run for full coverage:

- Only the idempotency claim is raced under a real barrier (Step 4). The
  **rate bucket** and **quota reservation** are tested sequentially, so their
  atomicity is argued from the SQL shape rather than demonstrated. Both use
  single-statement `UPDATE ... RETURNING` / `INSERT ... ON CONFLICT DO UPDATE
  ... RETURNING`, which Postgres executes atomically, but that is reasoning
  rather than evidence.
- The edge function itself is never invoked. Task 6's orchestration - the order
  of scope check, rate limit, claim, reserve, send, settle - has no automated
  test at any layer; the Task 8 smoke test is the only end-to-end exercise, and
  it covers one happy path.
- Nothing here talks to Meta. Every Graph interaction is stubbed in Task 5.

- [ ] **Step 1: Write the SQL test script**

Create `supabase/tests/partner_api_test.sql`:

```sql
-- Integration tests for the partner API database objects.
-- Run against a scratch database that has the partner API migration applied.
-- Any FAIL raises an exception and aborts the script.

CREATE OR REPLACE FUNCTION assert_eq(actual ANYELEMENT, expected ANYELEMENT, label TEXT)
RETURNS VOID LANGUAGE plpgsql AS $fn$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL %: expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok - %', label;
END; $fn$;

BEGIN;

-- Fixture: two workspaces, one WhatsApp account in workspace A, one key.
INSERT INTO workspaces (id, owner_id, name, is_personal) VALUES
  ('11111111-1111-1111-1111-111111111111', (SELECT id FROM auth.users LIMIT 1), 'ws-a', false),
  ('22222222-2222-2222-2222-222222222222', (SELECT id FROM auth.users LIMIT 1), 'ws-b', false);

INSERT INTO social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id)
VALUES ('33333333-3333-3333-3333-333333333333',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '1234567890', 'tok',
        '11111111-1111-1111-1111-111111111111');

INSERT INTO partner_api_keys (id, workspace_id, social_account_id, name, key_prefix, key_hash,
                              scopes, rate_limit_per_min, monthly_quota)
VALUES ('44444444-4444-4444-4444-444444444444',
        '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333',
        'test', 'pk_live_test', 'hash-1', ARRAY['whatsapp:template.send'], 3, 2);

-- === Tenancy: the control the whole design rests on ===
DO $t$
BEGIN
  INSERT INTO partner_api_keys (workspace_id, social_account_id, name, key_prefix, key_hash)
  VALUES ('22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333', 'bad', 'pk_live_bad', 'hash-bad');
  RAISE EXCEPTION 'FAIL tenancy: a cross-workspace key was accepted';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'ok - cross-workspace key rejected by the database';
END $t$;

-- === Quota: reserve, exceed, release, lazy monthly reset ===
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'first reservation allowed');
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'second reservation allowed (quota = 2)');
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 false, 'third reservation refused');

-- The refused reservation above still incremented, so the caller releases it.
-- Without that release, repeated refusals inflate the count indefinitely.
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 3, 'a refused reservation still incremented, so it must be released');

SELECT release_partner_quota('44444444-4444-4444-4444-444444444444');
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 2, 'release refunds exactly one unit');

UPDATE partner_api_keys SET last_reset_at = date_trunc('month', now()) - INTERVAL '1 month'
 WHERE id = '44444444-4444-4444-4444-444444444444';
SELECT assert_eq((SELECT allowed FROM reserve_partner_quota('44444444-4444-4444-4444-444444444444')),
                 true, 'new month allows again');
SELECT assert_eq((SELECT current_usage_count FROM partner_api_keys
                   WHERE id = '44444444-4444-4444-4444-444444444444'),
                 1, 'new month resets the count to 1');

-- === Rate limit ===
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 1 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 2 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), true,  'rate 3 of 3');
SELECT assert_eq(consume_partner_rate('44444444-4444-4444-4444-444444444444', 3), false, 'rate 4 refused');

-- === Idempotency ===
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'claimed', 'first claim wins');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'in_progress', 'concurrent duplicate sees in_progress');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-DIFFERENT')),
                 'conflict', 'same key with a different body is a conflict');

UPDATE partner_api_idempotency
   SET state = 'completed', http_status = 200,
       response_body = '{"message_id":"wamid.X"}'::jsonb, locked_until = NULL
 WHERE key_id = '44444444-4444-4444-4444-444444444444' AND idempotency_key = 'idem-1';

SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'replay', 'completed claim replays');
SELECT assert_eq((SELECT response_body->>'message_id' FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-1', 'hash-a')),
                 'wamid.X', 'replay returns the stored response');

-- An indeterminate row must never hand out a fresh claim.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-2', 'hash-b', 'indeterminate');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-2', 'hash-b')),
                 'indeterminate', 'indeterminate never re-sends');

-- A crashed attempt must not wedge the key forever.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state, locked_until)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-3', 'hash-c', 'processing',
        now() - INTERVAL '5 minutes');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-3', 'hash-c')),
                 'claimed', 'an expired lease is taken over');

-- Expired rows are pruned, not replayed as stale successes.
INSERT INTO partner_api_idempotency (key_id, idempotency_key, request_hash, state,
                                     http_status, response_body, expires_at)
VALUES ('44444444-4444-4444-4444-444444444444', 'idem-4', 'hash-d', 'completed',
        200, '{"message_id":"old"}'::jsonb, now() - INTERVAL '1 day');
SELECT assert_eq((SELECT outcome FROM claim_partner_idempotency(
                    '44444444-4444-4444-4444-444444444444', 'idem-4', 'hash-d')),
                 'claimed', 'an expired row is pruned, not replayed');

ROLLBACK;
```

- [ ] **Step 2: Prepare a scratch database**

```bash
# via ssh-contabo-mcp. Separate invocations: CREATE/DROP DATABASE cannot run
# inside a transaction block, and psql wraps multiple -c statements in one.
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -q -c "DROP DATABASE IF EXISTS partnertest;"
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -q -c "CREATE DATABASE partnertest;"
```

The fixture references `auth.users`, `workspaces`, and `social_accounts`, so
load the schema first, then apply the Task 1 migration:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  pg_dump -U postgres --schema-only postgres > /tmp/schema.sql
docker exec -i postorasupabase-supabase-j8axyh-supabase-db \
  psql -U postgres -d partnertest -q < /tmp/schema.sql
```

Then apply the Task 1 migration — without this the suite reaches missing
`partner_api_*` objects and fails on the first statement:

```bash
docker cp supabase/migrations/20260813120000_partner_api_foundation.sql \
  postorasupabase-supabase-j8axyh-supabase-db:/tmp/mig.sql
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U postgres -d partnertest -v ON_ERROR_STOP=1 -q -f /tmp/mig.sql
```

Expected: no errors.

A schema-only dump carries no rows, so insert one throwaway user for the
fixture's `(SELECT id FROM auth.users LIMIT 1)`:

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d partnertest -q \
  -c "INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'test@example.invalid') ON CONFLICT DO NOTHING;"
```

If that insert fails on NOT NULL columns specific to this Supabase version,
add the columns it names - do not weaken the fixture.

- [ ] **Step 3: Run the suite**

```bash
docker exec -i postorasupabase-supabase-j8axyh-supabase-db \
  psql -U postgres -d partnertest -v ON_ERROR_STOP=1 < supabase/tests/partner_api_test.sql
```

Expected: a run of `ok - ...` notices and no `FAIL`. The script ends in
`ROLLBACK`, so it leaves nothing behind and is re-runnable.

- [ ] **Step 4: Race two real sessions against the same idempotency key**

Everything in Step 3 is sequential, and a sequential pair of calls produces the
same `claimed` / `in_progress` output that a genuinely concurrent pair would.
It therefore proves nothing about the property that matters: that two
overlapping duplicates cannot both be told to send.

Two things are needed to make this a real test. First, a **committed** fixture
— the Step 3 suite ends in `ROLLBACK`, so its key does not exist afterwards and
the race would fail on the foreign key rather than testing anything. Second, a
**barrier**, so the second session provably contends with the first while it
still holds the row.

Create `supabase/tests/partner_api_race_fixture.sql`:

```sql
-- Committed fixture for the concurrency check. Separate from the main suite,
-- which rolls back.
INSERT INTO workspaces (id, owner_id, name, is_personal)
VALUES ('55555555-5555-5555-5555-555555555555',
        (SELECT id FROM auth.users LIMIT 1), 'ws-race', false)
ON CONFLICT DO NOTHING;

INSERT INTO social_accounts (id, user_id, platform, platform_user_id, access_token, workspace_id)
VALUES ('66666666-6666-6666-6666-666666666666',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '9999999999', 'tok',
        '55555555-5555-5555-5555-555555555555')
ON CONFLICT DO NOTHING;

INSERT INTO partner_api_keys (id, workspace_id, social_account_id, name, key_prefix,
                              key_hash, scopes, rate_limit_per_min, monthly_quota)
VALUES ('77777777-7777-7777-7777-777777777777',
        '55555555-5555-5555-5555-555555555555',
        '66666666-6666-6666-6666-666666666666',
        'race', 'pk_live_race', 'hash-race', ARRAY['whatsapp:template.send'], 1000, NULL)
ON CONFLICT DO NOTHING;
```

Apply it, then run the race:

```bash
D=postorasupabase-supabase-j8axyh-supabase-db
K=77777777-7777-7777-7777-777777777777

docker cp supabase/tests/partner_api_race_fixture.sql $D:/tmp/fix.sql
docker exec $D psql -U postgres -d partnertest -q -f /tmp/fix.sql

# Session 1 claims inside an OPEN transaction and holds it for 5 seconds.
# Session 2 starts while that transaction is still open, so its INSERT blocks
# on the uncommitted unique key — this is the actual contention, not two
# commands that merely started at a similar time.
docker exec $D psql -U postgres -d partnertest -t -c \
  "BEGIN; SELECT outcome FROM claim_partner_idempotency('$K','race-1','hash-r'); SELECT pg_sleep(5); COMMIT;" \
  > /tmp/r1.txt 2>&1 &

sleep 1   # session 1 is now holding the row

docker exec $D psql -U postgres -d partnertest -t -c \
  "SELECT outcome FROM claim_partner_idempotency('$K','race-1','hash-r');" \
  > /tmp/r2.txt 2>&1

wait
echo "session 1: $(grep -oE 'claimed|in_progress|conflict' /tmp/r1.txt | head -1)"
echo "session 2: $(grep -oE 'claimed|in_progress|conflict' /tmp/r2.txt | head -1)"
```

Expected:

```
session 1: claimed
session 2: in_progress
```

Session 2 must also visibly **block** for roughly the remaining 4 seconds —
that wait is the evidence it truly contended rather than running after the
fact. Time it if you want proof: `time` on the second command should show ~4s.

**`session 2: claimed` is a hard failure.** It means two concurrent requests
would each send a message to the same customer — the exact duplicate-send this
mechanism exists to prevent. Stop and re-examine the
`ON CONFLICT DO NOTHING` + `FOR UPDATE` sequence before going further.

Clean up the committed fixture:

```bash
docker exec $D psql -U postgres -d partnertest -q \
  -c "DELETE FROM partner_api_keys WHERE id = '77777777-7777-7777-7777-777777777777';"
```

- [ ] **Step 5: Prove the suite can actually fail**

A green suite that cannot go red is worthless. Temporarily flip the third
quota assertion from `false` to `true` and re-run.

Expected: `ERROR: FAIL third reservation refused: expected true, got false`.
Revert the change and confirm green again.

- [ ] **Step 6: Drop the scratch database**

```bash
docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -q -c "DROP DATABASE partnertest;"
```

- [ ] **Step 7: Commit**

```bash
# Scoped commit (AGENTS.md): never `git add` - this working tree carries
# many unrelated modified files that a broad add would sweep in.
git commit -m "test(partner-api): add SQL integration suite for tenancy, quota, rate, idempotency" -- supabase/tests/partner_api_test.sql supabase/tests/partner_api_race_fixture.sql
```

---

## Mandatory gates before every commit

`AGENTS.md:43-45` requires these on every task in this repo, and the plan's
per-task steps assume them rather than repeating them seven times:

- [ ] Run **`clean-code-guard`** on the changed production code.
- [ ] Run **`test-guard`** on the changed or added tests.
- [ ] Commit **scoped to the task's files** (`git commit -- <files>`), never
      `git add .`. This working tree has many unrelated modified and untracked
      files; a broad add would commit them.
- [ ] Never commit `b64.txt`, logs, backups, or `.env*`.
- [ ] After the final task, run `graphify update .` to refresh the knowledge
      graph (`AGENTS.md:518`).

## Deployment (after all tasks pass review)

`main` auto-deploys the frontend via Dokploy, so ordering matters. Do **not** merge before the backend is live.

1. Apply `20260813120000_partner_api_foundation.sql` to production Postgres via `ssh-contabo-mcp`.
2. Copy `partner-api/`, the changed `_shared/*.ts`, and `messaging-api/index.ts` into
   `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify hashes, then from the stack directory run `docker compose up -d --no-deps functions`. See `docs/runbooks/deploy-edge-function.md`.
3. Confirm the gateway accepts a JWT-less request:
   `curl -s -X POST https://api.postora.cloud/functions/v1/partner-api -H 'content-type: application/json' -d '{}'`
   Expected: `{"success":false,"error":{"code":"invalid_key",...}}` — application output, not a gateway 401.
4. Only then merge to `main`.

## What this plan deliberately does not do

Carried forward to Plans 2 and 3, and listed here so a reviewer does not read their absence as an oversight:

- `register_webhook`, the deliveries outbox, the retry worker, and `message.status` dispatch (Plan 2).
- The Integrations key-management **UI** (Plan 3). Key creation itself is covered by the Task 8 operator script, so this plan is executable end to end.
- Danat's `sendWithWhatsApp` swap, in the other repo (Plan 3).
- Free-form text, media, and interactive sends; inbox reads; the AI bot.
- Fixing `whatsapp_contacts`' `UNIQUE(user_id, phone_number)` workspace bug (spec §5.6) and the non-fatal OAuth success gap (spec §9) — both pre-existing, both flagged, neither caused by this work.
