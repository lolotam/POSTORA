# Conversation assignment verification

Implemented spec section 7.7 part 2 locally, without committing or changing the OpenAPI baseline.

## Behavior and limits

- GET, PUT and DELETE assignment plus GET assignment-history reuse the parent conversation resolver and agent idempotency wrapper. Each action has its own entitlement, scope and literal risk class.
- PUT locks the cache row, validates binding/workspace and agent workspace, closes the previous assignment, opens a new assignment and writes history in one SQL transaction. An insert/history failure rolls all of this back. Every changed assignment has a workspace and cache reference. The existing unique index arbitrates races with other writers and is unchanged. Null-workspace legacy rows remain outside its uniqueness guarantee and outside partner reads/writes.
- DELETE retains the assignment and stamps unassigned_at. No active assignment returns resource_not_found without assignment/history writes; usage and idempotency bookkeeping still occur.
- History filters workspace plus private conversation key and pages by descending created_at and id, excludes null created_at, fetches limit + 1 and uses one keyset disjunction. Public responses whitelist fields and never project the private key or user identity.
- The trigger emits only active INSERT and null-to-non-null unassigned_at UPDATE. Occurrence IDs are event type + assignment UUID + the applicable transition instant, rendered in UTC with six fractional digits. A reassignment therefore creates a close occurrence for the old assignment and an assign occurrence for the new UUID.
- Null workspace_id or conversation_cache_id emits nothing. A null transition timestamp or missing attributable WhatsApp cache row also emits nothing. A safely resolved /v1 close fills the cache reference before firing the trigger.
- Payload conversation references are conv_ + cache UUID, under the `conversation` field; agents are agent_ + UUID. The text conversation_id is absent. Notes remain available in route responses and history but are not propagated into event payloads.
- No catchable SQL exception escapes the emission body: OTHERS plus explicit query_canceled and assert_failure return NEW. Errors roll back the trigger's attempted fanout, log only SQLSTATE through PostgreSQL's logger, and preserve the writer. Backend termination or a database crash is outside what a PL/pgSQL trigger can guarantee. The migration's guarded CHECK block intentionally raises if its prerequisite constraint is missing; that is separate from the runtime trigger.

## Acceptance commands and final output

```text
deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/_shared/
ok | 1219 passed (126 steps) | 0 failed (21s)

deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/partner-api/
ok | 616 passed | 0 failed | 10 ignored (15s)

deno run --allow-read scripts/check-openapi-drift.ts
contract drift: no breaking changes against the baseline.

deno run --allow-read --allow-write scripts/generate-postman.ts
postman: wrote 71 requests in 15 folders to docs/api/postman/postora-partner-api.postman_collection.json + 3 environments

deno run --allow-read --allow-write scripts/generate-agent-context.ts
agent-context: wrote 64996 chars (24 pages) to docs/developer/AGENT-CONTEXT.md and llms.txt

deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
ok | 5 passed | 0 failed (157ms)

deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
ok | 7 passed | 0 failed (202ms)
```

The 10 ignored API tests use the existing integration-test guard. They are not newly skipped tests.

## Additional checks

```text
node scripts/test-partner-assignment-sql.mjs C:/Users/HP/AppData/Local/npm-cache/_npx/ba4f1959e38407b5/node_modules/@electric-sql/pglite/dist/index.js
assignment SQL rehearsal: 38 assertions passed; migration re-run, ACLs, transitions, legacy nulls, atomic rollback, and emitter failures verified

deno lint supabase/functions/partner-api/v1/conversationAssignments.ts supabase/functions/partner-api/v1/agents.ts supabase/functions/partner-api/v1/conversationAssignments.test.ts supabase/functions/_shared/partnerAssignmentMigration.test.ts supabase/functions/_shared/humanAgentTestSupport.ts supabase/functions/_shared/partnerEntitlement.ts supabase/functions/_shared/partnerWebhookEvents.ts supabase/functions/_shared/partnerWebhookEvents.test.ts supabase/functions/partner-api/router.ts supabase/functions/partner-api/v1/router.ts
Checked 10 files

git diff --check
No whitespace errors.

git diff --exit-code -- docs/api/openapi.baseline.yaml
Exit 0; unchanged.

graphify update .
graph.json and GRAPH_REPORT.md updated in graphify-out.
```

SQL rehearsal uses cached PGlite 0.3.15 with a minimal production-shaped prerequisite schema and the actual connection/assignment migrations. It exercises PostgreSQL transactions and trigger execution, including an authenticated-role writer and injected P0001, 57014 and P0004 failures. It does not replace a production-version full-schema migration rehearsal or a concurrent multi-session load test. Docker was unavailable locally.

Clean-code-guard and test-guard passes completed. Existing certification tests were advanced to the new migration and retain assertions that unproduced events are absent. The route fixture uses the real Supabase client with an HTTP boundary stub; the SQL rehearsal independently checks the persistence behavior.

## Changed files

- Migration: `supabase/migrations/20260910170000_partner_assignment_events.sql`.
- Routes and operations: `supabase/functions/partner-api/v1/conversationAssignments.ts`, `agents.ts`, `router.ts`; policy: `supabase/functions/partner-api/router.ts` and `_shared/partnerEntitlement.ts`.
- Certification: `_shared/partnerWebhookEvents.ts`; maintained RPC types: `src/integrations/supabase/types.ts`.
- Tests: `v1/conversationAssignments.test.ts`, `_shared/partnerAssignmentMigration.test.ts`, `_shared/partnerWebhookEvents.test.ts`, `_shared/humanAgentTestSupport.ts`, and `scripts/test-partner-assignment-sql.mjs`.
- Contract and generated artifacts: `docs/api/openapi.yaml`, `docs/api/postman/postora-partner-api.postman_collection.json`, `docs/developer/AGENT-CONTEXT.md`.
- This verification report, the adjacent implementation plan, and the existing untracked graphify output.

## Deployment status

No production changes were made. The read-only prerequisite inventory through ssh-contabo-mcp returned: `MCP tool call requires approval, but approval policy is never`. Deployment could not proceed. Apply prerequisite migrations and `20260910170000` before copying the changed partner-api/shared files to the self-hosted functions volume; verify hashes and reload according to the deployment runbook. Live verification remains pending. mem0 tools were unavailable, so no mem0 recall/save was possible.
