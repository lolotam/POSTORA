# Independent Instagram Story copies

Owner approved the proposed complete solution in chat on 2026-11-08. Tracking: https://github.com/lolotam/POSTORA/issues/399.

## Evidence and contract

A production video post created at 09:11:47 UTC produced a failed `ig_post_subtype=story` at 09:12:19 and a successful `ig_post_subtype=reel` at 09:14:13. Facebook and Threads succeeded. The Story readiness checks remained waiting until the first-run deadline. The edge container started at 08:42:13, before this publication. This does not establish a deployment-caused failure.

Publishing a Story copy is a separate media upload. It is not the native Instagram app action that shares a clickable Reel in a Story. No native resharing endpoint was established. Preserve this distinction in settings, status, and tests.

## Delivery slices

1. Correct the misleading existing UI independently of backend changes: name the separate Story upload, label Reel/Story result rows, and surface partial failure or pending work in cards, tables and details. Do not advertise Story-only retry until the server actually enforces it. Do not change stored post status or existing API contracts in this slice.
2. Add a durable Story outbox and claim-fenced worker. Do not reuse a Reel's provider container or generic account retry as Story-only retry. Add the narrow SQL lifecycle and prove it in the existing isolated harness before publication acceptance.
3. Wire the primary publication, both login routes, API/n8n configuration and explicit Story-only retry to the durable contract. Exercise composed paths and integrate controls only after the backend exists. Then normal CI/review, compatible deployment order and a separately authorized real pilot.

## Durable contract to implement in slice 2

The logical key is `(post_id, social_account_id, story)` with a monotonically increasing explicitly requested generation. The primary Reel success and Story outbox insertion must commit atomically; a provider success followed by an uncertain DB write must not start another publication. A generic worker's existing job kind registry and claim-token protocol can dispatch this work, but its current retry-after-exception assumption is insufficient after provider dispatch.

Required operations:

- Enqueue requires an owned Instagram account, an owned post, a confirmed primary Reel result, and a persisted explicit Story-copy opt-in for that exact post/account. Missing, false, malformed, or withdrawn opt-in is ineligible; Reel success alone never authorizes a Story. Bind the opt-in version to the work and recheck it before dispatch. A DB-enforced unique key prevents duplicate pending work. Repeated enqueue returns the existing work.
- Claims and checkpoints verify owner, logical key, active generation, claim token and unexpired lease. Time checks use acquisition time. Stale workers cannot write or dispatch after ownership changes.
- Validate an authoritative Business account capability for the actual login route. Unknown capability refuses publication. Validate Story media separately; a valid Reel alone is insufficient. Unknown duration/format/dimensions must not be treated as valid. Do not crop, trim or transcode silently. Unsupported or missing inputs produce an actionable result.
- Persist a creating phase before creating a provider container; persist its returned ID before publishing. Losing the creation response may leave an unpublished orphan container, but must not be represented as a published Story.
- Persist dispatch intent before `media_publish`. Every external request has a timeout bounded by remaining worker lifetime with time reserved for checkpointing. Lease expiry does not mean provider cancellation.
- Once dispatch is uncertain, preserve the container and reconcile its authoritative status. Never create a replacement container or use caption matching to guess a Story ID. A PUBLISHED container without a recoverable media ID must be shown honestly, with link/analytics limits; an unknown outcome requires attention and cannot expose a blind retry.
- Slow processing requeues the same container with a bounded give-up horizon; all continuation state is durable. Queue outages and exhausted claims reconcile the UI record as well as the generic job.
- A confirmed Story success is terminal and cannot be retried. An explicit retry of a definitely failed Story creates a new generation only after atomic failed-state validation; pending, published and uncertain attempts cannot be reset. It never calls the primary Reel publisher or other account publishers.
- Cancellation/deletion of the post or removal of account ownership refuses new provider dispatch. Historical successful publications remain visible.

No phase may depend on optional in-memory progress or trust user-provided ownership, account subtype or provider identity. No new tokens are stored in job payloads. Worker adapters resolve credentials from the owned account, and responses/logs exclude credentials and signed URLs.

## UI and compatibility

Preserve current DTOs and top-level post status. Additive subtype/state information distinguishes Reel success from Story pending/failed/uncertain. Historical failures of the same logical subtype must not override a later success. Missing subtype is displayed without inventing a subtype. Generic account retry remains available under its existing behavior until explicit Story-only routing is present.

Settings say “Publish a separate Story copy” with Arabic text and explain that tapping it does not open the original Reel. Completion messages must not say all items succeeded while a Story is pending or failed. API/MCP/n8n clients need the same subtype outcome, not just the website.

## Verification and release

First UI slice: regress the observed successful Reel + failed Story, pending Story, historical retry success, independent account failure, and unknown legacy subtype. Validate English fallbacks and Arabic translations.

Backend: SQL ownership/unique/generation/claim-expiry/concurrent-retry/rollback tests, plus bounded synthetic transport tests for both login routes, slow processing, timeout before/after dispatch, failed checkpoint, worker death, published-without-ID, cancellation and unsupported media. Test the actual composition path that queues the Story after a confirmed Reel, not only helper functions.

Rollout: apply separately approved migration before dependent worker code. Deploy compatible reader/worker code before enabling the new producer. Keep old workers from claiming the new kind. Record actual deployment hashes and health. No live publication or retry under source authoring. Do not close #399 after only the UI slice or unit tests.
