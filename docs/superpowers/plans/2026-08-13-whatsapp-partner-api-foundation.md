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
- Produces: tables `partner_api_keys`, `partner_api_idempotency`, `partner_api_usage`; RPC `consume_partner_quota(p_key_id uuid)` returning `(allowed boolean, usage_count integer)`.

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

CREATE TABLE public.partner_api_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT false,
  http_status  INTEGER NOT NULL,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX partner_api_usage_ws_time_idx
  ON public.partner_api_usage (workspace_id, created_at DESC);

-- Atomic monthly quota consumption. One statement: no read-then-write race,
-- and the reset happens lazily on first use in a new month (no cron needed).
CREATE OR REPLACE FUNCTION public.consume_partner_quota(p_key_id UUID)
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

REVOKE ALL ON FUNCTION public.consume_partner_quota(UUID) FROM PUBLIC, authenticated, anon;

ALTER TABLE public.partner_api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_usage      ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY "Workspace admins revoke partner keys"
ON public.partner_api_keys FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id = partner_api_keys.workspace_id
     AND m.user_id = auth.uid()
     AND m.role IN ('owner','admin')
));

-- Column-level grants, mirroring the mcp_oauth_tokens precedent: key_hash is
-- never selectable by a client, and only revocation fields are writable.
REVOKE ALL ON public.partner_api_keys FROM authenticated;
GRANT SELECT (id, workspace_id, social_account_id, created_by, revoked_by,
              revoked_reason, name, key_prefix, scopes, rate_limit_per_min,
              monthly_quota, current_usage_count, last_reset_at, last_used_at,
              expires_at, revoked_at, created_at, updated_at)
  ON public.partner_api_keys TO authenticated;
GRANT UPDATE (revoked_at, revoked_by, revoked_reason)
  ON public.partner_api_keys TO authenticated;

CREATE TRIGGER update_partner_api_keys_updated_at
BEFORE UPDATE ON public.partner_api_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
```

- [ ] **Step 2: Rehearse on a throwaway database, not production**

Local `supabase start` is broken in this project, so rehearse inside the production container against a scratch database:

```bash
# via ssh-contabo-mcp
docker exec postorasupabase-supabase-j8axyh-supabase-db \
  psql -U postgres -c "DROP DATABASE IF EXISTS rehearse; CREATE DATABASE rehearse TEMPLATE postgres;"
```

Expected: `CREATE DATABASE`.

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

INSERT INTO social_accounts (id, user_id, platform, platform_user_id, workspace_id)
VALUES ('33333333-3333-3333-3333-333333333333',
        (SELECT id FROM auth.users LIMIT 1), 'whatsapp', '1234567890',
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
git add supabase/migrations/20260813120000_partner_api_foundation.sql
git commit -m "feat(partner-api): add partner key, idempotency, usage tables with DB-enforced tenancy"
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

/** Minimal stub of the supabase-js query chain used by the module. */
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
git add supabase/functions/_shared/partnerApiKeys.ts supabase/functions/_shared/partnerApiKeys.test.ts
git commit -m "feat(partner-api): add hashed key generation, authentication, and scope checks"
```

---

### Task 3: Rate limiting and metering

**Files:**
- Create: `supabase/functions/_shared/partnerApiMetering.ts`
- Create: `supabase/functions/_shared/partnerApiMetering.test.ts`

**Interfaces:**
- Consumes: `PartnerKeyRecord` (Task 2); RPC `consume_partner_quota` (Task 1).
- Produces:
  - `consumeQuota(client, record): Promise<void>` — throws `PartnerAuthError("quota_exceeded", 429)`
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
import { consumeQuota, recordUsage } from "./partnerApiMetering.ts";

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

Deno.test("consumeQuota passes when the key is under quota", async () => {
  await consumeQuota(stubRpc({ allowed: true, usage_count: 5 }), RECORD);
});

