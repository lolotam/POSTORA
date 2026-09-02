# Partner API Certification — Phase 10 GA

> **Status: NOT PERFORMED.** This form records the plan's certification table
> honestly. Every row is a statement of what *would* be certified, not what has
> been.

Certification requires:

- **Staging environment** — plan §0.6, blocked on infrastructure: a throwaway
  Postora database restored from a production dump (the migrations alone cannot
  rebuild one; see `supabase/tests/README.md` and the db-harness §0.3 finding).
  That environment does not exist.
- **A real external client outside Postora's infrastructure** — plan §7 item 6:
  Danat has no WABA and no live credential; the one live `whatsapp:template.send`
  key is revoked and the pinned account is inactive. There is no counterparty to
  certify against.

What *is* in place is the chain test described below. It proves the
mechanical chain on real SQL, but it is **not** certification — it runs
against a throwaway harness database and stubs the provider.

---

## Certification table (per POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md Phase 10 — GA)

| Field | Value / What certification would check | Today's truth |
|---|---|---|
| **Owner** | Named owner who signs that the GA surface is fit to charge for. | *Unassigned — no staging, no external WABA, no charge decision.* |
| **Client** | An external integration outside Postora (real WABA, real app, real network hops, real Meta acceptance). | *None — Danat has no WABA (plan §7 item 6). The only counterparty is the stub in `chain.e2e.test.ts`.* |
| **Environment** | Staging, built by restoring a production dump, with environment-specific credential (`pk_test_` vs `pk_live_` already enforced by `partnerApiKeys.doorEnvironment` and the DB `partner_key_environment_for_prefix`). Production is not the first place a publish is ever tried. | *Not built — plan 0.6 blocked on §2.1 infrastructure finding. The harness database (`partner_api_harness`) is a throwaway that is dropped on every run, not a staging deployment.* |
| **Path** | The certified send path: `POST /v1/messages` → durable intent → Graph API → `message.accepted` → `message.delivered` via webhook → `GET /v1/messages/{id}`. | *Covered mechanically by `supabase/functions/partner-api/e2e/chain.e2e.test.ts` scenario 1 ("happy chain → accepted") on real SQL via PostgREST. That test is the chain, but stubbed and not on staging.* |
| **Failure cases** | The plan requires five failure classes to be demonstrated and retained as evidence (the four below plus quota): see next table. | *Each is a scenario in the same chain test — see mapping below. Evidence is the test's DB assertions and recorded webhook signatures, not a production log.* |
| **Evidence** | What a real run must retain: request ids, intent ids, wamids, occurrence ids, HMACs, counters, and the ledger rows that prove each case. | *Retained only by the chain test's assertions (no persistent evidence store). A real certification run must archive the rows named in the "Rows asserted" columns of the phase report and the `X-Postora-Signature` values.* |

### Failure cases → scenario mapping

| Required failure | Scenario in `chain.e2e.test.ts` | What it proves on real SQL |
|---|---|---|
| **Insufficient scope** (`403 insufficient_scope`, no reservation, no intent, `partner_api_usage.error_code = 'insufficient_scope'`) | **4 — "invalid scope → insufficient_scope"** — key minted without `messages:send` sends `type:"text"`; `403` insufficient_scope; no provider call; no intent row; counters unchanged; one usage row with `error_code = 'insufficient_scope'`. | Scope is per-type inside `POST /v1/messages`; the legacy allowlist is not widened. |
| **Cross-tenant media** (`404 resource_not_found`, never `403`, never a signed URL) | **5 — "cross-tenant → resource_not_found"** — key A sends `type:"image"` with `media_id` from workspace B; `404` resource_not_found; no `signPartnerMediaUrl` fetch; no intent; counters unchanged. | Media tenancy is workspace-scoped in the lookup (`loadPartnerMedia` puts the workspace in the `WHERE`), not a post-read check. |
| **Provider definite rejection** (`422` `retryable:false`, intent `failed`, no webhook) | **6 — "provider rejection → failed"** — stub returns Meta error `code 131026` (`invalid_recipient`) as `400` with error body; route answers `422` retryable false; intent row `failed`; counters `reserved=0,confirmed=0,indeterminate=0`; **zero** `partner_webhook_deliveries` rows. | A typed 4xx is proof of non-delivery; quota is released and no `message.accepted` is enqueued. |
| **Indeterminate** (`409 idempotency_indeterminate`, intent stays `intended`, quota `indeterminate=1`, retry is still `409` with no second provider call) | **7 — "indeterminate → indeterminate"** — stub throws network error; route answers `409 idempotency_indeterminate` retryable false; intent row stays `intended` (the `indeterminate` verdict lives on the idempotency row, per decision record §2); `usage_indeterminate=1`; retry with same key is again `409` with no second provider call. | The pre-call intent guards the duplicate: only a takeover writes `indeterminate` on the intent, and the idempotency row makes the retry non-resendable. |
| **Quota exhaustion, concurrency-safe** (`429 quota_exceeded`, exactly one request succeeds when `quota=5` and `4` already charged) | **9 — "quota exhaustion is concurrency-safe → one succeeds"** — with `monthly_quota=5` and `4` confirmed, three concurrent `POST /v1/messages` with distinct `Idempotency-Key`s: exactly one `200` and two `429 quota_exceeded`; final `usage_confirmed=5, usage_reserved=0`; provider stub called exactly once. | `reserve_partner_quota` is a single `UPDATE … RETURNING` under a row lock; concurrent requests serialize, and a refused reservation is released inside the same transaction. |

