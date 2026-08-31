# Per-account connectors — implementation plan

> **For agentic workers:** every task below names the spec section that owns its design.
> Read `ARCHITECTURE.md` before touching `src/**` or `supabase/functions/**`, and read
> `docs/superpowers/specs/2026-08-30-per-account-connectors-design.md` (revision 3) for the
> reasoning behind any decision that looks arbitrary. Steps use `- [ ]` for tracking.

**Goal:** every connected account gets its own connectors, any connector can be shared with
named other accounts, the agent is told how to use each connector type, and the eight
vendor types stop being decoration.

**Architecture:** `ai_agent_tools` gains an owning `social_account_id`, a `scope` enum and
Vault-backed credentials; `ai_agent_tool_accounts` adds explicit shares; a shared connector
registry in `supabase/functions/_shared/` becomes the single definition of every type's
credential fields and usage guide; `ai-agent-reply` resolves tools for the account instead
of the user.

**Tech stack:** Postgres 17.6 + `supabase_vault 0.3.1` (self-hosted), Deno Edge Functions,
React 18 + TypeScript + Vite, vitest (frontend) and `deno test` (functions).

**Spec:** `docs/superpowers/specs/2026-08-30-per-account-connectors-design.md` rev 3.

---

## Ground rules for every task

- **Gates.** `npx tsc -b --noEmit` (**build mode, as CI runs it** — plain `tsc --noEmit`
  does not type-check the test project and let a file missing its `vitest` imports through),
  `npx eslint <changed files>`, `npx vitest run`,
  `npm run build`, and for `supabase/functions/**`:
  `deno test --allow-all supabase/functions/<dir>` — **run Deno first, then
  `rm -rf node_modules/.deno && bun install`**, because `--node-modules-dir=auto` installs a
  second React copy that breaks vitest.
- **TDD.** Write the failing test, run it and see it fail for the stated reason, implement,
  see it pass. A test that passes before the implementation is a broken test, not a fast one.
- **Commits are scoped.** `git commit -- <files>`. Never commit `.env*`, `b64.txt`, logs or
  backups.
- **Migrations are applied by the owner, by hand.** No task runs one. Rehearsal is
  `BEGIN … ROLLBACK` **against production**, and note that Postora migrations self-commit,
  so an outer `BEGIN` does not protect you — rehearse statement by statement.
- **Edge Functions deploy by file copy**, never `npx supabase functions deploy`. See
  `docs/runbooks/deploy-edge-function.md`.

---

## File structure

| Path | Responsibility |
|---|---|
| `supabase/functions/_shared/connectorRegistry.ts` | **New.** One entry per connector type: label, credential field schema, `usageGuide`. The single definition §5.1 requires |
| `supabase/functions/_shared/connectorRegistry.test.ts` | **New.** The four-way contract test |
| `supabase/functions/_shared/composeToolDescription.ts` | **New.** Pure guide+description composer with the 600-char budget (§13.3) |
| `supabase/functions/_shared/toolResolution.ts` | **New.** Pure predicate: which tools resolve for an account, and the name-collision rule (§12.3) |
| `src/lib/connectorRegistry.ts` | **New.** Browser mirror, re-exporting the same field data |
| `src/lib/accountSharing.ts` | **New.** Generalised from `src/lib/knowledgeSharing.ts`; adds an always-on owning account (§12.2) |
| `supabase/migrations/2026…_connector_scope_and_sharing.sql` | **New.** Migration A (§9, PR-3) |
| `supabase/migrations/2026…_connector_uniqueness_contract.sql` | **New.** Migration B (§9, PR-7) |
| `supabase/functions/messaging-api/index.ts` | `ai_upsert_tool` / `ai_list_tools` / `ai_delete_tool` become account-scoped; new `set_tool_accounts`, `test_connection` |
| `supabase/functions/ai-agent-reply/index.ts` | Loads tools for the account, not the user |
| `supabase/functions/ai-agent-reply/tools.ts` | `customToolDefinitions` composes the usage guide |
| `supabase/functions/ai-agent-adapters/` | **New function.** Vendor adapters (§11) |
| `src/components/automation/DatabaseConnectorsManager.tsx` | Account dropdown, sharing strip, rekeyed by tool id |
| `src/pages/Settings.tsx` | Read-only overview (§14) |

---

# PR-2 — the connector registry

**Spec:** §5.1, §6, §13.2. **No behaviour change.** Nothing imports the registry yet.

### Task 2.1: the registry module

**Files:** Create `supabase/functions/_shared/connectorRegistry.ts`,
`supabase/functions/_shared/connectorRegistry.test.ts`.

