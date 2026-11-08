# Threads carousel recovery after a worker timeout

The two reported Flexitol retries failed while waiting for six and seven carousel children, before the parent was published. The existing sequential child creation consumed the first-run waiting budget. The diagnostic matched the production source at `6b1fb6c890c89c115a2dfa1faa36434fd3ec066d` using file hashes and the two error stacks. No new publish was sent during diagnosis.

## Candidate behavior

- Create child containers concurrently, preserving media order and the existing policy for a provider-rejected child.
- Persist the complete child-ID list when preparation outlasts this worker; a later worker checks those same children.
- Before publishing a parent created during recovery, confirm its checkpoint write. An uncertain checkpoint returns 503 and leaves the pending row available for reconciliation.
- A timed-out publish preserves its container for a later status check. It is never retried inline. A container reported published is not sent again.
- Bound the publish and optional follow-ups by the remaining worker lifetime; follow-up failures do not fail the main post.

The JSON deferral adds `threads_carousel` and optional `carousel_children`; existing deferrals remain readable. No database schema migration is required. The existing service-only resume endpoint and cron remain the execution path.

## Validation

Local Deno 2.9.8 cached-only checks compile the actual process-post entrypoint. The selected 79 tests cover child IDs/order, checkpoint-before-publish, failed checkpoint refusal, lost publish response, existing Instagram behavior and the reconciler. These are synthetic executions, not live Threads publication proof. CI registers this selected suite explicitly.

The attempted whole-directory suite was blocked before execution by an existing std crypto `.d.mts` dependency. The analytics frozen-lock attempt also refused because this non-analytics graph is not in that lock. Neither dependency artifact was changed; these failures are not passes. Local selected tests use the explicit non-analytics `--no-lock` command, no network runtime permission, and retained cache only.

## Deployment and rollback

Deploy the complete reviewed process-post source set together. No provider call, migration, settings change or live retry is included in local validation. Before rollback to a reader without `threads_carousel`, drain or explicitly reconcile these new pending deferrals; an older reader cannot safely process them. Keep the previous source and pending-row evidence. Verify deployed hashes and exercise a separately authorized test carousel before declaring provider-level success.

Existing failed attempts have no saved child checkpoint. A user-requested retry of those attempts starts a new preparation; this change does not retroactively recover missing IDs.