Deno.test("consumeQuota throws a non-retryable quota_exceeded when over", async () => {
  const error = await assertRejects(
    () => consumeQuota(stubRpc({ allowed: false, usage_count: 101 }), RECORD),
    PartnerAuthError,
  );
  assertEquals(error.code, "quota_exceeded");
  assertEquals(error.status, 429);
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
 * Consume one unit of monthly quota. The reset is lazy and atomic inside
 * consume_partner_quota, so no cron job and no read-then-write race.
 *
 * quota_exceeded is NOT retryable — unlike rate_limited, waiting does not help
 * until the month rolls over, and partners must branch on that difference.
 */
export async function consumeQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { data, error } = await client.rpc("consume_partner_quota", {
    p_key_id: record.id,
  });
  if (error) {
    throw new PartnerAuthError("Quota check failed", "internal_error", 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) {
    throw new PartnerAuthError(
      "Monthly quota exhausted for this key",
      "quota_exceeded",
      429,
    );
  }
}

/**
 * Sliding-window rate limit over the usage ledger. Counts every request,
 * billable or not, because the limit protects Postora rather than the wallet.
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
  now: Date = new Date(),
): Promise<void> {
  const windowStart = new Date(now.getTime() - 60_000).toISOString();
  const { count, error } = await client
    .from("partner_api_usage")
    .select("id", { count: "exact", head: true })
    .eq("key_id", record.id)
    .gte("created_at", windowStart);

  if (error) return; // Never fail a send because the limiter is unavailable.
  if ((count ?? 0) >= record.rateLimitPerMin) {
    throw new PartnerAuthError(
      "Rate limit exceeded",
      "rate_limited",
      429,
    );
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
git add supabase/functions/_shared/partnerApiMetering.ts supabase/functions/_shared/partnerApiMetering.test.ts
git commit -m "feat(partner-api): add atomic quota consumption, rate limiting, and usage ledger"
```

---

### Task 4: Idempotency state machine

**Files:**
- Create: `supabase/functions/_shared/partnerApiIdempotency.ts`
- Create: `supabase/functions/_shared/partnerApiIdempotency.test.ts`

**Interfaces:**
- Consumes: `partner_api_idempotency` (Task 1).
- Produces:
  - `hashRequest(body: unknown): Promise<string>`
  - `claimIdempotency(client, keyId, idempotencyKey, requestHash): Promise<ClaimResult>`
  - `completeIdempotency(client, keyId, idempotencyKey, httpStatus, body): Promise<void>`
  - `markIndeterminate(client, keyId, idempotencyKey): Promise<void>`
  - `type ClaimResult = { outcome: "claimed" } | { outcome: "replay"; httpStatus: number; body: unknown } | { outcome: "conflict" } | { outcome: "in_progress" } | { outcome: "indeterminate" }`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/_shared/partnerApiIdempotency.test.ts`:

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { claimIdempotency, hashRequest } from "./partnerApiIdempotency.ts";

/**
 * Stub whose insert fails with 23505 when a row already exists, mirroring the
 * real unique-violation path that makes the claim atomic.
 */
function stubClient(existing: Record<string, unknown> | null) {
  return {
    from() {
      return {
        insert() {
          return Promise.resolve(
            existing ? { error: { code: "23505", message: "duplicate key" } } : { error: null },
          );
        },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: existing, error: null }); },
      };
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

Deno.test("claimIdempotency claims a fresh key", async () => {
  const result = await claimIdempotency(stubClient(null), "key-1", "idem-1", "hash-1");
  assertEquals(result.outcome, "claimed");
});

Deno.test("claimIdempotency replays a completed identical request", async () => {
  const existing = {
    state: "completed", request_hash: "hash-1",
    http_status: 200, response_body: { message_id: "wamid.X" },
  };
  const result = await claimIdempotency(stubClient(existing), "key-1", "idem-1", "hash-1");
  assertEquals(result.outcome, "replay");
  if (result.outcome === "replay") {
    assertEquals(result.httpStatus, 200);
    assertEquals((result.body as Record<string, unknown>).message_id, "wamid.X");
  }
});

Deno.test("claimIdempotency reports a conflict when the body differs", async () => {
  const existing = { state: "completed", request_hash: "OTHER", http_status: 200, response_body: {} };
  const result = await claimIdempotency(stubClient(existing), "key-1", "idem-1", "hash-1");
  assertEquals(result.outcome, "conflict");
});

Deno.test("claimIdempotency reports in_progress for a concurrent duplicate", async () => {
  const existing = { state: "processing", request_hash: "hash-1", http_status: null, response_body: null };
  const result = await claimIdempotency(stubClient(existing), "key-1", "idem-1", "hash-1");
  assertEquals(result.outcome, "in_progress");
});

Deno.test("claimIdempotency never re-sends an indeterminate request", async () => {
  const existing = { state: "indeterminate", request_hash: "hash-1", http_status: null, response_body: null };
  const result = await claimIdempotency(stubClient(existing), "key-1", "idem-1", "hash-1");
  assertEquals(result.outcome, "indeterminate");
});
```

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

/** Stable digest of the request body, so a reused key with different content
 *  is detected rather than silently replayed. */
export async function hashRequest(body: unknown): Promise<string> {
  const canonical = JSON.stringify(body, Object.keys(body as object).sort());
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
  const { error } = await client.from("partner_api_idempotency").insert({
    key_id: keyId,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    state: "processing",
    locked_until: new Date(Date.now() + 60_000).toISOString(),
  });

  if (!error) return { outcome: "claimed" };
  if (error.code !== "23505") throw new Error(`Idempotency claim failed: ${error.message}`);

  const { data } = await client
    .from("partner_api_idempotency")
    .select("state, request_hash, http_status, response_body")
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (!data) return { outcome: "claimed" }; // Row expired between the two calls.
  if (data.request_hash !== requestHash) return { outcome: "conflict" };

  switch (data.state) {
    case "completed":
      return { outcome: "replay", httpStatus: data.http_status, body: data.response_body };
    case "indeterminate":
      // The first attempt may have reached Meta. Re-sending could double-message
      // a real customer, so this always requires human or webhook resolution.
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
  await client
    .from("partner_api_idempotency")
    .update({
      state: "completed",
      http_status: httpStatus,
      response_body: body,
      completed_at: new Date().toISOString(),
      locked_until: null,
    })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey);
}

export async function markIndeterminate(
  // deno-lint-ignore no-explicit-any
  client: any,
  keyId: string,
  idempotencyKey: string,
): Promise<void> {
  await client
    .from("partner_api_idempotency")
    .update({ state: "indeterminate", locked_until: null })
    .eq("key_id", keyId)
    .eq("idempotency_key", idempotencyKey);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-env supabase/functions/_shared/partnerApiIdempotency.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/partnerApiIdempotency.ts supabase/functions/_shared/partnerApiIdempotency.test.ts
git commit -m "feat(partner-api): add idempotency claim state machine"
```

---

### Task 5: Shared WhatsApp operations (characterization first)

**Files:**
- Create: `supabase/functions/_shared/whatsappPartnerOps.ts`
- Create: `supabase/functions/_shared/whatsappPartnerOps.test.ts`
- Modify: `supabase/functions/messaging-api/index.ts` (the `whatsapp_send_template` and `whatsapp_list_templates` handlers, around lines 951-1035)

**Interfaces:**
- Consumes: `WhatsAppAccountAccess` from `_shared/whatsappWorkspaceAccess.ts` — fields `accountId, ownerId, workspaceId, role, platformUserId, platformUsername, accessToken, accountMetadata`.
- Produces:
  - `interface WhatsAppOpsContext { admin; accountId; ownerId; workspaceId; phoneNumberId; accessToken }` — deliberately **role-free**; a machine key has scopes, not a human workspace role.
  - `sendTemplate(ctx, input: SendTemplateInput, fetcher?: Fetcher): Promise<SendResult>`
  - `listTemplates(ctx, wabaId: string, fetcher?: Fetcher): Promise<TemplateSummary[]>` — the WABA id comes from `social_accounts.account_metadata.waba_id`, not from the context
  - `type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>` — injected so tests never hit the network
  - `interface SendTemplateInput { recipientPhone: string; templateName: string; templateLanguage: string; components?: unknown[] }`
  - `interface SendResult { messageId: string; persisted: boolean }`
  - `interface TemplateSummary { name: string; language: string; status: string; category: string }`
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
}

export interface TemplateSummary {
  name: string;
  language: string;
  status: string;
  category: string;
}

export class WhatsAppOpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly metaCode?: number,
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
      return new WhatsAppOpError(message, "meta_error", status >= 500 ? 502 : 422, metaCode);
  }
}

