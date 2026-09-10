# Human agent CRUD implementation plan

Goal: implement spec section 7.7's five agent routes, leaving assignment routes for part 2.

Architecture: `_shared/humanAgentOps.ts` owns workspace-scoped operations and Auth compensation; `v1/agents.ts` owns entitlement, HTTP and shared idempotency. The browser remains unchanged.

Spec: `docs/superpowers/specs/2026-09-10-partner-api-sections-design.md`, sections 6 and 7.7.

- [x] Add `20260910160000_provision_partner_agent.sql`: Auth stays outside SQL; membership and agent insert are atomic; direct anon/authenticated grants are revoked. Replace assignment SET NULL with NO ACTION so deletion cannot race an assignment or detach retained references.
- [x] Add workspace-scoped use cases with explicit public projection, partial PATCH validation, and compensation only after a successful complete workspace read proves no agent owns the minted identity. Unknown recovery preserves identity and logs reconciliation metadata.
- [x] Register the five routes, scopes, string risk classes and human-agent entitlement policies. Claims precede Auth creation; replay returns stored body; unknown writes retain the attempt as indeterminate. Service email uses a stable UUID derived from key ID and Idempotency-Key, preventing duplicate identities after lease takeover.
- [x] Add migration and routed tests for tenancy, private identity, replay counts, recovery, PATCH payloads, failed reads, assignment refusal, entitlement logs and all claim outcomes.
- [x] Update OpenAPI and generated Postman/agent context; run the seven requested acceptance commands against the existing baseline, then guard review and graphify update.

No commits, browser changes, assignment routes, certified event changes, or baseline regeneration. Deploy migration before code; deployment requires the project's Contabo connector.

## Verification results

```text
deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/_shared/
ok | 1214 passed (126 steps) | 0 failed (21s)

deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/partner-api/
ok | 575 passed | 0 failed | 10 ignored (16s)

deno run --allow-read scripts/check-openapi-drift.ts
contract drift: no breaking changes against the baseline.

deno run --allow-read --allow-write scripts/generate-postman.ts
postman: wrote 67 requests in 15 folders to docs/api/postman/postora-partner-api.postman_collection.json + 3 environments

deno run --allow-read --allow-write scripts/generate-agent-context.ts
agent-context: wrote 64536 chars (24 pages) to docs/developer/AGENT-CONTEXT.md and llms.txt

deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-postman.test.ts
ok | 5 passed | 0 failed (198ms)

deno test --allow-env --allow-read --no-check --node-modules-dir=auto scripts/generate-agent-context.test.ts
ok | 7 passed | 0 failed (256ms)
```

New production modules pass `deno check --node-modules-dir=auto`; five new TypeScript files pass `deno lint`. `git diff --check` passes. Both guard skills were applied. `graphify update .` rebuilt the code graph; pre-existing graph output remains untracked.

The first drift run rejected changing the existing PrefixedId regex. The final implementation leaves it intact and adds HumanAgentId, with conformance coverage for both. Neither baseline nor accepted-breaking-changes was changed.

Docker's daemon is unavailable, so no live PostgreSQL migration rehearsal was performed. Migration and deployment remain pending; apply this migration before deploying the partner handler. No commit or production change was made.

## Operational behavior

- Before a claimed write, validation/entitlement/idempotency refusals mint no identity. A completed replay returns its stored body and calls createUser zero additional times.
- Auth creates an unconfirmed, passwordless svc+UUID@partner.postora.cloud identity with partner_service_account metadata. The SQL RPC inserts workspace_members with role agent and whatsapp_agents atomically.
- Auth failure without an identity ID skips SQL and logs the stable attempt reference; the request becomes indeterminate because a lost Auth response cannot prove non-creation.
- RPC failure or malformed response triggers recovery. A workspace-scoped, exact-count read proving no corresponding agent exists permits Auth deletion. Successful compensation returns internal_error, stored for replay.
- An existing agent, failed or incomplete recovery read (including a workspace exceeding the bounded 1000-row recovery read), failed cleanup, or thrown recovery error preserves the identity, logs reconciliation metadata and marks the attempt indeterminate. It never treats a failed read as empty.
- Response settlement failure preserves the created agent and identity and attempts to mark indeterminate with the claim token. Failure to persist that mark is logged; the stable service email prevents another identity on a subsequent takeover.
- The original whatsapp_conversation_assignments_agent_id_fkey used ON DELETE SET NULL. The new NO ACTION constraint conservatively blocks deletion for any retained assignment, active or ended, including concurrent or legacy NULL-workspace references. The response is documented 409 invalid_request. Assignment history's from/to FKs remain SET NULL. Successful profile deletion keeps Auth and membership, since existing browser agents may also be addressed.
- useFeatureFlags maps feature_human_agent to humanAgent; DashboardLayout conditionally includes Human Agent under its Ad Manager dropdown using flags.humanAgent. All five API actions enforce this feature independently through ACTION_FEATURE_KEYS before resource work, without a platform argument.
