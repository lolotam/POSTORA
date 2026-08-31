# Handover — Partner API v1, Phase 0 and Phase 1

**Written:** 2026-08-31 · **For:** whoever continues this programme
**Plan:** `docs/postora future feathers/POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md` — §0 is the
progress log and is kept current. **Read `ARCHITECTURE.md` before touching `src/**` or
`supabase/functions/**`.** Nothing auto-loads it.

This document exists because several things learned during this work are **not discoverable from
the repository**, and one of them invalidates a deliverable the plan has not started yet.

---

## 1. State

### Live in production

| Deliverable | What | Verified how |
|---|---|---|
| 1.1 | `partner_api_key_accounts`, both composite FKs, backfilled | `pg_constraint` on prod |
| 1.2 | `partner_audit_logs`, append-only by grant | `role_table_grants` on prod |
| 1.4 | Limiter risk classes A/B/C, fail-closed for B and C | deployed volume hashed against repo |
| 1.5 | `X-RateLimit-*` per response class, values from `consume_partner_rate_v2` | same |
| 0.1/0.2 | **`send_template` is SUSPENDED** — typed `temporarily_unavailable` | deployed volume |
| — | Least-privilege grants on the four foundation tables | `anon` holds **zero** grants anywhere |
| — | **`pk_live_urCb` is REVOKED.** There are zero active partner keys | `partner_api_keys` |

### Merged, CI-gated