- [ ] **Step 1 — write the failing contract test.**

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CONNECTOR_TYPES, connectorDefinition } from "./connectorRegistry.ts";

// The four-way contract §5.1 requires: the registry, the DB CHECK, the server
// allow-list and the browser picker must name the SAME twelve types. Today they
// name eight, eight and twelve, and the server silently rewrites the other four
// to custom_rest -- a success toast over a connector the user did not choose.
Deno.test("every declared type has a definition with fields and a guide", () => {
  for (const type of CONNECTOR_TYPES) {
    const definition = connectorDefinition(type);
    assertEquals(typeof definition.label, "string");
    assertEquals(Array.isArray(definition.credentials), true);
    // custom_rest is the one type with no vendor semantics to describe.
    if (type !== "custom_rest") {
      assertEquals(typeof definition.usageGuide?.whenToUse, "string");
    }
  }
});

Deno.test("an unknown type is refused by name, never substituted", () => {
  let message = "";
  try { connectorDefinition("stripe_v2" as never); } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  assertEquals(message.includes("stripe_v2"), true);
});
```

- [ ] **Step 2 — run it, confirm it fails** with a module-not-found error:
      `deno test --allow-all supabase/functions/_shared/connectorRegistry.test.ts`
- [ ] **Step 3 — implement the registry.** Twelve types:
      `supabase, mysql_postgres, woocommerce, shopify, salla, zid, formula, custom_rest,
      myfatoorah, stripe, higgsfield, mcp_custom`. Credential field schemas come from
      **spec §6.1 and §6.3 verbatim** — they are already written there with citations.
      Each field: `{ key, label, kind: "text"|"secret"|"url", required, help }`.
      `usageGuide: { whenToUse, requestExamples, limits }` per §13.2.
- [ ] **Step 4 — run the test, confirm it passes.**
- [ ] **Step 5 — commit.**

```bash
git add supabase/functions/_shared/connectorRegistry.ts supabase/functions/_shared/connectorRegistry.test.ts
git commit -m "feat(connectors): one definition per connector type, with credential fields and a usage guide"
```

### Task 2.2: the browser mirror and the four-way test

**Files:** Create `src/lib/connectorRegistry.ts`, `src/lib/__tests__/connectorRegistry.test.ts`.

- [ ] **Step 1 — write the failing test.** Three of the four sources are asserted **equal**
      (browser picker, browser mirror, shared registry — twelve ids, sorted). The fourth,
      the DB CHECK, cannot be twelve yet: Migration A adds the four missing types and PR-2
      is forbidden to write a migration. Codex caught this contradiction in the first
      revision of this plan; asserting four-way equality here would have been a test that
      could not pass.

      So the DB assertion is a **subset with a named, dated gap**:

      ```ts
      // Emptied by PR-3's Migration A. While it is non-empty, these four types
      // exist in the registry and the picker but the CHECK constraint would
      // reject them -- which is exactly why PR-4 must not start returning them
      // before that migration is applied.
      const PENDING_DB_TYPES = ["higgsfield", "mcp_custom", "myfatoorah", "stripe"];
      ```

      Assert `dbTypes ⊆ registryTypes` (catches a type in the database that nothing
      declares) **and** `registryTypes \ dbTypes === PENDING_DB_TYPES` (catches a
      thirteenth type added to the registry without the database). When PR-3 lands, the
      difference becomes empty and this constant must be emptied with it — the test is the
      tripwire that makes PR-3 finish the job.

      Read the DB list from the migration file text, so the two cannot drift silently.
      Import the server allow-list from a named export — extract it from
      `messaging-api/index.ts` into the shared registry if it is still an inline array;
      that extraction is the point of this task.
- [ ] **Step 2 — run it, confirm it fails** naming the four missing types.
- [ ] **Step 3 — implement** the mirror. Deno cannot import from `src/`, and the browser
      cannot import from `supabase/functions/`, so this is a deliberate duplicate whose
      only job is to be kept honest by the test above. Say so in a comment.
- [ ] **Step 4 — run, confirm pass.** Also run `npx tsc --noEmit`.
- [ ] **Step 5 — commit.**

### Task 2.3: `composeToolDescription`

**Files:** Create `supabase/functions/_shared/composeToolDescription.ts` and its test.

- [ ] **Step 1 — write the failing test.**

```ts
Deno.test("the guide is sent before the user's own description", () => { /* assert order */ });
Deno.test("a tool with no guide degrades to today's description exactly", () => {
  // custom_rest has no guide. This must not throw and must not prepend an empty
  // section -- every existing connector goes through this path.
});
Deno.test("the composed description respects the 600-character budget", () => {
  // Descriptions are resent on every turn of every conversation and this worker
  // has a 60s ceiling it has already hit. Truncation is at a sentence boundary.
});
```

- [ ] **Step 2 — run, confirm it fails.**
- [ ] **Step 3 — implement** per §13.3.
- [ ] **Step 4 — run, confirm pass.**
- [ ] **Step 5 — commit.**

**PR-2 gate:** contract test passes for all twelve types; no runtime file imports the
registry yet, so `git diff --stat` shows only new files plus the allow-list extraction.

---

# PR-3 — Migration A (owner applies by hand)

**Spec:** §4.1, §4.2, §4.3, §12.1, §12.2. **Adds only. Drops nothing.**

### Task 3.1: write the migration

**Files:** Create `supabase/migrations/<timestamp>_connector_scope_and_sharing.sql`.

- [ ] **Step 1 — write it**, in this order inside one `BEGIN`/`COMMIT`:
  1. `ALTER TABLE ai_agent_tools ADD COLUMN social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE, ADD COLUMN platform TEXT, ADD COLUMN scope TEXT NOT NULL DEFAULT 'all_accounts' CHECK (scope IN ('account','all_accounts'))`.
     **The default is `'all_accounts'` and the CHECK pairing scope with account presence
     lands in the same transaction** — §4.1 explains that `'account'` as the default is the
     2026-08-28 outage wearing a new hat.
  2. `ADD CONSTRAINT ai_agent_tools_scope_matches_account CHECK ((scope = 'account') = (social_account_id IS NOT NULL))`.
  3. The composite FK `(social_account_id, user_id, platform) REFERENCES social_accounts (id, user_id, platform)`. Add the `> Note for whoever drops things later` comment from §4.1 — this is the **second** dependant on that unique index.
  4. Credential columns per §4.3.
  5. `CREATE UNIQUE INDEX … ON ai_agent_tools (user_id, social_account_id, name) NULLS NOT DISTINCT`. **Do not drop `ai_agent_tools_user_id_name_key`** — that is PR-7.
  6. `DROP CONSTRAINT` + `ADD CONSTRAINT` rebuilding the `connector_type` CHECK with all twelve types. It cannot be altered in place.
  7. `CREATE TABLE ai_agent_tool_accounts` exactly as §12.1, plus RLS `auth.uid() = user_id` and a `FOR ALL` policy matching `ai_knowledge_source_accounts`.
  8. `set_ai_agent_tool_accounts(p_user_id, p_tool_id, p_social_account_ids uuid[])` per §12.2 — `FOR UPDATE` on the tool row first, ownership verified for the tool and every account, whole link set replaced, **the collision refusal of §12.3 step 1**, `REVOKE ALL … FROM PUBLIC` then `GRANT EXECUTE … TO service_role`.
- [ ] **Step 2 — write the header comment** explaining ordering, following the style of
      `20260831120000_knowledge_queue_all_source_types.sql`: why the default is
      `all_accounts`, why nothing is dropped, why `NULLS NOT DISTINCT` is load-bearing.
- [ ] **Step 3 — rehearse against production**, statement by statement, with `ROLLBACK`.
      Verify `NULLS NOT DISTINCT` rejects a duplicate legacy row, and that the composite FK
      rejects an account on the wrong platform.
- [ ] **Step 4 — commit the file only. Do not apply it.**
- [ ] **Step 5 — STOP. Hand the migration to the owner and wait for confirmation.**

**PR-3 gate:** rehearsal output pasted into the PR body. No code in this PR.

---

# PR-4 — writes become account-scoped

**Spec:** §4.1, §4.3, §12.2, §14, §9.1 items 3 and 4. **Needs Migration A applied.**

### Task 4.1: `ai_upsert_tool` writes scope, account and Vault credentials

**Files:** Modify `supabase/functions/messaging-api/index.ts` (~line 667).

- [ ] **Step 1 — write the failing tests** in a new
      `supabase/functions/messaging-api/toolWrites.test.ts`:
  - an unknown `connector_type` returns **400 naming the type**, not a 200 with
    `custom_rest` (today's behaviour, evidenced in §1.6);
  - a save with no `social_account_id` is refused rather than writing an unscoped row;
  - a save names an account the caller does not own → 403;
  - the read-then-update-or-insert shape is used, **not** `onConflict: "user_id,name"`
    (§4.2: `ON CONFLICT` inference over a nullable column is refused outright).
- [ ] **Step 2 — run, confirm each fails** for its stated reason.
- [ ] **Step 3 — implement.** Credentials go to Vault per §4.3; the row stores the secret
      id, never the secret. `ai_delete_tool` deletes the Vault secret too — Vault has no
      delete function, so follow §4.3's stated approach.
- [ ] **Step 4 — run, confirm pass.**
- [ ] **Step 5 — commit.**

### Task 4.2: `set_tool_accounts` action

**Files:** Modify `messaging-api/index.ts`; create `messaging-api/toolSharing.ts` + test.

- [ ] **Step 1 — write the failing test** for the parse-and-refuse table, modelled on
      `ai-knowledge-ingest/sourceVisibility.ts`, which is the working precedent: input
      validation and ownership pre-checks in a testable module, the RPC as the authority.
- [ ] **Step 2 — run, confirm fail. Step 3 — implement. Step 4 — confirm pass.**
- [ ] **Step 5 — commit.**

### Task 4.3: the account dropdown and the sharing strip

**Files:** Modify `src/components/automation/DatabaseConnectorsManager.tsx`; create
`src/lib/accountSharing.ts` by generalising `src/lib/knowledgeSharing.ts`; tests for both.

- [ ] **Step 1 — write the failing tests:**
  - the configured-state map is keyed by **tool id, not `connector_type`** (§9.1 item 3);
    two WooCommerce connectors on one account must show two independent states;
  - the sharing strip sends the **complete** account list on every toggle — the same
    regression `AiKnowledgeManager.sharing.test.tsx` covers, and for the same reason;
  - the owning account's checkbox is rendered **checked and disabled** (§12.2).
- [ ] **Step 2 — run, confirm fail. Step 3 — implement.**
      Generalise, do not copy: `nextSharing` gains an `alwaysOnAccountId` parameter.
- [ ] **Step 4 — confirm pass; run `npx vitest run` whole-suite.**
- [ ] **Step 5 — commit.**

### Task 4.4: Settings becomes read-only

**Files:** Modify `src/pages/Settings.tsx` (~line 174) and
`DatabaseConnectorsManager.tsx`.

- [ ] **Step 1 — write the failing test:** rendering the Settings variant exposes **no**
      save, delete or add control, and lists connectors grouped by account.
- [ ] **Step 2 — run, confirm fail. Step 3 — implement** via an explicit `readOnly` prop —
      not by hiding buttons with CSS.
- [ ] **Step 4 — confirm pass. Step 5 — commit.**

**PR-4 gate:** all gates green; **deploy `messaging-api` before PR-7**.

---

# PR-5 — the agent resolves tools for the account

**Spec:** §12, §13.3, §9.1 item 1. **This is the PR that makes scoping real.**

### Task 5.1: the resolution predicate

**Files:** Create `supabase/functions/_shared/toolResolution.ts` + test.

- [ ] **Step 1 — write the failing tests:**
  - an `all_accounts` tool resolves for every account;
  - an `account` tool resolves only for its owner;
  - a linked tool resolves for the linked account;
  - **account A's connector does not resolve in account B's conversation** — the PR gate,
    stated as behaviour;
  - **the collision rule (§12.3):** given B's own `woocommerce_store` and A's shared
    `woocommerce_store`, exactly one is returned and it is B's.
- [ ] **Step 2 — run, confirm fail. Step 3 — implement. Step 4 — confirm pass.**
- [ ] **Step 5 — commit.**

### Task 5.2: wire it into `ai-agent-reply`

**Files:** Modify `supabase/functions/ai-agent-reply/index.ts` (~line 837) and `tools.ts`
(~line 330).

- [ ] **Step 1 — write the failing test:** the query is account-scoped, and
      `customToolDefinitions` output contains the usage guide.
- [ ] **Step 2 — run, confirm fail.**
- [ ] **Step 3 — implement.** Replace the `.eq("user_id", …)` load with the resolution
      predicate; select the Vault secret id and dual-read `secret` (rows migrate in PR-7);
      compose descriptions through `composeToolDescription`. Log a dropped duplicate to
      `ai_agent_logs` — `platform` there already allows `'threads'` (migration
      `20260822180000`), so no constraint work is needed.
- [ ] **Step 4 — confirm pass; run the whole Deno suite.**
- [ ] **Step 5 — commit.**

**PR-5 gate:** the cross-account test above. **Deploy `ai-agent-reply` after merge.**

---

# PR-6 — real adapters

**Spec:** §5.2, §5.3, §6, §11. **Needs the owner's WooCommerce and Supabase credentials.**

### Task 6.1: the adapter function skeleton

**Files:** Create `supabase/functions/ai-agent-adapters/index.ts` + tests.

- [ ] **Step 1 — write the failing tests** for §5.3's rules, which apply to **every**
      adapter: no credential ever appears in a response body, an error, or a log line;
      `read_only_mode` refuses any non-GET before the request is built, not after;
      every outbound URL passes the existing `assertPublicHttpsUrl` SSRF check on **every
      redirect hop**, reusing `ai-agent-reply/tools.ts:375` rather than a second copy.
- [ ] **Step 2 — run, confirm fail. Step 3 — implement the dispatcher.**
      §11 already resolved that adapters live in their own function.
- [ ] **Step 4 — confirm pass. Step 5 — commit.**

### Task 6.2: WooCommerce adapter

- [ ] **Step 1 — failing tests:** Basic auth from consumer key/secret (§6.1); a 401 from the
      store surfaces as a named error, never as an empty success; `read_only_mode` blocks
      order writes.
- [ ] **Steps 2-4 — fail, implement, pass.**
- [ ] **Step 5 — commit.**

### Task 6.3: Supabase adapter

- [ ] **Step 1 — failing tests:** anon key only (§6.1 — a service key here would defeat RLS
      for a connector the customer's message can steer); a PostgREST error body is not
      treated as data; the `/rpc/` and resource-embedding escapes named in §6.1 are refused.
- [ ] **Steps 2-4 — fail, implement, pass. Step 5 — commit.**

### Task 6.4: `test_connection`

- [ ] **Step 1 — failing test:** a successful probe returns capability facts and **no
      credential**; a failure returns the vendor's status and a safe message.
- [ ] **Steps 2-4. Step 5 — commit.**

**PR-6 gate:** a live read against the owner's real store, pasted into the PR body with
credentials redacted.

---

# PR-7 — Migration B, the contract (owner applies by hand)

**Spec:** §4.2, §9. **Forward-only.**

### Task 7.1

**Files:** Create `supabase/migrations/<timestamp>_connector_uniqueness_contract.sql`.

- [ ] **Step 1 — write it:** drop `ai_agent_tools_user_id_name_key`; migrate any remaining
      plaintext `secret` into Vault; leave the column in place for one release.
- [ ] **Step 2 — header comment states it is forward-only:** once two accounts share a
      connector name, `UNIQUE (user_id, name)` cannot be restored.
- [ ] **Step 3 — rehearse against production with `ROLLBACK`.**
- [ ] **Step 4 — update `docs/runbooks/` to say so. Step 5 — commit, do not apply.**
- [ ] **Step 6 — STOP. Hand to the owner.**

**PR-7 gate:** PR-4's code is already deployed and serving.

---

# PR-9 — OAuth connectors

**Spec:** §6.3, §15. **Needs Salla, Zid and Shopify app registrations from the owner.**

### Task 9.1: the OAuth flow

**Files:** Create `supabase/functions/connector-oauth/index.ts` + tests.

- [ ] **Step 1 — failing tests:** state parameter is single-use and bound to
      `(user_id, social_account_id)`; a callback for another user's state is refused; tokens
      land in Vault, never in a column.
- [ ] **Steps 2-4. Step 5 — commit.**

### Task 9.2: refresh, serialized per connector

- [ ] **Step 1 — failing test:** two concurrent refreshes of one connector produce **one**
      upstream call — §9's "per-connector serialization", the same defect class the
      durable reply outbox already solved with a lease.
- [ ] **Step 2 — run, confirm fail.** Simulate expiry; do not assume it.
- [ ] **Steps 3-4. Step 5 — commit.**

**PR-9 gate:** an expired token is refreshed and the connector keeps working, demonstrated.

---

## Self-review

- **Spec coverage.** §4 → PR-3/PR-4. §5 → PR-2/PR-6. §6 → PR-2 (schemas) and PR-6/PR-9
  (behaviour). §12 → PR-3 (table, RPC), PR-4 (UI), PR-5 (resolution, collision). §13 → PR-2
  (registry, composer) and PR-5 (wiring). §14 → PR-4.4. §15 → the three STOP points.
  §7 and §8 shipped in #73/#78 and have no tasks, by design.
- **Ordering.** Migration A precedes every PR that reads the new columns. PR-7 drops the old
  constraint only after PR-4's code stopped using it. PR-5 needs PR-2's composer.
- **Naming.** `connectorDefinition`, `composeToolDescription`, `nextSharing`,
  `set_ai_agent_tool_accounts` are used identically in every task that mentions them.

## Execution

Delegated to the OpenAI Codex CLI (`gpt-5.6-sol`, medium reasoning), **one brief per PR**,
sequentially. The orchestrator writes each brief, re-runs the gates itself, reviews the diff
against the spec, and commits. Codex does not commit and does not apply migrations.
