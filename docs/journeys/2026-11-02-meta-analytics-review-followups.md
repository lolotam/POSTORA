# Meta analytics review follow-ups

Combined source checkpoint: `5cf3b5bc5412a172f1b3d91d0bff2ba52b2be60e`. This record covers additional local review fixes. It does not accept full Instagram G-X, approve production operations or relabel earlier browser proofs.

## User-visible changes

The saved analytics hook now lives in `src/features/analytics-contract/ui/useSavedAnalytics.ts`; its sole production consumer remains `OwnedAnalyticsScreen`. The move preserves behavior and leaves application ports framework-neutral. Subsequent changes serialize Refresh and Load more through the existing query state and `cancelRefetch:false`, so pagination cannot cancel an in-progress refresh or reuse its obsolete cursor. Partial post measurements remain numeric when ranking loaded posts, with existing coverage labels. An unavailable post collection remains unavailable instead of becoming partial or displaying a verified empty-period message.

The daily-trend DTO explicitly excludes partial observations, so that contract was not widened to satisfy an overbroad review comment. The inclusive 24-hour follower boundary, provider calendars and metric definitions remain unchanged. UI source commits are `c5911a2788c0411428c2e4a68b4c524e764eb48d` and `2661dce9ff1c61a1ae07205ab6d3cbc55eecce1a`.

The [discovery follow-up](2026-11-02-instagram-discovery-contract.md#discovery-review-follow-up) owns the detailed Instagram changes and attribution: canonical handles, post-limit-aware caches, typed throttling without paid fallback, parser error mapping, safe count values, truthful bounded pagination and hook continuation. HTTP 429 response bodies are released within the original attempt deadline. These changes preserve protected authority and existing provider-call limits. Source commits are `3c59f38989fd5d90fca2f8ba0e93e080f6bba5db` and `076d323c52a51e701dc41f07a4954fa7d25aea5e`.

## Release-checker trust boundary

The independent main-based [tooling PR #349](https://github.com/lolotam/POSTORA/pull/349) now uses source `5b2fb9ca1a8d1941836b4a5f68582d9d9c8b02c7`; its checker/test bytes are identical to the combined checkpoint. A valid-looking arbitrary artifact is no longer an execution receipt: the JSON must match the claimed candidate/tree, command, test identity, result and counters. URI userinfo and Basic authorization headers are refused without printing their contents.

The proof distinguishes canonical Git blobs (LF) from the Windows execution files (CRLF). Both Git identities match across the commits, and the integrated working files exactly match the tested tooling checkout; normalized execution bytes equal their Git blobs. Both hashes are recorded instead of claiming a raw execution/Git hash equality that does not hold.

A reproduced complete fabricated ledger previously produced `releaseReady:true`. The checker now distinguishes content binding from origin verification. Self-authored execution/review/bootstrap/live claims cannot authorize release: `evidence_origin_unverified` remains a blocker until an approved external verifier exists. No signing key, reviewer identity or new approval was invented.

Workflow parsing is structural inventory only. Additional or PR-head execution is refused, and even the narrow matching recipe cannot prove real candidate fetch, dependency setup or publication of the dedicated App status. `migration_workflow_execution_unverified` keeps local/full release-ledger readiness blocked until that actual implementation is reviewed. No workflow was enabled, App configured, secret created or branch protection changed. Migration history and its four existing prefix incidents were not modified or exempted.

## Executed checks

- UI: three meaningful original-source failures, then **26 tests / two files** passed; scoped ESLint found zero diagnostics.
- Discovery at `3c59f389`: **20 Deno tests / 31 steps**, plus **13 hook tests**, passed. After the response-body cleanup correction at `076d323c`, the affected Deno file passed **13 tests / 32 steps**. Original failures and control cases remain in the detailed discovery record.
- Checker at `5b2fb9ca`: **97 tests passed**, zero failures/skips/cancellations; scoped ESLint and its graph update passed. The interrupted earlier full run is not counted as success.
- Combined frontend `npm run typecheck` and `npm run build` exited zero on application inputs at `076d323c`. Those application/compiler inputs are byte-identical at the combined checkpoint; only checker scripts and documentation followed.
- Immutable lint/i18n at the combined checkpoint against C3 `2b04837163f81cb4220c36e6d393d4ac27afd68a` passed **NO REGRESSIONS**; historical debt remains. The combined graph update and source/test/docs guard passes completed.

The [proof record](evidence/2026-11-02-meta-analytics-review-followups-proof.json) pins the source slices and local artifacts. No new migration or native SQL change was introduced by this review batch. The earlier canonical Auth/quota smoke remains attributed to `baba9e3b5b9a7814125dada5383e9c4ff38b3f74`, and the 13 owner browser journeys remain attributed to `a98d7fe34e29ff3cf47d2d62caa9dbb622f33f1a`; neither was rerun on the changed analytics screens.

## Production and outstanding acceptance

The actual canonical check at the combined source still refuses readiness: four historical migration-prefix collisions/reservations, five missing required sources and missing execution evidence remain. Full canonical journeys, actual protected workflow/verifier/bootstrap, Instagram metric/calendar adoption, selected-account credential bindings, required reviews, approved production prerequisites, Meta reconciliation and seven scheduled due dates are not complete. The [analytics deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) remains NO-GO.

The independent [MCP/n8n publishing PR #348](https://github.com/lolotam/POSTORA/pull/348) fixes mirror receipts, public collaborator warnings and numeric collaborator form input. It has its own frozen four-file deployment packet and read-only production prerequisite receipt on that branch. Its verification is separate from analytics collection; no runtime merge/deploy, live publication or node release was performed by this batch. Remaining old review threads are not collectively marked resolved or treated as complete independent review. `mem0` was unavailable; these records preserve the continuation.