| Deliverable | What |
|---|---|
| 0.3 | `scripts/db-harness.sh` + `supabase/tests/baseline_schema.sql` + the `db-harness` CI job |
| 0.4 | Deno tests in CI (pre-existing, PR #67) |
| 0.9/0.10/0.11 | Threat review, CORS decision, D8 regression detector |
| 0.12 | Danat credential inventory |

### Not started

- **Phase 0:** 0.5, 0.7, 0.8 (contract — *was in progress, see §4*), **0.6 (blocked — see §2)**
- **Phase 1:** 1.3 credential lifecycle, 1.6 legacy scope pinning; 1.7 partial (only the two tables
  that exist)
- **Phases 2–10:** untouched

---

## 2. Things that are true and not in the repo

**These are the reason this file exists.** Each cost real investigation.

### 2.1 The migrations cannot rebuild the database — 0.6 is blocked

Replaying all 253 migrations onto a blank Postgres applies **113 and then fails on 12**. Not
environment problems:

- `20260323202049` inserts `ai_models` rows with a **hardcoded `provider_id`**
  (`44bee76d-…`). `ai_providers.id` defaults to `gen_random_uuid()` and **no migration ever creates
  a "Z AI" provider** — that row was made by hand in production. It can only ever succeed against
  the one database where that UUID happened to be generated. Its same-day sibling
  `20260323201022` does it correctly, by looking the provider up by `provider_code`.
- Three migrations insert seed rows referencing production users and posts no migration creates;
  one calls a function no migration defines; six fail on relations/columns never created.

**Consequence:** a staging environment (0.6) must be built by **restoring a schema dump**, not by
replaying migrations. Disaster recovery depends on a backup, not on version control. Migrations are
immutable, so this cannot be fixed by editing history.

### 2.2 There is no migration ledger

No `supabase_migrations.schema_migrations` — only Supabase's own service tables for auth, storage
and realtime. **Nothing records which of the 253 migrations production has applied.** They are
applied by hand.

This is why `scripts/regenerate-baseline.sh` refuses to run without
`I_CONFIRM_ALL_MIGRATIONS_APPLIED=yes`: the marker it writes cannot be verified by any query, so
the assertion is demanded from a human instead of assumed.

### 2.3 Danat is the user's own other project, and it is switched off

Two separate relationships, easily confused:

- The **partner API key** `pk_live_urCb` ("Danat Backend") — now revoked. It was pinned to
  **Xsellpoint's** WABA (`+965 9795 0350`, `is_active=false`), not Danat's: a test-era binding.
- **`danatfuture@gmail.com`** is an ordinary Postora *user* with FB/IG/Threads and a WhatsApp
  account on **`evolution_qr`**, driving the n8n node. Nothing to do with the partner API.

Danat's client code **is deployed** (`src/lib/providers/postora.ts` on the Danat host, reached with
`ssh-danatfuture-mcp` — a *different server* from Postora's Contabo box) but
`provider_configs.postora.is_enabled = false` and `POSTORA_WHATSAPP_API_KEY` is unset.

**Blocker for Danat go-live:** the key cannot simply be re-pinned to Danat's WhatsApp account,
which is `evolution_qr`. The partner API is a Cloud-API template door needing `phone_number_id` and
an access token. Danat needs a real WABA first.

### 2.4 `partner_audit_logs` has zero writers

Built in #70 with append-only grants, a tenancy trigger, and 32 assertions proving nothing can be
written across workspaces — and **nothing writes to it at all**. `create-partner-key.ts` writes no
audit row and does not set `created_by`; `revoke_partner_key()` appends no revocation event.

The credential lifecycle is currently unauditable. Recorded as **F11** in the threat review, gating
the first usable key. **1.3 must fix this.**

### 2.5 The "exhaustive" error-code table has drifted three times

`docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md` declares its code table
exhaustive. `limiter_unavailable`, `temporarily_unavailable` and `method_not_allowed` all shipped
without being added — the last had been emitted since the function was written.

A document asserting its own completeness discourages the checking that would reveal it is wrong.
**0.5's contract tests exist to make this mechanical.**

---

## 3. How to work in this repo

### Gate order is load-bearing

```bash
# 1. Deno FIRST — --node-modules-dir=auto rewrites node_modules and breaks vitest after it
deno test --allow-env --allow-net --allow-read --allow-write --no-check \
  --node-modules-dir=auto supabase/functions/
# 2. restore node_modules
bun install --frozen-lockfile
# 3. typecheck — `tsc --noEmit` alone is a NO-OP on the root config; -b is required
npx tsc -b --noEmit
# 4. vitest
bun run test
```

`bun run lint` fails with ~1080 pre-existing errors and is `continue-on-error` in CI. It is not a
gate; do not try to make it green.

### Deploying edge functions

Historically manual over SSH (`docs/runbooks/deploy-edge-function.md`): copy into
`/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify hashes,
then **`docker restart`** the functions container — *not* `docker compose up -d`, which has
silently served old code here.

**As of 2026-08-31 another agent is building `.github/workflows/deploy-edge-functions.yml`.**
Check whether it is live before deploying by hand; the two paths must not fight.

`npx supabase functions deploy` targets Supabase Cloud and **fails** against this self-hosted stack.

### Rehearsing a migration

There is no local database (`supabase start` is broken). Rehearse on the Contabo box:

```bash
ssh root@86.48.2.205   # direct ssh works; the MCP has a ~1000-char cap and times out
# dump prod schema → restore into a throwaway DB → apply → run supabase/tests/*.sql
```

**Every Postora migration self-commits**, so an outer `BEGIN`/`ROLLBACK` does not rehearse it — it
applies it for real. Use a genuinely throwaway database.

### The review chain that actually found things

Local gates were green before *every* defect listed below was found. They are necessary and not
sufficient.

1. Delegate implementation (`opencode-delegate` skill) — **or do it directly**
2. Re-run the gates yourself; never trust the implementer's report
3. **Mutation-test anything claiming to be a gate** — break it on purpose, confirm it fails
4. `codex exec` adversarial review, repeat until it approves
5. PR → CI → CodeRabbit + Codex bot inline findings → merge

### Delegation gotchas

- `zai-coding-plan/glm-5.3` has a **5-hour rolling usage limit**; `opencode-go` needs credits.
  Both were exhausted on 2026-08-31. Other providers are metered — ask before spending.
- Pass the brief via `--brief file`, not a shell argument. `codex exec "$(cat file)"` needs
  `< /dev/null` or it reads an empty prompt from stdin and exits silently.
- **Editing shell scripts through Python string literals produced four separate defects** —
  `\1` becomes a control byte, and a non-matching `.replace()` fails silently. Use `awk` splices
  with explicit assertions.

---

## 4. Next steps, in order

### 4.1 Contract batch — 0.7 + 0.8 + 0.5 (was in progress)

Ship together; none is testable alone. A brief exists at
`.../scratchpad/brief-contract.txt` in the session that wrote this, but the substance is:

- **0.7** OpenAPI 3.1 skeleton — servers, security schemes, scopes, error component, pagination,
  rate-limit headers. **No endpoints** (`/v1` does not exist).
- **0.8** Drift gate — committed baseline, semantic breaking-change rules (field removal, type
  narrowing, enum removal, required-field addition). **Bumping `info.version` must not satisfy it.**
  Prove with six mutations, including that last one.
- **0.5** Runtime contract tests asserting the document describes real behaviour.

**Ground truth already established** — 23 codes the code can emit, verified against source:

```
account_needs_reauth  account_not_connected  idempotency_conflict
idempotency_in_progress  idempotency_indeterminate  insufficient_scope
internal_error  invalid_key  invalid_request  key_expired  key_revoked
limiter_unavailable  method_not_allowed  missing_idempotency_key
quota_exceeded  rate_limited  temporarily_unavailable  unknown_action
```
plus `invalid_recipient`, `meta_error`, `outside_session_window`, `template_not_approved` and
`unsupported_direct_qr` from `_shared/whatsappPartnerOps.ts` (behind the suspended send path).

`unsupported_direct_qr` was the **fourth** undocumented drift (§2.5) — missing from the
"exhaustive" table *and* from this file's own first draft. It is emitted when a partner key is
pinned to an `evolution_qr` account and a template send is attempted
(`_shared/whatsappPartnerOps.ts:221`). The authoritative list now lives in
`docs/api/openapi.yaml` under `components.schemas.V1ErrorCode`.

**The alias and `/v1` have different error envelopes on purpose (D2).** Do not unify them.

### 4.2 — 1.6 legacy scope pinning

**Simpler than the plan says.** D3's step 2 was "reissue the Danat key with generic scopes" — that
key is now revoked and **there are zero active keys**, so the migration step has no subject. Legacy
scope strings can be rejected outright rather than pinned-then-deprecated.

The trap D3 exists to prevent: `whatsapp:webhooks.manage` authorises **nothing** today. Mapping it
to `webhooks:manage` when the webhook API arrives would turn zero capability into full webhook CRUD
plus an SSRF-capable outbound test.

### 4.3 — 1.3 credential lifecycle

Largest remaining. Needs **its own migration first**: `partner_api_keys` has no rotation fields
(`successor key id`, overlap expiry) and spec §8 requires them.

Must also close, per the threat review:
- **F11** — write audit rows on create/rotate/revoke, and set `created_by`
- **F3 residual** — atomic key+binding creation via a `SECURITY DEFINER` RPC. Today the two inserts
  are separate and the script *cannot clean up after itself*: least-privilege leaves `service_role`
  no `UPDATE` on `partner_api_keys`, and `revoke_partner_key()` is `auth.uid()`-scoped.

### 4.4 — 0.6 staging (needs a human decision)

Infrastructure provisioning on Contabo, and **it must be a schema restore** (§2.1). Not a coding
task; costs real resources.

---

## 5. Open decisions for the owner

1. **0.6 staging** — provision it, and accept it is built from a dump rather than migrations?
2. **Audit retention across tenant deletion** — `partner_audit_logs.workspace_id` cascades, and
   referential actions run outside RLS and grants, so a workspace owner erases their own credential
   trail without holding `DELETE`. `CASCADE` was chosen because `RESTRICT` blocks tenant deletion
   and conflicts with erasure obligations. If compliance needs retention, that is
   soft-delete-plus-archive and is far cheaper to decide **before the table has rows**.
3. **`partner_api_usage` grants** — reduced for the four foundation tables, but
   `partner_api_key_accounts` (added in #70) still has full `service_role` CRUD including
   `TRUNCATE`. Tighten when 1.3 defines what actually writes it.

---

## 6. What this programme has cost, and why

Phase 0 and most of Phase 1 took **5 PRs and ~30 defects found in review**. The harness alone went
through **8 adversarial rounds and 18 blocking defects**.

Every one of those 18 was a variant of the same mistake: **accepting evidence that something
started as evidence that it finished.** A passing assertion. A connection succeeding. A container
answering. A migration applying. A phrase appearing somewhere in the output.

The clean run looked correct from round one. That is exactly why it needed eight.

If you are tempted to shorten the review chain: the local gates were green before every single one
of those defects was found.
