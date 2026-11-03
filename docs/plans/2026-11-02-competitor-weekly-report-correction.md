# Correct weekly inventory independently of report pagination

This is a correction within the approved [weekly inventory contract](../specs/2026-10-30-competitor-ui-and-retention.md#weekly-inventory), not a change to coverage, provider ordering, collection budgets or rollout permission. Required reading: `ARCHITECTURE.md` §§4, 10–17, 22–24, 31–34 and 36–39.

## Proven cause and required behavior

The current list projection does not include media. `assembleWeeklyInventory` substitutes zero for that missing input. A detail projection includes only the displayed media page, so its count can change with pagination. Both contradict the existing requirement to count distinct observed IDs in the displayed seven-day interval independently of the display page. The canonical new-target journey retained a list row saying zero observed posts after SQL had stored two.

Reuse the existing owner-scoped SQL report reader and its growth/cohort/cursor projection. Add an additive versioned owner RPC which calls that reader and augments each selected entry with a compact weekly inventory summary. Derive the anchor from the newest committed coverage row, or the latest stored successful media observation when coverage is absent. Count distinct stored successful media IDs published inside the inclusive seven-day interval and observed no later than the report's existing `as_of`. Every media/watchlist join carries `auth.uid()` ownership. Existing publication/capture indexes bound the range lookup; preserve the report's page limit and one read transaction. No new provider call or per-entry HTTP call.

The old SQL RPC remains callable with unchanged bytes/behavior. The Edge adapter switches explicitly to the new RPC, and its assembler requires the new summary rather than falling back to fabricated zero or a page count. The public report DTO stays version 1 with the same fields. An empty committed inventory has an observed-record count of zero; it does not establish zero publications or a complete weekly rate. Missing RPC/summary/invalid read fails closed. The existing coverage classifier alone decides whether `posts_per_week` can be published.

## Implementation and proof

1. Add the owner RPC in a new migration, revoke PUBLIC/anon/service-role execution and grant authenticated execution. Never edit an applied migration. Preserve strict request/cursor semantics by delegating to the existing reader. Keep tenancy structural even under SECURITY DEFINER.
2. Extend the raw internal entry with the SQL weekly summary. Change the store and weekly assembler together; validate safe count, finite aligned interval and consistency with committed coverage. Stop deriving whole-window counts from displayed rows. Reuse the coverage classifier and existing frontend DTO/formatter.
3. Run real SQL regressions for distinct IDs across repeated snapshots, more than one page, list/detail/continuation equality, no coverage, measured zero, inclusive boundaries, failed/future observations, foreign ownership and grants. Keep original RPC compatibility explicit. Capture a new raw v2 fixture from actual SQL; retain the older captured artifact with its own identity.
4. Update backend tests for valid/malformed aggregate inputs and coverage gating. Prove the original list-zero/page-count defect before the correction. Run affected SQL/Deno/TypeScript/lint checks and the real browser journey, including the two-post capture and historical report comparisons.
5. Freeze evidence and update the deployment package with the new prerequisite and import closure. Production remains NO-GO; new SQL must be separately approved/applied before the dependent Edge deployment. No merge, deployment, eligibility, schedule or retention activation is authorized by this plan.
