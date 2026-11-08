# Independent Instagram Story worker implementation

The owner-approved contract is [the Story specification](../specs/2026-11-08-instagram-story-jobs.md). Execute inline in the existing worktree. No production migration, provider publication, or automatic retry of historical posts is authorized by source work.

**Goal:** A confirmed Reel can enqueue one separate, consent-bound Story. Story retries cannot publish the Reel again.

**Architecture:** Store the canonical phase independently of generic job payloads. Prepare the exact post/account intent before primary publishing; a database trigger on confirmed Reel settlement atomically creates the Story result and background job. The worker reloads canonical state and checkpoints dispatch with an unexpired claim. Unknown dispatch is reconciled, never resent.

## Source and verification sequence

- [ ] Add `20261108160000_instagram_story_jobs.sql`: owned intent, immutable consent fingerprint, atomic Reel/result/job transition, canonical reads, claim-fenced phase transitions, settlement, terminal-job reconciliation, and explicit failed-only retry.
- [ ] Add `supabase/tests/instagram_story_jobs.sql` and register it in `scripts/db-harness.sh`. Verify cross-owner refusal, consent revocation, duplicate settlement, generation and stale/expired claim refusal, unknown-dispatch refusal, retry isolation, and rollback. Use the normal disposable CI harness; do not reuse retained fixtures.
- [ ] Complete `background-jobs-worker/handlers/instagramStory.ts` with normalized canonical inputs, bounded steps, and no blind resend; add synthetic tests for provider delays, failed persistence, lost replies and revocation.
- [ ] Add `instagramStoryDeps.ts`: owned credentials/media reads, authoritative login capability and Business-account probe, strict known media metadata, bounded JSON transport, and SQL adapters. Wire the actual handler registry.
- [ ] Add `process-post/independentStory.ts`: prepare persisted intent and remove only the inline Story copy from the local publisher input. Wire both login paths at the shared Instagram dispatch point. Keep standalone Story publishing unchanged.
- [ ] Add explicit Story result retry to `enqueue-post-publish` and `n8n-api/posts/retry`, and route the History row action using its exact result ID. Preserve generic retry contracts.
- [ ] Run cached Deno checks/tests, focused frontend tests/typecheck, SQL harness through normal CI, and production/test guards. Publish only scoped source, with unknown deployment state explicit.

## Release boundary

Apply the reviewed migration before dependent readers/workers, deploy the worker before the producer, verify exact server hashes, then separately authorize a real Reel/Story pilot. Do not call local tests proof of live delivery. Missing media or capability evidence is an explicit refusal rather than inferred eligibility. Issue #399 stays open until composed execution and release evidence exist.

## Implementation receipt and remaining gates

The source candidate now connects the preparation RPC, atomic settlement trigger, generic worker registry, owner-scoped provider adapter, exact-result retry API/MCP argument and History action. Standalone Stories and image/feed mirrors retain the existing path. This change does not reconstruct historical failed Story jobs.

The initial composed test failed because its fake persistence boundary did not implement the new preparation RPC. The updated boundary and assertions now require a pending Story result and zero inline Story publishes for Reels, on both login routes; existing standalone/image/carousel behavior remains covered. That is synthetic composed evidence, not database execution.

Local results: 149 initial Deno tests passed; after the additional deadline/canonical-state regressions, the focused worker/enqueue/producer batch passed 46 tests. The registered warm-request regression passed separately. The registered publisher test passed eight steps, and the two focused frontend files passed 13 tests. Deno checked the actual worker, process-post, enqueue, n8n and MCP entrypoints. Typecheck and lint receipts must be attributed to the actual completed commands, not inferred from this document.

`supabase/tests/instagram_story_jobs.sql` is registered in the existing disposable harness. It has not been executed locally. Its source assertions cover ownership, idempotent preparation/primary settlement, expired/wrong claims, null generation/container/phase, consent revocation, capability refusal, uncertain outcome, retry generation isolation, and recovery of checkpointed success. A simultaneous multi-connection race has not been executed by the local test suite.

Supported media is deliberately bounded: stored positive dimensions and size, near-9:16 layout, JPEG up to 8 MiB, or MP4/MOV up to 100 MiB with a known 3–60 second duration. Meta container processing remains authoritative for actual encoding acceptance. Missing Openinary dimensions/duration remains a visible refusal; this PR does not add media inspection, transcode, or bypass an unavailable asset. The account must have authoritative stored publishing scope and a live Business-account response. Tests use synthetic values only.

**Merge/deployment hold:** main may automatically copy Edge Function source without applying SQL. Do not merge this candidate merely because CI passes. First obtain the independently reviewed migration/deployment sequence. Install the migration, distribute the compatible worker and its registry to all serving instances, then distribute the producer. No production schema, deployment, settings, provider request, or historical retry has been performed during this source work.

First CI on `3c3091de` applied all 168 migrations, then the Story suite stopped on `POST_QUOTA_DAILY_EXCEEDED` while creating its third synthetic post. Both owner-journey preparations failed at the same suite, before browser/contract execution. The fixture now explicitly receives a three-post daily quota through the existing quota override; the owner stays non-admin, all Story assertions remain, and production quota/schema logic is unchanged. This is not a passing SQL receipt; the next head must execute the complete suite.

Review follow-up: generic retry excludes managed Story accounts and retains their referenced results, so another platform's failure can still be retried. The n8n generic selector reports the independent Story route rather than selecting it. An explicit failed-Story retry validates the current publishing capability and captures its credential generation; an existing attempt never silently adopts refreshed credentials. SQL regression cases cover both boundaries; execution remains a final-head CI gate.
