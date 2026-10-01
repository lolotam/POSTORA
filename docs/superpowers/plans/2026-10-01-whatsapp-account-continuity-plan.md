# WhatsApp Account Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A WhatsApp reconnect, re-pair or switch never strands the owner's AI agent setup, and a store order for a disconnected account is held and surfaced, never silently lost.

**Architecture:** Three PRs, in order. Each ends in deployable, tested software.
- **PR-D** adds visibility: a setup-summary RPC, receiver warning, worker deferral, and an alert flag with banner and email.
- **PR-A** adds QR reconnect-in-place and makes a mismatched number a blocked state.
- **PR-BC** adds one SQL mover, `move_whatsapp_account_setup`, called automatically from the QR activation merge (B) and on demand from a "Bring over my setup" banner (C).

**Tech Stack:**
- Postgres 17 (self-hosted Supabase): plpgsql, SECURITY DEFINER RPCs.
- Deno edge functions, with `deno test`.
- React 18 + TanStack Query + shadcn/ui, with Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-whatsapp-account-continuity-design.md` (revision 2). Read it first. Section numbers below (§) refer to it.

## Global Constraints

- **Lanes (owner's instruction, 2026-10-01):**
  - Production code: OpenCode `zai-coding-plan/glm-5.3-flash`.
  - Tests: written and reviewed by agy `gemini-3.8-flash-high`.
  - Every migration and harness suite: written by the orchestrator (Claude), not delegated.
- Every delegation brief names `ARCHITECTURE.md` as required reading, plus the rule sections below.
- **Migrations:**
  - Never edit an applied migration; every change is a new file.
  - New migration timestamps: `20261004100000` and later.
  - Apply them as `supabase_admin` on Contabo, then `NOTIFY pgrst, 'reload schema'`. Apply each PR's migrations **before** merging that PR.
- **Every new SECURITY DEFINER function:**
  - sets `SET search_path = public`;
  - `REVOKE ALL … FROM PUBLIC, anon, authenticated`, all three;
  - then `GRANT` to exactly the intended role.
- PostgREST `await` does not throw. Every supabase-js call checks `{ error }`.
- No phone numbers in logs. Copy is English with `t(key, default)` i18n defaults, in the `whatsapp` and `dashboard` namespaces.
- **Gates, run in this order:**
  1. `deno test --allow-env --allow-read --node-modules-dir=none <changed test files>`;
  2. `bun install --frozen-lockfile`;
  3. `npx vitest run <changed dirs>`;
  4. `npm run typecheck`;
  5. `npx eslint <changed files>`;
  6. DB harness on Contabo PG17 (`scripts/db-harness.sh`; see `supabase/tests/README.md`).
- **Guards:** clean-code-guard on production code; test-guard on tests, with mutation checks; docs-guard on docs.
- **Deploy:** the merge deploys edge functions through the Dokploy reconciler (~2 min) and the frontend through Dokploy. After merge, probe each changed function unauthenticated and expect 401.

---

# PR-D — Never silent

Branch `feat/wa-continuity-d`, from `origin/main`.

### Task D1: Migration — summary RPC and undelivered-event flag (orchestrator)

**Files:**
- Create: `supabase/migrations/20261004100000_whatsapp_setup_summary_and_undelivered_flag.sql`
- Create: `supabase/tests/whatsapp_account_continuity.sql` (suite; grows in PR-A and PR-BC)
- Modify: `scripts/db-harness.sh` (add the suite to `SUITES`)

**Interfaces — Produces:**
- `public.get_whatsapp_account_setup_summary(p_account_id uuid) RETURNS jsonb`
  - Keys: `agent_config`, `connectors`, `connector_links`, `store_bindings`, `knowledge_sources`, `test_cases`, `waitlist`, `templates`, `partner_keys_primary`, `partner_key_links`, `partner_webhooks`, `n8n_subscriptions`, `scheduled_messages` (all integers), `automation_handlers` (text[] of set keys).
  - Raises `42501` unless the row's `user_id = auth.uid()`.
  - `GRANT EXECUTE TO authenticated`.
- `public.note_undelivered_store_event(p_account_id uuid) RETURNS void`
  - Merges `account_metadata.undelivered_store_events = {since: <first time, kept>, last_at: now()}`.
  - It is idempotent: it carries **no count**, because the receiver and every worker retry call it, and a count would count retries rather than orders (debate 1, point 7).
  - `GRANT EXECUTE TO service_role` only.
- `public.mark_undelivered_alert_emailed(p_account_id uuid, p_since text) RETURNS boolean`
  - Atomically sets `account_metadata.undelivered_alert_email_at = now()`, only while `undelivered_store_events->>'since' = p_since`.
  - Returns whether a row changed.
  - service_role only. This avoids a client-side read–merge–write of the whole metadata object (debate 1, point 9).
- `public.clear_undelivered_store_events(p_account_id uuid) RETURNS void`
  - Removes that key.
  - service_role only.

- [ ] **Step 1: Write the harness suite (red).** Create `supabase/tests/whatsapp_account_continuity.sql` with fixtures:
  - two users `u_a` and `u_b`;
  - whatsapp accounts: `acc_a1` (active QR, `platform_user_id '96500000001'`), `acc_a2` (inactive QR, `'96500000002'`) and `acc_b1` (user b);
  - an `ai_agent_configs` row on `acc_a1`;
  - one `ai_agent_tools` woocommerce row on `acc_a1` (scope `account`);
  - one `store_webhook_bindings` row on `acc_a1`, using a Vault secret via `vault.create_secret`.

  Assertions:
  - **S1:** as `u_a` (`SET LOCAL role authenticated; SET LOCAL request.jwt.claims = '{"sub":"<u_a>"}'`), the summary for `acc_a1` returns `agent_config=1, connectors=1, store_bindings=1`.
  - **S2:** as `u_a`, the summary for `acc_b1` raises `42501`.
  - **S3:** `has_function_privilege('anon', 'public.get_whatsapp_account_setup_summary(uuid)', 'EXECUTE')` is false.
  - **S4:** `note_undelivered_store_event` is not executable by `authenticated`.
  - **S5:** as service role, two calls keep `since` unchanged and advance `last_at`; there is no `count` key.
  - **S6:** `clear_undelivered_store_events` removes the key.
  - **S7:**
    - `mark_undelivered_alert_emailed(acc, <current since>)` returns true and sets the timestamp;
    - with a stale `since` it returns false and changes nothing;
    - it is not executable by `authenticated`.
  - **S8:** an `app_settings` row keyed `n8nXwebhookX<u_a>X1` (underscores replaced) with `value.social_account_id = acc_a1` is **not** counted, while `n8n_webhook_<u_a>_1` is. This proves the literal-prefix match (debate 1, point 13).

  End with `ROLLBACK;` and a sentinel `SELECT 'whatsapp_account_continuity: ok';`, matching the style of `supabase/tests/tiktok_review_lifecycle.sql`.

- [ ] **Step 2: Register the suite and run the harness on Contabo.** It must fail S1, because the function does not exist yet.
  - Add `whatsapp_account_continuity.sql` to `SUITES` in `scripts/db-harness.sh`.
  - Run: on Contabo, the `hg17` container per `supabase/tests/README.md` (CR-stripped `/tmp/hgate` copy, `MSYS_NO_PATHCONV=1`).
  - Expected: `ERROR: function public.get_whatsapp_account_setup_summary(uuid) does not exist`.

- [ ] **Step 3: Write the migration.**

```sql
-- WhatsApp account continuity, PR-D (spec 2026-10-01 §7).
-- get_whatsapp_account_setup_summary: what is attached to one WhatsApp account, for the
-- disconnect dialogs and the "bring over my setup" banner. Owner-only.
-- note_/clear_undelivered_store_events: the flag behind the disconnected-account alert.

