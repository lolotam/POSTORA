# Competitor weekly inventory independent of display pagination

The [correction plan](../plans/2026-11-02-competitor-weekly-report-correction.md) addresses a reproduced report defect. The [execution record](evidence/2026-11-02-competitor-weekly-inventory-proof.json) binds the actual local source, schema/runtime/test inputs, retained failures, reports and cleanup. **The complete release remains NO-GO.** This is author-recorded local evidence, not independent G-X acceptance or live Meta reconciliation.

## Cause and correction

The list reader intentionally returns no media rows, while the detail reader returns one display page. The former assembler derived the whole-week count from those rows. Consequently, a real capture storing two posts produced a list saying zero observed posts, and detail pagination could change the weekly count. A prepared regression on the old code returned zero instead of the supplied whole-window count of 31. An earlier attempt failed because the cached std assertion dependency was absent; that attempt is retained but is not the product regression.

The additive migration `20261102090000_competitor_weekly_inventory_projection.sql` adds `read_own_competitor_tracking_report_v2(jsonb)`. It reuses the original strict owner report reader, request validation, cursor and growth/cohort projection, then adds an internal `weekly_inventory` aggregate. It counts distinct successful stored media IDs published inside the inclusive 168-hour interval and captured no later than the report's existing `as_of`. The newest committed coverage anchors the interval; without coverage, the newest successful stored media capture anchors it. SQL derives the fallback from the stored inventory, never the displayed page.

Each watchlist, coverage and media lookup structurally binds `auth.uid()`. The function has a controlled search path and authenticated-only EXECUTE; PUBLIC, anon and service-role execution are revoked. The original reader remains unchanged. A partial index supports the fallback lookup. The database type map includes the additive RPC signature.

The report store explicitly calls the new RPC. The assembler requires a safe count, an exact seven-day interval and consistency with committed coverage. Missing or malformed summaries fail the read; no fallback substitutes a page count or zero. The public report DTO remains version 1. Coverage still decides whether `posts_per_week` is available. Zero stored observations does not prove zero publications; incomplete/unverified coverage retains a null rate and its reason.

## Executed proof and source boundaries

The canonical checkout was clean at `6d109d4ca35d3fb024a16b99e47f24a92f814b1f`, matching its disposable Docker candidate label. All **seven canonical browser journeys passed**, with zero skips, retries, failures or flaky results. The updated capture journey asserts `2 posts observed · incomplete coverage` after real local Auth, queue, worker/v2 persistence and report assembly. Only external provider HTTP is synthetic.

Fresh preparation passed the baseline, **152 newer migrations, 70 baseline SQL suites and one isolated suite**. The new real SQL suite proves:

- 31 distinct IDs with repeated daily snapshots plus two inclusive boundary IDs yield **33 observed posts**, while the displayed detail page contains **10 media rows** and a continuation.
- List, first detail page and continuation return the same aggregate. Failed observations, outside/future publications, future captures and another owner's rows do not contribute.
- Missing coverage uses the stored fallback anchor; an empty inventory has zero observed records without asserting a complete publication rate.
- The old RPC projection remains compatible, cross-owner requests fail and role grants enforce the owner boundary.

The SQL suite was replayed transactionally to capture `fixtures/captured-weekly-report-v2.json` from actual database output, then rolled back. Its first shell-format identity diagnostic had a quoting error; full Docker inspect JSON independently confirmed the prepared fixture's candidate and purpose. The capture metadata retains that error rather than claiming the original diagnostic passed. No production connection was used.

The report Deno directory passed **120 tests** on the implementation inputs. Commit `cffff00423117a6c2787fad5e4bc177a4e9310de` adds the actual SQL-captured artifact and its assembler regression; that suite passed **121 tests**. The proof verifies the runtime, migration, SQL suite, harness and browser-test bytes are unchanged between the canonical execution source and that later test source. This does not relabel the canonical execution as a run of the later commit.

The original `fixtures/captured-report.json` remains unchanged. Existing growth/outlier unit cases explicitly augment that older artifact with a synthetic weekly summary, marked as such in their helper. They do not claim that augmentation came from SQL. The new v2 fixture and its regression provide the actual SQL projection boundary.

Scoped ESLint and the Deno fixture-server check passed. Immutable lint/i18n reports **NO REGRESSIONS** from `eaf720e7ef20d577cc24d446e2cf09e43f3a90ea` to `cffff00423117a6c2787fad5e4bc177a4e9310de`; existing lint/i18n debt remains. Graph maintenance completed. No frontend runtime source or public DTO changed in the correction, so the earlier frontend build evidence retains its own source identity. The later database type-map addition is erased at runtime and has its own frontend typecheck.

## Cleanup and deployment limits

Independent post-teardown SQL found only the baseline user and no fixture namespace, scrape session/cache, OAuth client, collection job, competitor profile/media observation or coverage. No cron job was active; `cron.launch_active_jobs` remained off. Both HTTP listeners were stopped. Prior containers/volumes and failure artifacts remain preserved.

This proves the weekly count's SQL pagination independence and its two-post browser display. Historical E2 comparisons, outlier J7 journeys, remaining J/E assertions, protected reconnect, canonical Instagram metric/calendar adoption, trusted workflow/bootstrap/CODEOWNERS, independent review and migration-history recovery remain open. The [consolidated index](2026-10-26-instagram-insights-and-competitor-tracking.md) and [deployment package](../runbooks/2026-11-01-meta-analytics-deployment-package.md) retain those limits.

The new SQL/index must be separately approved and installed before the four dependent report runtime files are deployed: `assemble.ts`, `contracts.ts`, `reportStore.ts` and `weeklyInventory.ts` under `supabase/functions/competitor-tracking-report/`. The older frozen deployment manifest does not include these bytes. No production schema, runtime, credential, eligibility, schedule, retention, paid provider request or social content changed. Deployment is deferred under the owner's instruction to finish missing work before presenting a concrete production package; this correction is not a complete release. `mem0` is unavailable, so the source-bound records preserve the continuation.
