# Meta saved analytics deployment package — review candidate, NO-GO

This package prepares the owner's requested combined release. It does not authorize execution. The [implementation/evidence record](../journeys/2026-11-01-meta-saved-analytics.md) distinguishes shipped production behavior from tested local behavior. The source candidate is `a4294b9a5465a45c3c2969f4e35084b116969123`; the [artifact manifest](../journeys/evidence/2026-11-01-meta-saved-analytics-candidate.json) pins its migration, backend and frontend bytes against the last verified production source lineage `cc2555b282c1581dde196fd386b3b6d55a0f64ca`. Later test/documentation-only commits do not change deployed source. Any runtime/schema/frontend source change requires a new manifest and affected proofs. Recheck the live catalog before applying any proposed file; a later Git merge does not establish database installation.

## Decision boundary

Later discovery/tooling checkpoint `5ada6702f9d17251aa350d1a00bc989f204ec430` is recorded in the [discovery continuation](../journeys/2026-11-02-instagram-discovery-contract.md). Those changed discovery/frontend/shared-Graph bytes are outside this package's older frozen manifest. Refreeze the combined final candidate and affected proofs before execution; the older manifest cannot be used to deploy the later branch head. The canonical checker also reports four historical duplicate migration prefixes that require provenance reconciliation before its workflow activation.

The [weekly inventory correction](../journeys/2026-11-02-competitor-weekly-inventory-correction.md) adds another explicit prerequisite: `supabase/migrations/20261102090000_competitor_weekly_inventory_projection.sql`, including its index and authenticated-only `read_own_competitor_tracking_report_v2(jsonb)` RPC. Its dependent report runtime files are `assemble.ts`, `contracts.ts`, `reportStore.ts` and `weeklyInventory.ts` under `supabase/functions/competitor-tracking-report/`. These runtime/schema bytes are identical in canonical execution source `6d109d4ca35d3fb024a16b99e47f24a92f814b1f` and later test source `cffff00423117a6c2787fad5e4bc177a4e9310de`. The public DTO remains version 1. Neither the new SQL/index nor these runtime bytes is authorized by the older manifest. Include them when refreezing the complete candidate; independently approve/install the SQL before dependent runtime, verify owner grants and PostgREST cache, and prove failed reads cannot become empty reports.

**NO-GO for the requested complete three-platform release.** Do not ask the owner to approve an enablement that cannot produce verified data. The selected Facebook and Instagram accounts lack protected credential bindings; Instagram also lacks accepted canonical metric/calendar evidence. Keep the owner's complete [G-X decision](../specs/2026-10-30-instagram-release-gates.md). An owner-only artifact inventory does not replace it.

The selected read-only aliases remain `FB-01`, `IG-01`, `TH-01` from [design §12](../specs/2026-11-01-meta-analytics-completion-design.md). Reconnection must preserve those targets and their owner; do not substitute another account or derive a binding from an unverified legacy token. Target selection was not permission to admit collection or start schedules.

Before a complete release approval card can be presented:

1. Complete the supported OAuth/protected-binding flow for the selected Facebook and Instagram accounts; verify the exact owner/account/authority without exposing tokens. The owner performs any interactive Meta consent. No live revocation or destructive negative test is part of this package.
2. Finish the accepted Instagram capability/calendar/provenance work and canonical screen adoption. Do not invent a timezone, claim missing metrics are zero or enable the legacy credential as a fallback.
3. Finish the outstanding local/assembled/hosted proofs and independent reviews listed in the implementation record, including full applicable G-X. Freeze the resulting final candidate and regenerate this manifest. Current source may be reviewed, but it is not certified as the complete release.
4. Fill an exact pilot authorization record for each approved target and schedule manifest. Record owner approval reference, private account ID, provider calendar, candidate, seven expected due dates, reconciliation reference, rollback/restoration operations and operator. Public aliases alone must never be executed as database IDs.

The local owner-browser gap has progressed: all 13 Instagram/Facebook/Threads journeys passed on execution candidate `a98d7fe34e29ff3cf47d2d62caa9dbb622f33f1a`, with unchanged production bytes from the runtime candidate above. The [supplemental proof](../journeys/evidence/2026-11-02-meta-owned-browser-proof.json) records real local Auth/SQL/worker use, synthetic Meta transport and the remaining coverage limits. This does not close canonical G-X, live-provider or schedule acceptance and does not change this package's NO-GO decision.

The [historical competitor journey](../journeys/2026-11-02-instagram-historical-growth.md) supplies local assembled E2 evidence with eight successful canonical journeys at `d1ff8c8f75c026bc5a9d2b0e341c02118f650155`. That batch changes fixture/browser tests only; it adds no deployment artifact and no live elapsed-history or provider acceptance. Outlier J7 and the remaining canonical/release prerequisites are still open.

## Ordered schema artifacts