CREATE OR REPLACE FUNCTION public.get_whatsapp_account_setup_summary(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_metadata jsonb;
  v_workspace uuid;
BEGIN
  SELECT user_id, coalesce(account_metadata, '{}'::jsonb), workspace_id
    INTO v_user, v_metadata, v_workspace
    FROM social_accounts
   WHERE id = p_account_id AND platform = 'whatsapp';
  IF v_user IS NULL OR v_user IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'get_whatsapp_account_setup_summary: not found' USING errcode = '42501';
  END IF;
  RETURN jsonb_build_object(
    'agent_config',        (SELECT count(*) FROM ai_agent_configs WHERE social_account_id = p_account_id),
    'connectors',          (SELECT count(*) FROM ai_agent_tools WHERE social_account_id = p_account_id),
    'connector_links',     (SELECT count(*) FROM ai_agent_tool_accounts WHERE social_account_id = p_account_id),
    'store_bindings',      (SELECT count(*) FROM store_webhook_bindings WHERE social_account_id = p_account_id),
    'knowledge_sources',   (SELECT count(*) FROM ai_knowledge_source_accounts WHERE social_account_id = p_account_id),
    'test_cases',          (SELECT count(*) FROM ai_agent_test_cases WHERE social_account_id = p_account_id),
    'waitlist',            (SELECT count(*) FROM stock_waitlist WHERE social_account_id = p_account_id),
    'templates',           (SELECT count(*) FROM whatsapp_message_templates WHERE social_account_id = p_account_id),
    'partner_keys_primary',(SELECT count(*) FROM partner_api_keys WHERE social_account_id = p_account_id AND revoked_at IS NULL),
    'partner_key_links',   (SELECT count(*) FROM partner_api_key_accounts WHERE social_account_id = p_account_id),
    'partner_webhooks',    (SELECT count(*) FROM partner_webhooks WHERE social_account_id = p_account_id AND is_active),
    -- Literal prefix, not LIKE: '_' is a LIKE wildcard. Keys are n8n_webhook_<userId>_<webhookId>
    -- (n8n-api/index.ts:1685).
    'n8n_subscriptions',   (SELECT count(*) FROM app_settings
                             WHERE left(key, length('n8n_webhook_' || v_user::text || '_')) = 'n8n_webhook_' || v_user::text || '_'
                               AND value->>'social_account_id' = p_account_id::text),
    'scheduled_messages',  (SELECT count(*) FROM whatsapp_scheduled_messages WHERE social_account_id = p_account_id),
    'automation_handlers', to_jsonb(ARRAY(
                             SELECT k FROM unnest(ARRAY['automation_handler','comment_automation_handler','media_understanding']) k
                              WHERE v_metadata ? k))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_whatsapp_account_setup_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_account_setup_summary(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.note_undelivered_store_event(p_account_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE social_accounts
     SET account_metadata = coalesce(account_metadata, '{}'::jsonb) || jsonb_build_object(
           'undelivered_store_events', jsonb_build_object(
             'since', coalesce(account_metadata->'undelivered_store_events'->>'since', now()::text),
             'last_at', now()::text))
   WHERE id = p_account_id;
$$;
REVOKE ALL ON FUNCTION public.note_undelivered_store_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_undelivered_store_event(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_undelivered_alert_emailed(p_account_id uuid, p_since text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE social_accounts
     SET account_metadata = jsonb_set(account_metadata, '{undelivered_alert_email_at}', to_jsonb(now()::text))
   WHERE id = p_account_id
     AND account_metadata->'undelivered_store_events'->>'since' = p_since;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_undelivered_alert_emailed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_undelivered_alert_emailed(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_undelivered_store_events(p_account_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE social_accounts
     SET account_metadata = account_metadata - 'undelivered_store_events'
   WHERE id = p_account_id AND account_metadata ? 'undelivered_store_events';
$$;
REVOKE ALL ON FUNCTION public.clear_undelivered_store_events(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_undelivered_store_events(uuid) TO service_role;
```

- [ ] **Step 4: Run the harness.** Expected: suite passes, sentinel printed, no other suite newly red. `ai_agent_dashboard.sql` already fails its sentinel; note it, don't fix it.
- [ ] **Step 5: Mutation check.**
  - Drop the `IS DISTINCT FROM auth.uid()` clause: S2 must go red.
  - Grant `note_undelivered_store_event` to authenticated: S4 must go red.
  - Revert both.
- [ ] **Step 6: Commit.** `git add` the migration, the suite and `scripts/db-harness.sh`, then commit: `feat(db): WhatsApp setup summary and undelivered store-event flag`.

### Task D2: Receiver warning (store-webhook)

**Files:**
- Modify: `supabase/functions/store-webhook/handler.ts` (deps interface + final response)
- Modify: `supabase/functions/store-webhook/index.ts` (port implementation)
- Test: `supabase/functions/store-webhook/handler.test.ts`

**Interfaces — Consumes:** `note_undelivered_store_event(uuid)` (D1).
**Produces:**
- `StoreWebhookDeps.accountConnected(socialAccountId: string): Promise<boolean>`
- `StoreWebhookDeps.noteUndelivered(socialAccountId: string): Promise<void>`

- [ ] **Step 1: Tests (agy).** In `handler.test.ts`, add a deps stub with `accountConnected` and `noteUndelivered`, then add two tests:
  - **Connected:** response `{ok:true, stored:1}`, with no `warning` key and no `noteUndelivered` call.
  - **Not connected** (`accountConnected` → false): the event is still stored, the response is `{ok:true, stored:1, warning:"account_disconnected"}`, and `noteUndelivered` is called once with the binding's `social_account_id`.

  Also add a third case: `accountConnected` throws. The response is still 200 with body exactly `{ok:true, stored:1, warning:"account_state_unknown"}`, and `noteUndelivered` is not called. A stored delivery never fails because of the warning, and an unknown state is reported rather than shown as connected (debate 1, point 8).
- [ ] **Step 2: Run.** `deno test --allow-env --allow-read --node-modules-dir=none supabase/functions/store-webhook/handler.test.ts`. Expected: FAIL (type error: unknown deps).
- [ ] **Step 3: Implement (GLM).** In `handler.ts`, add to `StoreWebhookDeps`:

```ts
  /** False when the bound WhatsApp account is inactive or retired. A thrown read counts as unknown. */
  accountConnected(socialAccountId: string): Promise<boolean>;
  /** Raises the owner's disconnected-account alert. Best effort. */
  noteUndelivered(socialAccountId: string): Promise<void>;
```

Replace the final `return json({ ok: true, stored: inserted.stored });` with:

```ts
  if (inserted.stored > 0) {
    const state = await accountState(deps, binding.social_account_id);
    if (state === "disconnected") {
      await noteUndeliveredSafely(deps, binding.social_account_id);
      return json({ ok: true, stored: inserted.stored, warning: "account_disconnected" });
    }
    if (state === "unknown") return json({ ok: true, stored: inserted.stored, warning: "account_state_unknown" });
  }
  return json({ ok: true, stored: inserted.stored });
```

with helpers:

```ts
async function accountState(deps: StoreWebhookDeps, accountId: string): Promise<"connected" | "disconnected" | "unknown"> {
  try {
    return (await deps.accountConnected(accountId)) ? "connected" : "disconnected";
  } catch {
    console.error("[store-webhook] account state read failed");
    return "unknown";
  }
}

async function noteUndeliveredSafely(deps: StoreWebhookDeps, accountId: string): Promise<void> {
  try {
    await deps.noteUndelivered(accountId);
  } catch {
    console.error("[store-webhook] undelivered flag failed");
  }
}
```

In `index.ts`, add:

```ts
    async accountConnected(socialAccountId) {
      const { data, error } = await admin.from("social_accounts")
        .select("is_active, platform_user_id").eq("id", socialAccountId).maybeSingle();
      if (error) throw new Error("account_read_failed");
      return !!data && data.is_active === true && !String(data.platform_user_id ?? "").startsWith("retired_");
    },
    async noteUndelivered(socialAccountId) {
      const { error } = await admin.rpc("note_undelivered_store_event", { p_account_id: socialAccountId });
      if (error) throw new Error("undelivered_flag_failed");
    },
```

- [ ] **Step 4: Run the tests.** Expected: PASS. Also `deno check --node-modules-dir=none supabase/functions/store-webhook/index.ts`.
- [ ] **Step 5: Commit.** `feat(store-webhook): warn WooCommerce when the bound WhatsApp account is disconnected`

### Task D3: Worker defers events for a disconnected account

**Files:**
- Modify: `supabase/functions/process-store-events/worker.ts`:
  - `AccountContext` (+`connected`);
  - `WorkerPorts` (+`noteUndelivered`);
  - `processClaimed`;
  - a new `deferDisconnected`.
- Modify: `supabase/functions/process-store-events/deps.ts`:
  - the `accountRow` select (+`is_active`);
  - `loadAccount` (+`connected`);
  - the port.
- Test: `supabase/functions/process-store-events/worker.test.ts`, `deps.test.ts`

**Interfaces — Produces:** `AccountContext.connected: boolean`; `WorkerPorts.noteUndelivered(accountId: string): Promise<void>`; the exported constant `DISCONNECTED_HOLD_MS = 24 * 60 * 60 * 1000`.

- [ ] **Step 1: Tests (agy).** In `worker.test.ts`, using the existing fake-ports builder:
  1. `connected:false`, event created 1 h ago:
     - `updateEvent` is called with `{status:"pending", claimed_at:null, claim_token:null, send_attempt_id:null, attempts: event.attempts - 1}` and `due_at` = now + 15 min;
     - `noteUndelivered` is called once;
     - `sendOpener` is never called;
     - the summary counts `released`.
  2. `connected:false`, event created 25 h ago: skipped with `skip_reason:"account_disconnected"`, `sendOpener` never called.
  3. `connected:true`: existing behaviour unchanged (one existing happy-path test passes as is).
  4. A Meta row (`connectionMode:"cloud_api"`) with `connected:false` is deferred, not sent. This is the regression for the send-after-disconnect bug.

  In `deps.test.ts`, assert that `loadAccount` maps `is_active:false` → `connected:false`, and `platform_user_id:"retired_x"` → `connected:false`.
- [ ] **Step 2: Run.** `deno test --allow-env --allow-read --node-modules-dir=none supabase/functions/process-store-events/`. Expected: FAIL.
- [ ] **Step 3: Implement (GLM).** In `worker.ts`:

```ts
export const DISCONNECTED_HOLD_MS = 24 * 60 * 60 * 1000;
const DISCONNECTED_RETRY_MS = 15 * 60 * 1000;
```

Add `connected: boolean;` to `AccountContext`, and `noteUndelivered(accountId: string): Promise<void>;` to `WorkerPorts`.

In `processClaimed`, directly after `account = await ports.loadAccount(event);` and **before** `accountSkipReason`:

```ts
    if (account && !account.connected) {
      return await deferDisconnected(ports, event, account);
    }
```

New function, next to `deferPendingTemplate`:

```ts
/**
 * The bound account cannot send. Hold the order (15-minute retries, attempt returned) so a
 * reconnect or a setup move still delivers it, and raise the owner's alert. After 24h it is skipped.
 */
async function deferDisconnected(
  ports: WorkerPorts,
  event: StoreEventRow,
  account: AccountContext,
): Promise<"released" | "skipped" | "left"> {
  const created = Date.parse(event.created_at);
  if (!Number.isFinite(created) || ports.now() - created > DISCONNECTED_HOLD_MS) {
    return await skip(ports, event, "account_disconnected", { account, thread: null, expected: null, reserved: false });
  }
  try {
    await ports.noteUndelivered(event.social_account_id);
  } catch {
    console.error("[process-store-events] undelivered flag failed");
  }
  const marked = await ports.updateEvent(event.id, event.claim_token, {
    status: "pending",
    due_at: iso(ports.now() + DISCONNECTED_RETRY_MS),
    attempts: event.attempts - 1,
    claimed_at: null,
    claim_token: null,
    send_attempt_id: null,
  });
  if (marked) await writeOutcomeLog(ports, event, "info", "Store event deferred", "account_disconnected");
  return marked ? "released" : "left";
}
```

In `deps.ts`:
- `accountRow` select: `"id, user_id, platform, connection_mode, platform_user_id, access_token, account_metadata, workspace_id, is_active"`;
- `AccountRow` gains `is_active: boolean | null`;
- `loadAccount` returns `connected: row.is_active === true && !String(row.platform_user_id ?? "").startsWith("retired_")`;
- the port:

```ts
    async noteUndelivered(accountId) {
      const { error } = await admin.rpc("note_undelivered_store_event", { p_account_id: accountId });
      if (error) throw error;
    },
```

- [ ] **Step 4: Run.** Same command. Expected: PASS. Then `deno check --node-modules-dir=none supabase/functions/process-store-events/index.ts`.
- [ ] **Step 5: Commit.** `fix(store-events): hold orders for a disconnected WhatsApp account instead of sending or failing`

### Task D4: Alert banner and email

**Files:**
- Create: `src/components/dashboard/UndeliveredStoreOrdersBanner.tsx`
- Modify: `src/pages/Dashboard.tsx` (mount below `<TokenReauthBanner />`)
- Modify: `src/pages/whatsapp/Setup.tsx` (mount above `WhatsAppSetup`)
- Create: `supabase/functions/send-undelivered-store-alerts/index.ts` + `handler.ts`
- Create: `supabase/migrations/20261004100500_undelivered_store_alert_cron.sql` (orchestrator)
- Test: `src/components/dashboard/__tests__/UndeliveredStoreOrdersBanner.test.tsx`, `supabase/functions/send-undelivered-store-alerts/handler.test.ts`

**Interfaces — Consumes:** `account_metadata.undelivered_store_events` (D1).
**Produces:** `<UndeliveredStoreOrdersBanner />` (no props).

- [ ] **Step 1: Tests (agy).**
  - **Vitest:** mock `supabase.from("social_accounts")` per `src/test` conventions (no `userEvent`; use `fireEvent`, see the frontend test conventions memory).
    - (a) No row with the flag: renders nothing.
    - (b) One row (`platform_username:"xsellpoint"`, flag `{since, last_at}`): renders the text "Store orders are waiting for a disconnected WhatsApp account (xsellpoint)" and a link to `/messaging/whatsapp/setup` (route: `src/components/AnimatedRoutes.tsx:280-281,303`) labelled "Reconnect or move setup".
    - (c) A query error: renders nothing and does not throw.
  - **Deno, `handler.test.ts`:**
    - Given two accounts with the flag, where one has `last_at` older than `last_email_at`, exactly one email is sent, and `undelivered_alert_email_at` is written for that account.
    - An `alerts_snoozed` account is never emailed.
    - The email body contains the account name and no phone number.
- [ ] **Step 2: Run both.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the banner (GLM).**

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface FlaggedAccount {
  id: string;
  platform_username: string | null;
  account_metadata: { undelivered_store_events?: { since?: string } } | null;
}

export function UndeliveredStoreOrdersBanner() {
  const { t } = useTranslation("dashboard");
  const { user } = useAuth();
  const { data = [] } = useQuery({
    queryKey: ["undelivered-store-orders", user?.id],
    enabled: !!user,
    refetchInterval: 60000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, account_metadata")
        .eq("user_id", user!.id)
        .eq("platform", "whatsapp")
        .not("account_metadata->undelivered_store_events", "is", null);
      if (error) return [];
      return (rows ?? []) as FlaggedAccount[];
    },
  });
  if (data.length === 0) return null;
  return (
    <div className="space-y-2">
      {data.map((account) => (
        <Alert key={account.id} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {t("undeliveredStore.title", "Store orders are waiting for a disconnected WhatsApp account ({{name}})", {
              name: account.platform_username ?? "WhatsApp",
            })}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {t("undeliveredStore.body", "Order messages are on hold. Reconnect the account or move its setup to your current connection.")}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link to="/messaging/whatsapp/setup">{t("undeliveredStore.action", "Reconnect or move setup")}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
```

The route is `/messaging/whatsapp/setup` (`src/components/AnimatedRoutes.tsx:280-281,303`).

- [ ] **Step 4: Implement the email function (GLM).** Copy the structure of `supabase/functions/send-token-expiry-notifications/index.ts`: cron auth via `_shared/cron-auth.ts`, Resend send, the snooze check on `alerts_snoozed`.
  - `handler.ts` exports `selectAccountsToEmail(rows, now)`. It returns flagged WhatsApp accounts where:
    - `!alerts_snoozed`, and
    - `account_metadata.undelivered_alert_email_at` is absent or older than `undelivered_store_events.since`.

    That gives one email per incident.
  - `index.ts` sends:
    - **subject:** "Store orders are waiting on a disconnected WhatsApp account";
    - **body:** the account name, a link to `https://postora.cloud/messaging/whatsapp/setup`, and no phone numbers.

    - Then it calls `admin.rpc("mark_undelivered_alert_emailed", { p_account_id, p_since })` with the `since` it emailed about, checks `{ error }`, and never writes `account_metadata` from the client.
    - It honours the user's email preference exactly as `send-token-expiry-notifications/index.ts:310-329` does: it reads `profiles.email, full_name, email_notifications_enabled` and skips unless `email_notifications_enabled === true`. The banner always shows regardless.
    - Test: a profile with `email_notifications_enabled:false` is never emailed.
- [ ] **Step 5: Cron migration (orchestrator).** `20261004100500_undelivered_store_alert_cron.sql` schedules `send-undelivered-store-alerts` every 15 min. Do **not** copy the token-expiry job's migration: it points at the retired Supabase Cloud URL. Use exactly this self-hosted shape (from `20261003100000_jev_triage_failure_alert.sql:25-44`):

```sql
DO $do_undelivered_store_alerts_cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
    AND to_regprocedure('public.get_cron_secret()') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-undelivered-store-alerts') THEN
      PERFORM cron.schedule(
        'send-undelivered-store-alerts',
        '*/15 * * * *',
        $cron$
        SELECT net.http_post(
          url := 'https://api.postora.cloud/functions/v1/send-undelivered-store-alerts',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || get_cron_secret()
          ),
          body := '{}'::jsonb
        );
        $cron$
      );
    END IF;
  ELSE
    RAISE NOTICE 'send-undelivered-store-alerts cron skipped: pg_cron, pg_net, or get_cron_secret() unavailable';
  END IF;
END $do_undelivered_store_alerts_cron$;
```

The job belongs to `supabase_admin` once applied (see the pg_cron owner memory). Apply it as `supabase_admin`. Afterwards, `SELECT jobname, schedule FROM cron.job WHERE jobname LIKE '%undelivered%'` returns 1 row.
- [ ] **Step 6: Clear the flag on reconnect.** In `supabase/functions/_shared/evolutionQrAccount.ts` `syncEvolutionAccountConnection` (**not** inside `emitConnectionTransition`, which returns early at `:118-128` when the state did not change or the workspace is null), add a helper `clearUndeliveredSafely(admin, accountId)`:
  - it calls `admin.rpc("clear_undelivered_store_events", { p_account_id: accountId })`;
  - it checks `{ error }` and logs `[evolution-qr] account <id>: undelivered flag clear failed` without throwing.

  Call it in exactly two places:
  1. directly before `await emitConnectionTransition(admin, account.id, previous, true);` in the `!claimsIdentity` branch;
  2. directly before the final `emitConnectionTransition(..., true)` after the claim RPC.

  Do the same in `_shared/whatsappDisconnect.ts` `reconnectWhatsAppAccount`, after its successful `is_active = true` update.

  **Test fake change (agy):** `evolutionQrAccount.test.ts:44-50` treats every `rpc()` call as the activation claim. Change the fake to dispatch on the function name: `activate_evolution_qr_account` → the existing claim behaviour; `clear_undelivered_store_events` → record the call and return `{ error: null }` (or a configured error).

  Tests:
  - `close`→`open` on an established row calls clear once;
  - a claim path calls clear once, after the claim;
  - a clear error does not reject;
  - `open`→`close` does not call clear;
  - a mismatch (A1) does not call clear.
- [ ] **Step 7: Run all gates. Commit.** `feat: alert the owner when store orders wait on a disconnected WhatsApp account`

### Task D5: Disconnect dialogs show what is attached

**Files:**
- Create: `src/hooks/useWhatsAppSetupSummary.ts`
- Create: `src/components/messaging/AccountSetupSummaryList.tsx`
- Modify: `src/components/messaging/WhatsAppSetup.tsx:757-780` (disconnect dialog)
- Modify: `src/pages/Profiles.tsx:174-180` (remove handler + confirmation)
- Test: `src/components/messaging/__tests__/AccountSetupSummaryList.test.tsx`, `src/pages/__tests__/Profiles.whatsappDelete.test.tsx`

**Interfaces — Produces:**
- `useWhatsAppSetupSummary(accountId: string | null)` → `UseQueryResult<WhatsAppSetupSummary>`
- the type `WhatsAppSetupSummary`, matching the D1 keys;
- `<AccountSetupSummaryList summary={…} />`.

- [ ] **Step 1: Tests (agy).**
  - The list renders one line per non-zero count, e.g. "AI agent settings", "1 connector", "1 store webhook", "5 knowledge sources", and nothing for zeros.
  - The Profiles test: removing a WhatsApp account opens a confirmation that contains "This permanently deletes the account and its AI agent setup" and the summary lines. On a mutation error whose code is `23503`, a toast says "This account can't be deleted while connectors or partner integrations use it. Disconnect it from the WhatsApp page instead."
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement (GLM).**

```ts
// src/hooks/useWhatsAppSetupSummary.ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface WhatsAppSetupSummary {
  agent_config: number; connectors: number; connector_links: number; store_bindings: number;
  knowledge_sources: number; test_cases: number; waitlist: number; templates: number;
  partner_keys_primary: number; partner_key_links: number; partner_webhooks: number;
  n8n_subscriptions: number; scheduled_messages: number; automation_handlers: string[];
}

export function useWhatsAppSetupSummary(accountId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-setup-summary", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_whatsapp_account_setup_summary", { p_account_id: accountId! });
      if (error) throw error;
      return data as unknown as WhatsAppSetupSummary;
    },
  });
}
```

`AccountSetupSummaryList` renders a `<ul>` of `t("summary.<key>", "<default>", { count })` lines for non-zero keys, in the order of D1's keys. When `automation_handlers` is non-empty, it adds one line, "Automation settings".

`WhatsAppSetup` disconnect dialog: under the existing hint, render `<AccountSetupSummaryList summary={summary.data} />`, followed by `t("setup.disconnectKeepsSetup", "These stay on this account. Reconnect it later, or move them to a new connection.")`. Use `useWhatsAppSetupSummary(disconnectTarget?.id ?? null)`.

`Profiles.tsx`: when the account's `platform === "whatsapp"`, `handleDisconnectAccount` first opens an `AlertDialog` that shows:
- the delete warning;
- the summary;
- a link to the WhatsApp page, recommending Disconnect there.

Only the confirm button calls `mutateAsync`. In the `catch`, map `error.code === "23503"` to the toast above.
- [ ] **Step 4: Run all gates. Commit.** `feat(whatsapp): show attached setup before disconnecting or deleting an account`

### Task D6: PR-D land

- [ ] Guards: clean-code-guard (production), test-guard (tests, with one mutation per new test file).
- [ ] Apply `20261004100000` and `20261004100500` to production as `supabase_admin`, then `NOTIFY pgrst, 'reload schema'`. Verify that `has_function_privilege` for anon is false on all three functions.
- [ ] Open the PR, run CI, merge. Post-deploy:
  - probe `store-webhook` (expect 404 for an unknown binding id) and `send-undelivered-store-alerts` (expect 401);
  - check the frontend bundle contains "Store orders are waiting".

---

# PR-A — Reconnect in place (QR)

Branch `feat/wa-continuity-a`, from `origin/main` after PR-D merges.

### Task A1: Mismatch becomes a blocked state

**Files:**
- Modify: `supabase/functions/_shared/evolutionQrAccount.ts`
  - export `class NumberMismatchError`;
  - the mismatch branch in `syncEvolutionAccountConnection`.
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts`: `reconcileAccountConnection`, `getQrStatus`.
- Modify: `supabase/functions/whatsapp-evolution-webhook/index.ts:378`
- Modify: `supabase/functions/_shared/whatsappPairingOps.ts:276`
- Test: `supabase/functions/_shared/evolutionQrAccount.test.ts` (replace the existing mismatch test at `:256`).

**Interfaces — Produces:**

```ts
export class NumberMismatchError extends Error {
  constructor(public readonly accountId: string) {
    super("number_mismatch");
    this.name = "NumberMismatchError";
  }
}
```

`getQrStatus` returns `{ success: true, social_account_id, qr: null, state: "number_mismatch", expected_last4: string }`, where `expected_last4` is the last 4 digits of the stored number. Phone numbers never go into logs; the owner sees only the last 4.

- [ ] **Step 1: Tests (agy).**
  - In `evolutionQrAccount.test.ts`, replace the `:256` test: an established row (`platform_user_id "96597950350"`, `is_active:false`) receiving `open` with owner `99999999@s.whatsapp.net`:
    - rejects with `NumberMismatchError`;
    - the recorded update sets `account_metadata.number_mismatch = true` and **does not** set `is_active: true`;
    - `emitConnectionTransition` emits nothing.
  - Keep the matching-number test (`:245`) passing unchanged.
  - Add a bridge-level test (new `supabase/functions/whatsapp-evolution-bridge/reconcile.test.ts`, after extracting `reconcileAccountConnection` into `supabase/functions/whatsapp-evolution-bridge/reconcile.ts` so it is importable): on `NumberMismatchError` it calls `api.logout(instanceName)` once and returns the `number_mismatch` state.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement (GLM).** In `syncEvolutionAccountConnection`, replace the mismatch block:

```ts
  if (ownerNumber && !isProvisional && ownerNumber !== account.platform_user_id) {
    console.error(`[evolution-qr] account ${account.id}: a different phone was linked; activation refused`);
    metadata.number_mismatch = true;
    const { error } = await admin.from("social_accounts")
      .update({ account_metadata: metadata, is_active: false })
      .eq("id", account.id);
    if (error) throw error;
    throw new NumberMismatchError(account.id);
  }
```

In the matching-number path, clear a stale flag: when `ownerNumber === account.platform_user_id && metadata.number_mismatch`, `delete metadata.number_mismatch` and include `account_metadata: metadata` in `updates`.

The callers catch `NumberMismatchError`, with an explicit result contract (debate 1, point 10).

**Bridge.** `reconcileAccountConnection` (moved to `whatsapp-evolution-bridge/reconcile.ts`) now returns `type ReconcileResult = { ownerNumber: string; mismatch: boolean }`. On `NumberMismatchError` it:
- awaits `api.logout(instanceName).catch(() => undefined)`;
- updates `whatsapp_evolution_instances` `last_connection_state = 'number_mismatch'` for that account, checking `{ error }` and throwing on error;
- returns `{ ownerNumber: account.platform_user_id, mismatch: true }`.

`getQrStatus`:
- when `result.mismatch`, returns `{ success: true, social_account_id, qr: null, state: "number_mismatch", expected_last4: account.platform_user_id.slice(-4) }` and **never** calls `autoImportHistory`;
- otherwise behaves as today, using `result.ownerNumber`.

**Webhook** (`whatsapp-evolution-webhook/index.ts:378`): wraps the sync call; on `NumberMismatchError`, logs out (same call) and returns 200 `{ ok: true, state: "number_mismatch" }` without running any code that follows the sync.

**`whatsappPairingOps.ts`:**
- Its own `reconcileAccountConnection` (`:255-279`) returns `ReconcileResult` too.
- On `NumberMismatchError` it logs out via `api.logout` and returns `{ ownerNumber: account.platform_user_id, mismatch: true }`. `PairingApi` must include `logout`; add it to the type if it is missing.
- `pairingStatus` (`:240-252`) returns `{ account_id, state: result.mismatch ? "number_mismatch" : state, phone_number: result.mismatch || ownerNumber.startsWith("pending_") ? null : result.ownerNumber }`.
- A pairing never reports `open` for a refused phone.

**Tests (agy):** each path (bridge poll, webhook, partner pairing):
- (a) does not report `open`;
- (b) starts no history import;
- (c) calls `logout` once;
- (d) persists `number_mismatch`.
- [ ] **Step 4: Run.** `deno test … supabase/functions/_shared/evolutionQrAccount.test.ts supabase/functions/whatsapp-evolution-bridge/`. Expected: PASS. `deno check` all four entrypoints.
- [ ] **Step 5: Commit.** `fix(whatsapp-qr): a different phone scanned onto a connection is refused, not activated`

### Task A2: `reconnect_qr` bridge action

**Files:**
- Create: `supabase/functions/whatsapp-evolution-bridge/reconnect.ts`
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts` (route the action)
- Test: `supabase/functions/whatsapp-evolution-bridge/reconnect.test.ts`

**Interfaces — Produces:**
- `reconnectQr(deps: ReconnectDeps, userId: string, socialAccountId: string): Promise<{ success: true; social_account_id: string; qr: string | null; state: string | null }>`
- `class ReconnectError extends Error { status: 404 | 409 | 502 }`

```ts
export interface ReconnectDeps {
  findAccount(userId: string, id: string): Promise<{ id: string; platform_user_id: string; connection_mode: string | null } | null>;
  findInstance(id: string): Promise<{ instance_name: string; jwt_key: string } | null>;
  api: Pick<EvolutionApi, "fetchInstance" | "connectionState" | "createInstance" | "connect" | "logout" | "setWebhook">;
  webhook: { url: string; events: EvolutionEvent[] };
  saveQr(id: string, qr: string | null, state: string | null): Promise<void>;
}
```

- [ ] **Step 1: Tests (agy).** One test per row:

| Case | Expectation |
|---|---|
| account not found | `ReconnectError` 404 |
| `pending_…` or `retired_…` or not `evolution_qr` | 409 |
| instance row missing | 409 `reconnect_unavailable` |
| remote instance missing, shape 1: `fetchInstance` resolves `null` (empty list, `evolutionApi.ts:208-210`) | `createInstance` called with the **same** `instanceName` and `headers.jwt_key` = stored key; then `connect`; `saveQr` called |
| remote instance missing, shape 2: `fetchInstance` throws `new EvolutionApiError("x", 404, null)` | same as shape 1 |
| `fetchInstance` throws `EvolutionApiError` with status 500 | 502; `createInstance` not called |
| remote present, `connectionState` → `open` | `logout` then `connect`, in that order |
| remote present, `close` | no `logout`; `connect` |
| any step throws an Evolution error | `ReconnectError` 502; `saveQr` never called |
| every success | `setWebhook` called once with the stored `jwt_key` |

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement (GLM).**

```ts
export class ReconnectError extends Error {
  constructor(message: string, public readonly status: 404 | 409 | 502) { super(message); this.name = "ReconnectError"; }
}

export async function reconnectQr(deps: ReconnectDeps, userId: string, socialAccountId: string) {
  const account = await deps.findAccount(userId, socialAccountId);
  if (!account) throw new ReconnectError("WhatsApp Direct QR account not found", 404);
  if (account.connection_mode !== "evolution_qr"
    || account.platform_user_id.startsWith("pending_")
    || account.platform_user_id.startsWith("retired_")) {
    throw new ReconnectError("This connection can't be reconnected; connect a new one instead", 409);
  }
  const instance = await deps.findInstance(socialAccountId);
  if (!instance) throw new ReconnectError("reconnect_unavailable", 409);
  const name = instance.instance_name;
  try {
    let exists: boolean;
    try {
      exists = (await deps.api.fetchInstance(name)) !== null;
    } catch (error) {
      if (error instanceof EvolutionApiError && error.status === 404) exists = false;
      else throw error;
    }
    if (!exists) {
      await deps.api.createInstance({ instanceName: name, webhook: { url: deps.webhook.url, headers: { jwt_key: instance.jwt_key }, events: deps.webhook.events } });
    } else if (extractState(await deps.api.connectionState(name)) === "open") {
      await deps.api.logout(name);
    }
    await deps.api.setWebhook(name, { url: deps.webhook.url, headers: { jwt_key: instance.jwt_key }, events: deps.webhook.events });
    const connection = await deps.api.connect(name);
    const qr = extractQr(connection);
    const state = extractState(connection);
    await deps.saveQr(socialAccountId, qr, state);
    return { success: true as const, social_account_id: socialAccountId, qr, state };
  } catch (error) {
    if (error instanceof ReconnectError) throw error;
    console.error(`[whatsapp-evolution-bridge] reconnect failed for ${socialAccountId}`);
    throw new ReconnectError("reconnect_failed", 502);
  }
}
```

Imports in `reconnect.ts`: `import { EvolutionApiError, type EvolutionApi, type EvolutionEvent } from "../_shared/evolutionApi.ts";`. Move `extractQr` and `extractState` from `index.ts:61-68` into a new `supabase/functions/whatsapp-evolution-bridge/qr.ts` and export them; `index.ts` imports from there. The deps wiring passes the existing `EVOLUTION_EVENTS` constant (`index.ts:15`, already typed `EvolutionEvent[]`).

In `index.ts`, route it:

```ts
    if (body.action === "reconnect_qr") {
      if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
      try {
        return restrictedJsonResponse(req, await reconnectQr(reconnectDeps(context), context.user.id, body.social_account_id));
      } catch (error) {
        if (error instanceof ReconnectError) throw new BridgeError(error.message, error.status);
        throw error;
      }
    }
```

`reconnectDeps(context)` wires `findOwnedEvolutionAccount`, the `whatsapp_evolution_instances` lookup (`instance_name, jwt_key`), `createEvolutionApi()`, `{ url: \`${context.webhookBaseUrl}/functions/v1/whatsapp-evolution-webhook\`, events: EVOLUTION_EVENTS }` and an update of `last_qr, last_connection_state`.
- [ ] **Step 4: Run, check, commit.** `feat(whatsapp-qr): reconnect a Direct QR connection in place`

### Task A3: Reconnect UI and mismatch screen

**Files:**
- Create: `src/hooks/useReconnectableQrAccounts.ts`
- Modify: `src/components/messaging/WhatsAppSetup.tsx` (the "Previously connected" list also renders QR rows; their Reconnect calls `reconnect_qr` and then sets `qrAccountId`)
- Modify: `src/components/messaging/WhatsAppQrScanner.tsx` (the `number_mismatch` state)
- Test: `src/hooks/__tests__/useReconnectableQrAccounts.test.tsx`, `src/components/messaging/__tests__/WhatsAppQrScanner.mismatch.test.tsx`, `src/components/messaging/__tests__/WhatsAppSetup.qrReconnect.test.tsx`

**Interfaces — Produces:** `useReconnectableQrAccounts()` → `UseQueryResult<ReconnectableWhatsAppAccount[]>` (reuses the type from `useReconnectableWhatsApp.ts`). `WhatsAppQrScanner` gains the optional prop `onConnectAsNew?: () => void`.

- [ ] **Step 1: Tests (agy).**
  - **Hook:**
    - query filters: `platform=whatsapp`, `connection_mode=evolution_qr`, `is_active=false`, not `pending_%`, not `retired_%`, ordered by `updated_at desc`;
    - an error surfaces as `isError`.
  - **Setup:**
    - a QR row shows "Reconnect" and the text "Disconnected. Scan a new QR code with the same phone to restore it.";
    - clicking it invokes `whatsapp-evolution-bridge` with `{action:"reconnect_qr", social_account_id}`, then mounts the scanner for that id;
    - a 502 shows the toast "Couldn't start the reconnect. Try again in a minute.".
  - **Scanner:**
    - when the poll returns `state:"number_mismatch", expected_last4:"0350"`, it shows "You scanned a different phone. This connection belongs to the number ending 0350.", plus the buttons "Scan the right phone" (invokes `reconnect_qr` and resets) and "Connect as a new account" (calls `onConnectAsNew`);
    - the success card is **not** shown, and `onComplete` is not called.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement (GLM).**
  - **Hook:** same shape as `useReconnectableWhatsApp`, with `.eq("connection_mode", "evolution_qr")` replacing the `.in(...)` filter, and query key `["whatsapp-reconnectable-qr", user?.id]`.
  - **Scanner:** extend `QrStatus` with `expectedLast4: string | null`; read `data.expected_last4`. Before the `open` branch, add a `number_mismatch` render branch: a `Card` with a destructive border, the copy above, and the two buttons. Stop treating `open` as completion while the mismatch is showing.
  - **Setup:** render the QR rows from `useReconnectableQrAccounts` inside the existing "Previously connected" block, with the QR copy above. The click handler:

```ts
const handleQrReconnect = async (accountId: string) => {
  const { data, error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
    body: { action: "reconnect_qr", social_account_id: accountId },
  });
  if (error || data?.error) {
    toast({ title: t("setup.qrReconnectFailed", "Couldn't start the reconnect. Try again in a minute."), variant: "destructive" });
    return;
  }
  setQrAccountId(accountId);
};
```

Pass `onConnectAsNew={() => { setQrAccountId(null); setQrNameOpen(true); }}` to the scanner.
- [ ] **Step 4: Gates. Commit.** `feat(whatsapp): Reconnect button for Direct QR connections`

### Task A4: PR-A land

- [ ] Guards, as in D6.
- [ ] No migration in PR-A.
- [ ] PR, CI, merge.
- [ ] Probe `whatsapp-evolution-bridge` (expect 401).
- [ ] Live check: on the owner's account, disconnect, then Reconnect, scan the same phone, and confirm the same `social_accounts.id` is active again.

---

# PR-BC — One mover, automatic and on demand

Branch `feat/wa-continuity-bc`, from `origin/main` after PR-A merges.

### Task BC1: Migration — FK replacement, config archive, mover (orchestrator)

**Files:**
- Create: `supabase/migrations/20261004110000_store_events_binding_fk_without_account.sql`
- Create: `supabase/migrations/20261004110500_move_whatsapp_account_setup.sql`
- Modify: `supabase/tests/whatsapp_account_continuity.sql` (append M1–M16)

**Interfaces — Produces:** `public.move_whatsapp_account_setup(p_from uuid, p_to uuid, p_mode text, p_choices jsonb DEFAULT NULL) RETURNS jsonb`, service_role only.
- `p_mode` ∈ `('auto','interactive')`.
- `p_choices` (interactive) is `{"agent_config":"source"|"destination", "connectors":{"<name>":"replace"|"skip"}, "partner":true|false}`.
- **Validation** (debate 1, points 4 and 15), applied before any row changes; each failure raises `22023` with `move_whatsapp_account_setup: <reason>`:
  - an unknown top-level key or value in `p_choices`;
  - a connector name that is not an account-scoped connector on `p_from`;
  - `agent_config:"source"` together with any `"skip"` for a connector that has a store binding. The binding would stay on the source with no agent config left there, which is the incident's failure.
- **In-flight store events** (debate 1, point 12): if any `store_events` row for a binding in group S has `status IN ('claimed','sending')`:
  - `auto` defers group S (reason `store_event_in_flight`; activation and independent items still proceed);
  - `interactive` raises `55006` (`object_in_use`), which the edge action maps to 409 "An order message is being sent right now. Try again in a minute."

  The mover takes `FOR UPDATE` on those bindings' `store_events` rows that are `pending`, `claimed` or `sending` before deciding (no `SKIP LOCKED`), so a claim already in progress commits first and is then seen as in flight.
- Returns `{status, moved:{<table>:n}, left:[{item, reason}], conflicts:[{item, name?}]}`.

- [ ] **Step 1: Suite cases (red first).** Fixtures:
  - for `u_a`: `src` (inactive QR `'96500000009'` with full setup: config, a woo connector, a link, a binding + 3 `store_events` (one `pending` unclaimed, one `claimed`, one `sent`), 2 knowledge links, a waitlist row, a template with `meta_template_id`, partner key primary + link + webhook in the same workspace, an n8n `app_settings` row, `account_metadata.automation_handler='internal'`);
  - for `u_a`: `dst` (active QR, same number, retired-merge scenario, but the test calls the mover directly);
  - for `u_a`: `dst_other` (different number, different `waba_id`);
  - for `u_a`: `dst_ws2` (a different workspace);
  - for `u_b`: `acc_b`.

  Cases:

| # | Case | Expect |
|---|---|---|
| M1 | auto, dst empty | status `moved`; config, connector, link, binding, knowledge, waitlist, partner, n8n, handler all on dst; the binding id unchanged |
| M2 | store events after M1 | the pending unclaimed event's `social_account_id` = dst; the claimed and sent ones still = src |
| M3 | repeated call | status `noop`, no row changes |
| M4 | auto, dst already has a config | status `deferred`; config, connector, link, binding and waitlist still on src; knowledge moved; dst `account_metadata.setup_move_pending.from` = src |
| M5 | interactive, dst has a config, `agent_config:"source"` | dst config replaced; the old dst config is in `ai_agent_config_archive` |
| M6 | interactive, a connector-name clash, `"skip"` | the connector stays on src; its binding stays on src; `left` names it |
| M7 | dst_other (different number) | waitlist left with reason `number_changed`; the template left with `waba_mismatch` |
| M8 | cross-workspace (`dst_ws2`) | raises `22023` |
| M9 | cross-user (`acc_b`) | raises `22023` |
| M10 | `p_from = p_to`, or a `pending_` row | raises `22023` |
| M11 | grants | anon and authenticated cannot EXECUTE |
| M12 | test cases: dst has 99, src has 3 | 1 moved, `left` reports 2 with `test_case_cap` |
| M13 | FK | inserting a `store_events` row whose `binding_id` belongs to `u_b` fails |
| M14 | validation + rollback | `p_choices` naming an unknown connector → `22023`; `agent_config:"source"` + skip of a bound connector → `22023`; in both, no row changed |
| M17 | in-flight | a `claimed` event on a group-S binding: `auto` → `deferred` with reason `store_event_in_flight`; `interactive` → `55006`; nothing in group S moved |
| M18 | account FK | inserting a `store_events` row whose `social_account_id` belongs to `u_b` (binding of `u_a`) fails |
| M19 | n8n prefix | the nonmatching `n8nXwebhookX<u_a>X1` key is untouched; the real key is rewritten |
| M21 | dismissal | `dismiss_whatsapp_setup_move(dst, src)` twice leaves `setup_move_dismissed = [src]`; it is not executable by authenticated |

M15, M16 and M20 are written in BC2 (they need BC2's migration).

- [ ] **Step 2: Run the harness.** Expected: FAIL at M1 (function missing).
- [ ] **Step 3: FK migration.**

```sql
-- store_events keeps its own social_account_id as history; the binding identity no longer
-- pins it (spec 2026-10-01 §5.3). Tenancy still holds through (binding_id, user_id, connector_id).
ALTER TABLE public.store_webhook_bindings
  ADD CONSTRAINT store_webhook_bindings_id_user_connector_key UNIQUE (id, user_id, connector_id);
ALTER TABLE public.store_events DROP CONSTRAINT store_events_binding_identity_fk;
ALTER TABLE public.store_events
  ADD CONSTRAINT store_events_binding_tenant_fk
  FOREIGN KEY (binding_id, user_id, connector_id)
  REFERENCES public.store_webhook_bindings (id, user_id, connector_id) ON DELETE CASCADE;
```

`store_events.social_account_id` has **no** FK of its own today (`20260927120000_store_events.sql:87-94`); the dropped four-column FK was its only tenancy proof. The same migration therefore adds one (debate 1, point 5), after a preflight:

```sql
DO $pre$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.store_events e
     WHERE NOT EXISTS (SELECT 1 FROM public.social_accounts a WHERE a.id = e.social_account_id AND a.user_id = e.user_id)
  ) THEN
    RAISE EXCEPTION 'store_events has rows whose account is not the owner''s; resolve before adding the FK';
  END IF;
END $pre$;
ALTER TABLE public.store_events
  ADD CONSTRAINT store_events_account_owner_fk
  FOREIGN KEY (social_account_id, user_id) REFERENCES public.social_accounts (id, user_id) ON DELETE CASCADE;
```

`social_accounts` already carries `UNIQUE (id, user_id)` (`20260927120000_store_events.sql:9`).

- [ ] **Step 4: Mover migration.** Write `move_whatsapp_account_setup` in plpgsql, implementing spec §5.1–§5.3 exactly.
  - **Locks:** `pg_advisory_xact_lock(hashtextextended(v_user::text || ':wa-setup', 0))` first; then `SELECT … FOR UPDATE` on both `social_accounts` rows `ORDER BY id`.
  - **Guards:** same user, same `workspace_id`, both whatsapp, `p_from <> p_to`, neither `pending_%`. Otherwise `RAISE … USING errcode = '22023'`.
  - **Number match:** normalize to digits. QR: `platform_user_id` (unless `retired_` → use `account_metadata->>'retired_number'`, which the BC2 activation stores). Meta: `regexp_replace(account_metadata->>'display_phone_number', '\D', '', 'g')`.
  - **Group S** (auto: deferred on any config or connector-name conflict; interactive: per `p_choices`):
    - `UPDATE ai_agent_configs SET social_account_id = p_to`. For the interactive "source" choice, first `INSERT INTO ai_agent_config_archive SELECT now(), * FROM ai_agent_configs WHERE social_account_id = p_to`, then delete it.
    - `UPDATE ai_agent_tools SET social_account_id = p_to WHERE social_account_id = p_from` (except skipped names).
    - `INSERT INTO ai_agent_tool_accounts … ON CONFLICT DO NOTHING`, then delete the source links.
    - `UPDATE store_webhook_bindings SET social_account_id = p_to WHERE connector_id IN (<moved connectors>)`.
    - `UPDATE store_events SET social_account_id = p_to WHERE binding_id IN (<moved bindings>) AND status = 'pending' AND claimed_at IS NULL`.
    - Waitlist only when the numbers match: `UPDATE stock_waitlist SET social_account_id = p_to WHERE …`, with `ON CONFLICT` handled via a delete of the duplicates first, using the unique `(social_account_id, connector_id, phone, product_id)`.
  - **Independent items:**
    - knowledge links: insert … on conflict do nothing, then delete from src;
    - test cases: up to `100 - count(dst)`, by `position`;
    - templates only when `waba_id` matches;
    - partner (auto: always; interactive: only when `p_choices->>'partner' = 'true'`): `partner_api_keys.social_account_id`, `partner_api_key_accounts` (on conflict do nothing), `partner_webhooks.social_account_id`;
    - `app_settings`: `UPDATE … SET value = jsonb_set(value, '{social_account_id}', to_jsonb(p_to::text)) WHERE left(key, length('n8n_webhook_' || v_user::text || '_')) = 'n8n_webhook_' || v_user::text || '_' AND value->>'social_account_id' = p_from::text`. This is a literal prefix, not `LIKE`, whose `_` is a wildcard;
    - `account_metadata` handler keys: copied only where dst lacks the key;
    - `whatsapp_scheduled_messages` with `status = 'pending'`.
  - **Bookkeeping:**
    - on a deferral, set dst `account_metadata.setup_move_pending = {from: p_from, at: now()}`;
    - when group S moves, remove `setup_move_pending` and `undelivered_store_events` from dst and src;
    - return `noop` when nothing changed.

  Also create the table:

```sql
CREATE TABLE IF NOT EXISTS public.ai_agent_config_archive (
  archived_at timestamptz NOT NULL DEFAULT now(),
  LIKE public.ai_agent_configs
);
ALTER TABLE public.ai_agent_config_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_agent_config_archive FROM PUBLIC, anon, authenticated;
```

End the migration with `REVOKE ALL ON FUNCTION public.move_whatsapp_account_setup(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION … TO service_role;`.
- [ ] **Step 5: Run the harness until M1–M14 pass.**
- [ ] **Step 6: Mutation checks**, one at a time, then revert. Each must turn its case red:

| Mutation | Case that must fail |
|---|---|
| drop the workspace check | M8 |
| move the binding without its connector | M6 |
| re-point all events, not only pending | M2 |
| grant to authenticated | M11 |

- [ ] **Step 7: Concurrency rehearsal (manual, two psql sessions on the harness DB).**
  - Session 1: `BEGIN; SELECT move_whatsapp_account_setup(src, dst, 'auto');`, holding the transaction open.
  - Session 2: `SELECT activate_evolution_qr_account(<pending row>, '96500000009');` waits, with no deadlock error.
  - Commit session 1; session 2 completes.
  - Record the result in the suite header comment.
- [ ] **Step 8: Commit** both migrations and the suite. `feat(db): move_whatsapp_account_setup and binding FK without account identity`

### Task BC2: Migration — activation calls the mover (orchestrator)

**Files:**
- Create: `supabase/migrations/20261004111000_activate_evolution_qr_moves_setup.sql`

- [ ] **Step 1:** Copy the full `CREATE OR REPLACE FUNCTION public.activate_evolution_qr_account` from `20260824000000_evolution_qr_activation_merges_duplicate_numbers.sql` verbatim, and apply exactly four edits:
  1. As the first statement after the initial unlocked `SELECT user_id`, add `PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':wa-setup', 0));`. It comes before the existing per-number lock, matching the mover's lock order.
  2. In the duplicate branch, before `update social_accounts set platform_user_id = 'retired_' …`, add `update social_accounts set account_metadata = coalesce(account_metadata,'{}'::jsonb) || jsonb_build_object('retired_number', p_owner_number) where id = v_duplicate_id;` so the mover's number match still works after retirement.
  3. Directly after the retire `update`, **claim the number on the destination first**: `update social_accounts set platform_user_id = p_owner_number, is_active = true where id = p_account_id;`. The mover rejects a `pending_` destination, so it must not run while the destination is still provisional (debate 1, point 1). The unique key is free, because the duplicate was just retired.
  4. Then add `PERFORM public.move_whatsapp_account_setup(v_duplicate_id, p_account_id, 'auto');`.

  The existing final `update … set platform_user_id = p_owner_number, is_active = true where id = p_account_id` stays. It is now a no-op on the duplicate path and still required on the no-duplicate path.

  Keep the REVOKE/GRANT block identical.
- [ ] **Step 2:** Append to the suite:
  - **M15:** a `pending_` row activated for src's number:
    - src retired with `retired_number` set;
    - dst active with that number;
    - group S on dst;
    - the binding id unchanged.

    If the mover raised, the whole activation would roll back and M15 would fail.
  - **M16:** an established row passed a different number. The RPC returns the stored number and leaves `platform_user_id` unchanged; the mismatch block itself lives in the TypeScript sync (A1).
  - **M20:** a duplicate whose dst already had a config. Activation still succeeds, the move is `deferred`, and dst has `setup_move_pending`.

  Harness: M15, M16 and M20 pass, and the existing activation suites stay green. Re-run the concurrency rehearsal (BC1 Step 7) with activation as session 1.
- [ ] **Step 3: Commit.** `feat(db): QR re-pair carries the AI agent setup to the surviving account`

### Task BC3: `move_setup` action and the C banner

**Files:**
- Create: `supabase/functions/whatsapp-evolution-bridge/moveSetup.ts`
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts` (route `move_setup`)
- Create: `src/hooks/useSetupMoveCandidates.ts`
- Create: `src/components/messaging/BringOverSetupBanner.tsx`
- Modify: `src/pages/whatsapp/Setup.tsx`, `src/components/messaging/AiAgentManager.tsx` (mount the banner)
- Test: `supabase/functions/whatsapp-evolution-bridge/moveSetup.test.ts`, `src/components/messaging/__tests__/BringOverSetupBanner.test.tsx`, `src/hooks/__tests__/useSetupMoveCandidates.test.tsx`

**Interfaces — Consumes:** the mover (BC1) and `get_whatsapp_account_setup_summary` (D1).
**Produces:**
- `moveSetup(deps, userId, { from, to, choices })` → the mover's jsonb.
- `useSetupMoveCandidates(activeAccountId)` → `{ from: ReconnectableWhatsAppAccount; summary: WhatsAppSetupSummary }[]`.

- [ ] **Step 1: Tests (agy).**
  - **`moveSetup`:**
    - either account not owned → 404;
    - `from === to` → 400;
    - otherwise it calls the `rpc("move_whatsapp_account_setup", {p_from, p_to, p_mode:"interactive", p_choices})` port once and returns its result;
    - an RPC error with code `22023` → 409 with the message "These two connections can't share setup (different workspace or not finished connecting)".
  - **Candidates hook:** returns inactive or `retired_` WhatsApp rows of the same user that have a non-zero summary and either:
    - the same normalized number as the active account (digits of `platform_user_id`, `account_metadata.retired_number` or `account_metadata.display_phone_number`), or
    - are the most recently deactivated row when the owner has exactly one active WhatsApp account.

    It excludes pairs listed in `account_metadata.setup_move_dismissed` of the active account. Whenever the active account has `setup_move_pending`, that `from` row is always included.
  - **`dismiss_setup_move`:** a non-owned `to` → 404; otherwise it calls the `rpc("dismiss_whatsapp_setup_move", {p_to, p_from})` port once. The RPC appends `from` to `account_metadata.setup_move_dismissed`, deduplicated, with an atomic `jsonb_set`; it is service_role only, created in the BC1 mover migration and covered by M21.
  - **Banner:**
    - renders "xsellpoint (old) has an AI agent, 1 WooCommerce connector, a store webhook and 5 knowledge sources. Move them to xsellpoint?";
    - a checklist, with "Store webhook" disabled and the hint "Moves with its WooCommerce connector" when the connector is unchecked;
    - when the summary shows the destination already has an agent config, a radio "Keep this account's AI agent / Use the one from xsellpoint (old)";
    - "Move" invokes the bridge with `{action:"move_setup", from, to, choices}`;
    - on success it shows the toast "Setup moved" and invalidates `["whatsapp-setup-summary"]`, `["ai-agent-config"]` and `["ai-agent-tools"]`;
    - "Not now" invokes the bridge with `{action:"dismiss_setup_move", from, to}` and hides the banner.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement (GLM).**
  - `moveSetup.ts` follows the `reconnect.ts` pattern: a deps object, a typed error class `MoveSetupError` with `status`, and pure functions.
  - Route `move_setup` and `dismiss_setup_move` in `index.ts`.
    - Extend the closed `BridgeBody` action union (`index.ts:31-44`) with `"reconnect_qr" | "move_setup" | "dismiss_setup_move"`, plus the optional fields `from?: string; to?: string; choices?: Record<string, unknown>`.
    - `move_setup` request `{action, from, to, choices}` → response: the mover's jsonb. Errors: `22023` → 409 "These two connections can't share setup (different workspace or not finished connecting)"; `55006` → 409 "An order message is being sent right now. Try again in a minute.".
    - `dismiss_setup_move` request `{action, from, to}` → `{success:true}`.
    - Both check ownership of both ids first.
  - The bridge's `findOwnedAccount` filters `connection_mode === "evolution_qr"`. Add a separate `findOwnedWhatsAppAccount` for these two actions, so a Meta row is also accepted.
  - The banner uses shadcn `Alert` + `Checkbox` + `RadioGroup`, with the copy above.
- [ ] **Step 4: Gates. Commit.** `feat(whatsapp): bring over the AI agent setup from a previous connection`

### Task BC4: PR-BC land

- [ ] Guards: clean-code-guard, test-guard, docs-guard on the spec and plan if edited.
- [ ] Apply `20261004110000`, `20261004110500` and `20261004111000` to production as `supabase_admin` **before merge**, in that order, then `NOTIFY pgrst, 'reload schema'`. Verify:
  - `SELECT conname FROM pg_constraint WHERE conname = 'store_events_binding_tenant_fk'` returns 1 row;
  - `has_function_privilege('authenticated', 'public.move_whatsapp_account_setup(uuid,uuid,text,jsonb)', 'EXECUTE')` is false.
- [ ] PR, CI, merge. Probe `whatsapp-evolution-bridge` (expect 401).
- [ ] **Live check (with the owner):**
  - the C banner does not appear for the current account (its setup was moved by hand on 2026-10-01);
  - place a COD test order, and it sends.
- [ ] Update `#250` with the PR links and close it.

## Self-review notes

**Spec coverage:**

| Spec section | Tasks |
|---|---|
| §3 | D1 (summary keys), BC1 (mover) |
| §4 | A1–A3 |
| §5.1–5.4 | BC1, BC2 |
| §5.5 | BC3 |
| §6 | BC1 M4–M6 |
| §7 D1 | D5 |
| §7 D2 | D2, D3 |
| §7 D3 | D4 |
| §8 | the PR order |
| §9 | each task's tests and harness cases |

**Deviation from spec:** spec §4 put the mismatch return in the activation RPC. The mismatch path for an *established* row never reaches the RPC (`syncEvolutionAccountConnection` only calls it for `pending_` rows, `evolutionQrAccount.ts:248-253`), so A1 implements the block in the shared sync instead. BC2 leaves the RPC's established-row branch unchanged (M16).

## Debate log

**Round 1** (Codex gpt-6-sol, high, read-only): 15 points; all accepted and resolved in place. Each fix is tagged "debate 1, point N" in the text above.

| # | Point | Resolution |
|---|---|---|
| 1 | BC2 calls the mover while the destination is still `pending_` | claim the number on the destination before the mover call; M15 |
| 2 | wrong route | `/messaging/whatsapp/setup` |
| 3 | `fetchInstance` returns `null` for missing; event typing | both shapes handled; `EvolutionEvent[]` |
| 4 | an interactive choice can split group S | rejected with `22023` before any change |
| 5 | `store_events` has no account FK | `store_events_account_owner_fk` + preflight; M18 |
| 6 | cron pattern copied from a Cloud-era job | self-hosted SQL embedded |
| 7 | the count measured retries | count dropped; the flag is idempotent |
| 8 | a thrown state read looked connected | `account_state_unknown` warning |
| 9 | email flag write raced | `mark_undelivered_alert_emailed` RPC; email preference honoured |
| 10 | mismatch result incomplete across callers | `ReconcileResult` in bridge and pairing; webhook early return |
| 11 | clear-flag placement; test fake | explicit call sites in sync; RPC-name dispatch in the fake |
| 12 | a claimed event during a move | rows locked; `auto` defers, `interactive` 409; M17 |
| 13 | `LIKE` underscore wildcard | literal prefix; S8/M19 |
| 14 | dismissal action names | `dismiss_setup_move` + `dismiss_whatsapp_setup_move` RPC; M21 |
| 15 | undefined strict mode; M15 placement | validation contract; M15/M16/M20 in BC2 |