Two more scenarios exist in the same file but are not part of the five required failures:

- **2 — "replay → replayed"** — same key+body as scenario 1: `200` with `Idempotency-Replayed: true`, body equal except `request_id`, no second provider call, no new delivery.
- **3 — "duplicate key, different body → idempotency_conflict"** — same `Idempotency-Key` with a different hash: `409 idempotency_conflict`, no provider call.
- **8 — "webhook endpoint fails then recovers → retry"** — `message.accepted` delivery fails `500` (`attempts=1, next_attempt_at ≈ now+60s, status pending`), then after moving `next_attempt_at` to the past succeeds (`attempts=2, delivered`), proving the retry ladder (`RETRY_BACKOFF_SECONDS = [60,300,1800,7200,21600]`) and the `partner_webhook_deliveries` claim/lease.

## What a real certification run must do

1. **Build staging** per §0.6: restore a production dump (not replay migrations) into a staging DB and deploy the functions volume there. Verify `partner_e2e_fixture` does **not** exist in production (it must not be a migration).
2. **Provision a real WABA** (or WABA-equivalent) outside Postora — Danat has none — and a real partner app that holds a `pk_live_` key.
3. **Replay the chain** without stubbing `graph.facebook.com`: real Meta acceptance (`wamid`), real `message.accepted` fan-out via `partner_settle_dispatch_intent_sent`, real `message.delivered` via the status handler, real webhook delivery to a real URL, real `X-Postora-Signature` verification (`sha256=<hex>` over `<timestamp>.<body>`).
4. **Retain evidence**: for every scenario, dump the rows asserted (`partner_dispatch_intents`, `partner_api_idempotency`, `partner_api_keys` counters, `partner_api_usage`, `partner_webhook_deliveries`, `whatsapp_messages`) and the raw webhook bodies with their `X-Postora-Event`, `X-Postora-Event-Id`, `X-Postora-Timestamp`, `X-Postora-Signature`, and `request_id = X-Postora-Request-Id` correlator.
5. **Sign off**: the owner named above marks each row "observed on staging against a real WABA" — only then is the table certifying rather than describing.

## What IS in place today

- **Path**: `supabase/functions/partner-api/e2e/chain.e2e.test.ts` (9 scenarios, each a `Deno.test` ignored when `PARTNER_E2E_POSTGREST_URL` / `PARTNER_E2E_JWT_SECRET` are unset).
- **Fixture**: `supabase/tests/e2e/partner_e2e_fixture.sql` — installs `public.partner_e2e_fixture(...)` `SECURITY DEFINER` granted to `service_role`, idempotent under fixed UUIDs `e2e00000-0000-4000-8000-0000000000xx`. Header says it is not a migration and exists only in throwaway harness DBs.
- **Failure coverage**: the five required failures map to scenarios 4, 5, 6, 7, 9 as above.
- **Evidence**: the file's own assertions are the evidence; no external client or staging log exists to archive.

No wording in this document claims certification has occurred.