These eleven files are absent from the last verified production lineage and are proposed in this exact order. The first ten are in the older artifact manifest; the eleventh is the separately attributed weekly correction above and must enter the refrozen final manifest. Application is a separate approval from PR review/merge. `20261101023000_instagram_collection_http_fences.sql` was separately approved/applied earlier and must not be reapplied as if new.

1. `20261101130000_meta_owned_analytics_history.sql`
2. `20261101140000_meta_owned_analytics_worker_admission.sql`
3. `20261101141000_meta_owned_analytics_worker_progress.sql`
4. `20261101141500_meta_owned_analytics_inventory.sql`
5. `20261101142000_meta_owned_analytics_throttles.sql`
6. `20261101142100_meta_owned_analytics_worker_fairness.sql`
7. `20261101142500_meta_owned_analytics_retention.sql`
8. `20261101143000_meta_owned_analytics_cron.sql`
9. `20261101144500_meta_owned_analytics_capture_failures.sql`
10. `20261101150000_meta_owned_analytics_reports.sql`
11. `20261102090000_competitor_weekly_inventory_projection.sql`

Paths are under `supabase/migrations/`; the older manifest pins the first ten hashes and the weekly proof pins the eleventh. No current manifest certifies their combined deployment closure. Do not run a blanket migration push, replay an applied file, alter applied bytes or infer installation from a Git merge. Check the live catalog and approved predecessor definitions first; stop on drift. Apply schema before dependent runtime. Verify structural ownership constraints, native/wrapper grants, service-only writers, authenticated reader scope, generated-type signatures and PostgREST cache after application. Read back collection/retention settings and exactly six inactive schedule definitions; preserve unrelated settings/jobs.

## Runtime and frontend artifact scope

Follow [the self-hosted deployment runbook](deploy-edge-function.md), using the reviewed immutable candidate and manifest SHA256 values. A main merge can trigger the existing edge reconciler and frontend deployment; do not merge dependent runtime ahead of approved SQL or G-X prerequisites.

The stack includes `meta-owned-analytics-sync`, new `meta-owned-analytics-report`, coherent `instagram-insights-report`, the explicit canonical branches in `n8n-api/serviceProxy.ts`, Instagram provider transport and the changed shared analytics/abort/usage modules. The manifest, rather than a guessed folder list, pins the backend source delta. Deploy the full dependency closure from the approved Git tree. Verify volume hashes and restart `functions` from the documented stack; account for the runbook's knowledge-worker restart when shared modules require it. Never use Supabase Cloud deployment commands.

The frontend artifact connects Facebook owned performance and Threads saved insights to the shared screen and retains the legacy Instagram screen. Consequently, **this artifact alone does not meet the owner's full three-platform user-effect criterion**. A later approved Instagram adoption must enter the frozen final package, with new hashes/proofs. Frontend deployment follows main through Dokploy; record its build revision and verify the visible account, period, source, missing/partial states and retained history.

Disabled-state verification after a future approved deployment must demonstrate successful boots, exact auth/refusal behavior, owner-isolated saved reads and zero unintended collection/provider calls. It is not a pilot success. No switch, allow-list, admission, collection, retention or cron activation is bundled implicitly.

## Separately approved pilot operations

For each platform, authorize the exact switch and one account's eligibility addition, read both back and prove other targets remain excluded. Admission/first collection, daily-enqueue/drain schedules, reconciliation, rollback rehearsal and restoration follow their numbered approvals in the completion/release plans.

For Facebook/Threads the proposed real jobs are:

| Platform | Daily enqueue | Drain | Retention |
|---|---|---|---|
| Facebook | `facebook-analytics-enqueue-daily`, `5 * * * *` | `facebook-analytics-drain`, `*/5 * * * *` | `facebook-analytics-retention`, `35 * * * *` |
| Threads | `threads-analytics-enqueue-daily`, `5 * * * *` | `threads-analytics-drain`, `*/5 * * * *` | `threads-analytics-retention`, `35 * * * *` |

Installation creates all six inactive. Hourly dispatch considers the persisted provider-calendar due date; it does not imply an hourly metric day. Activate only the explicitly approved enqueue/drain jobs after their manifests are complete. Retention remains inactive until a reviewed dry run and its separate approval. Instagram uses its existing separately gated schedule plan, not these six names.

Acceptance requires supported measurements reconciled with Meta, explicit unavailable reasons, zero non-pilot writes, seven distinct successful scheduled due dates, and successful approved restoration after rollback. Duplicate retries, a manual-only run or an empty inactive schedule do not satisfy stability.

## Rollback

On an approved pilot stop, disable that platform's collection switch/eligibility and deactivate its exact enqueue/drain jobs; prove no further collection writes. Keep retention off. Restore the previous reviewed runtime/frontend artifact if needed, recording exact old/new SHA256 values. Preserve saved data and additive schema; this package contains no DROP, TRUNCATE or mass-delete rollback. Restoration and any cohort widening require their own approved, exact operations. Never mark the full goal complete with collection left disabled after the rehearsal.