export async function sendTemplate(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  fetcher: Fetcher = fetch,
): Promise<SendResult> {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.templateLanguage },
      ...(input.components?.length ? { components: input.components } : {}),
    },
  };

  const response = await fetcher(`${GRAPH_API}/${ctx.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw translateMetaError(response.status, body);

  const messageId = body?.messages?.[0]?.id;
  if (!messageId) {
    throw new WhatsAppOpError("Meta accepted the send but returned no message id",
      "meta_error", 502);
  }

  const persisted = await persistOutbound(ctx, input, messageId);
  return { messageId, persisted };
}

/**
 * Record the outbound message and surface the conversation in the inbox.
 * Returns false rather than throwing: Meta has already accepted the message,
 * so a storage failure must not be reported to the caller as a failed send.
 */
async function persistOutbound(
  ctx: WhatsAppOpsContext,
  input: SendTemplateInput,
  messageId: string,
): Promise<boolean> {
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
    message_text: "[Template message]",
    message_type: "template",
    direction: "outbound",
    status: "sent",
    timestamp: new Date().toISOString(),
  });

  if (error) {
    console.error("[whatsappPartnerOps] message persist failed:", error.message);
    return false;
  }
  return true;
}

export async function listTemplates(
  ctx: WhatsAppOpsContext,
  wabaId: string,
  fetcher: Fetcher = fetch,
): Promise<TemplateSummary[]> {
  const response = await fetcher(
    `${GRAPH_API}/${wabaId}/message_templates?limit=200`,
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

      return jsonResponse({ success: true, message_id: result.messageId });
    }
```

Add the import at the top of the file, beside the existing `_shared` imports:

```ts
import { sendTemplate } from "../_shared/whatsappPartnerOps.ts";
```

- [ ] **Step 6: Verify the existing suites still pass**

Run: `deno test --allow-env supabase/functions/messaging-api/ supabase/functions/_shared/`
Expected: PASS — every pre-existing test unchanged. If `whatsappAccess.test.ts` or `whatsappWorkspaceAccess.test.ts` fails, the extraction changed authorization behaviour; revert and re-do Step 5.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/whatsappPartnerOps.ts supabase/functions/_shared/whatsappPartnerOps.test.ts supabase/functions/messaging-api/index.ts
git commit -m "refactor(whatsapp): extract sendTemplate/listTemplates into shared role-free ops"
```

---

### Task 6: The `partner-api` edge function

**Files:**
- Create: `supabase/functions/partner-api/index.ts`
- Create: `supabase/functions/partner-api/router.ts`
- Create: `supabase/functions/partner-api/router.test.ts`
- Modify: `supabase/config.toml` (append after the `[functions.ecommerce-whatsapp-api]` block at line 32-33)

**Interfaces:**
- Consumes: everything produced by Tasks 2-5.
- Produces: `HTTP POST /functions/v1/partner-api` accepting `{ action }` of `get_status`, `send_template`, `list_templates`.

- [ ] **Step 1: Add the gateway configuration**

Append to `supabase/config.toml`:

```toml
[functions.partner-api]
verify_jwt = false
```

Without this the platform rejects the request before the function can authenticate the key. This was confirmed live: a JWT-less POST to `ecommerce-whatsapp-api` (which carries the same setting) reached the function and returned its own `Missing x-api-key header` body.

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
  return action in ACTION_SCOPES ? ACTION_SCOPES[action] : undefined;
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
  consumeQuota,
  recordUsage,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json(errorBody("method_not_allowed", "Use POST", false), 405);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let record: PartnerKeyRecord | null = null;
  let action = "unknown";
  let idempotencyKey: string | null = null;

  try {
    record = await authenticatePartnerKey(admin, req.headers.get("x-postora-key") ?? "");

    const body = await req.json().catch(() => ({}));
    action = String(body.action ?? "");

    const scope = requiredScopeFor(action);
    if (scope === undefined) {
      return json(errorBody("unknown_action", `Unknown action: ${action}`, false), 400);
    }
    if (scope !== null) assertScope(record, scope);

    await checkRateLimit(admin, record);

    // Resolve the key's pinned account. The composite FK already guarantees it
    // belongs to this workspace, so this read cannot cross a tenant boundary.
    const { data: account } = await admin
      .from("social_accounts")
      .select("id, user_id, workspace_id, platform_user_id, access_token, is_active, account_metadata")
      .eq("id", record.socialAccountId)
      .maybeSingle();

    if (!account || !account.is_active) {
      return await respond(
        admin, record, action, 409, false,
        errorBody("account_not_connected", "The WhatsApp account is not connected", false),
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
      return await respond(admin, record, action, 200, false, {
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
      return await respond(admin, record, action, 200, false, { success: true, templates });
    }

    // ---- send_template ----
    idempotencyKey = req.headers.get("idempotency-key");
    if (isSendAction(action) && !idempotencyKey) {
      return await respond(
        admin, record, action, 400, false,
        errorBody("missing_idempotency_key", "Idempotency-Key header is required for sends", false),
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
      return json(claim.body, claim.httpStatus, { "Idempotency-Replayed": "true" });
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

    if (!body.recipient_phone || !body.template_name) {
      return await respond(
        admin, record, action, 400, false,
        errorBody("invalid_request", "recipient_phone and template_name are required", false),
      );
    }

    // Quota is consumed only once we are actually about to send.
    await consumeQuota(admin, record);

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
      await completeIdempotency(admin, record.id, idempotencyKey!, 200, success);
      return await respond(admin, record, action, 200, true, success);
    } catch (err) {
      // A network failure after the request left leaves us unable to know
      // whether Meta delivered it. Never auto-retry from this state.
      if (!(err instanceof WhatsAppOpError)) {
        await markIndeterminate(admin, record.id, idempotencyKey!);
        throw err;
      }
      const failure = errorBody(err.code, err.message, err.status >= 500,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      await completeIdempotency(admin, record.id, idempotencyKey!, err.status, failure);
      return await respond(admin, record, action, err.status, false, failure, {}, err.code);
    }
  } catch (err) {
    if (err instanceof PartnerAuthError) {
      const retryable = err.code === "rate_limited";
      const body = errorBody(err.code, err.message, retryable);
      if (record) {
        return await respond(admin, record, action, err.status, false, body, {}, err.code);
      }
      return json(body, err.status);
    }
    console.error("[partner-api] unhandled:", err);
    const body = errorBody("internal_error", "Unexpected error", true);
    if (record) return await respond(admin, record, action, 500, false, body, {}, "internal_error");
    return json(body, 500);
  }
});

/** Emit the response and append exactly one usage-ledger row for it. */
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
) {
  await recordUsage(admin, {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable,
    httpStatus: status,
    errorCode,
  });
  return json(body, status, extraHeaders);
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
git add supabase/functions/partner-api/ supabase/config.toml
git commit -m "feat(partner-api): add machine-authenticated WhatsApp template send endpoint"
```

---

### Task 7: Cross-workspace isolation test matrix

**Files:**
- Create: `supabase/functions/partner-api/isolation.test.ts`

**Interfaces:**
- Consumes: `authenticatePartnerKey`, `assertScope` (Task 2); `requiredScopeFor` (Task 6).

This is the highest-risk area in the design, so it gets its own task and its own reviewer gate. It follows the pattern established by the cross-workspace suite in commit `c5f16035`.

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

Deno.test("a workspace-A key resolves only workspace-A's pinned account", async () => {
  const record = await authenticatePartnerKey(stubClient(WS_A_KEY), "pk_live_whatever");
  assertEquals(record.workspaceId, "ws-a");
  assertEquals(record.socialAccountId, "acct-a");
  // The account id is taken from the key row, never from the request body,
  // so a caller cannot address another workspace's account.
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

The application tests above prove the code checks. Task 1 Step 4 proved Postgres rejects a cross-workspace key outright. Both layers must hold; re-run Task 1 Step 4 against the scratch database if the migration changed since.

- [ ] **Step 4: Run the full suite**

Run: `deno test --allow-env supabase/functions/`
Expected: PASS, with no pre-existing test failing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/partner-api/isolation.test.ts
git commit -m "test(partner-api): cover cross-workspace isolation and scope enforcement"
```

---

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
- The Integrations key-management UI — until it exists, keys are created by a service-role script (Plan 3).
- Danat's `sendWithWhatsApp` swap, in the other repo (Plan 3).
- Free-form text, media, and interactive sends; inbox reads; the AI bot.
- Fixing `whatsapp_contacts`' `UNIQUE(user_id, phone_number)` workspace bug (spec §5.6) and the non-fatal OAuth success gap (spec §9) — both pre-existing, both flagged, neither caused by this work.
