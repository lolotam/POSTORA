# Unified analytics contract and Threads read path

This is the local B1/B3 implementation candidate from the [completion plan](../plans/2026-11-01-meta-analytics-completion.md), based on main `02faafceaf3679ecd4b63ab5c8e024bb160a022c`. It is not a collection activation receipt or completion of Batch B/C. The earlier partial B1 proposal in #331 overlaps this implementation and must be reconciled before either is merged independently.

## Behavior

The default Threads request retains its legacy response. An explicit `analyticsContractVersion: 1` selects the canonical contract through `threads-insights`, `/api/v1/analytics` in n8n-api, and MCP's `get_post_analytics`. The proxy forwards the version and signed cursor; unsupported versions or platforms refuse rather than silently returning a legacy response. Instagram/TikTok default requests remain compatible. MCP's existing `posts:read` requirement and connection-mode classification are unchanged.

The canonical browser/Edge modules describe each metric's platform, level, source/version, definition, permission, unit, window, aggregation and evidence. Missing/unsupported/unverified data stays unavailable; genuine zero stays numeric. The serialized schema is consumed by the runtime validator. Semantic checks additionally verify complete metric definitions, observation times, adjacent frozen calendar periods, daily aggregate/trend consistency, computed deltas and persisted freshness. Evidence references/timestamps can refresh during a rolling deployment; other semantic definition changes require compatibility review.

Reports use 7/14/30/90 closed `America/Los_Angeles` calendar days and an adjacent comparison period. Spring/fall DST, leap day and year rollover are tested. The [aligned live captures](2026-11-01-meta-live-capabilities.md#closed-window-and-dst-observations) support that pinned calendar empirically. They do not establish a provider-declared timezone or a universal retention limit.

Threads account profile visits are separate from content views. Undated interaction totals with unproven exact-period semantics return `window_mismatch`. A current follower observation has no fabricated historical comparison/growth. Posts published within the selected period carry explicitly lifetime measurements. A provider listing failure is distinct from a genuinely empty list.

The versioned path reuses the existing request-wide provider budget (30 seconds, at most 32 provider calls, 4 seconds per call, at most three post calls concurrently, no retries). Each page contains at most ten provider posts. The signed cursor binds owner/account/days/calendar bounds, carries no provider URL and detects repeated cursors. The eighth page cannot issue another continuation. Crossing provider midnight invalidates an old cursor explicitly; restart the selected period. No request silently shifts that cursor to a different calendar window. A bounded page chain does not guarantee complete history for prolific accounts.

`source: live` always has `sync.status: never_synced`; these reads do not claim successful persisted collection. Account selection/ownership precedes provider calls, refusals are audited, and credentials/provider pagination URLs do not reach the response. The pure browser facade is prepared for C5; the current Threads panel still uses the legacy contract.

## Validation

- Deno: 23 tests and 84 nested steps passed across provider, real endpoint composition, calendar, contract and cursor suites. Fixtures replace only network/database/time boundaries. They include a real proxy-to-handler continuation, missing day/metric, failed comparison/post/listing, token expiry, time-budget exhaustion, cursor tampering/context mismatch/cycles/cap and legacy compatibility.
- MCP/service proxy: 150 tests passed.
- Vitest: 13 tests passed across complete artifact parity and the existing translated Threads panel.
- `npm run typecheck` and `npm run build` passed. Build retains existing dependency/chunk warnings.
- Targeted ESLint reports only the two existing `no-explicit-any` findings in the legacy Threads DTO; no new-file findings. Immutable lint/i18n regression results are recorded after the candidate commit.

`clean-code-guard`, `test-guard` and `docs-guard` were applied to the changed production/test/documentation surfaces. New pure modules have an active production consumer in the versioned Threads report; the browser facade imports the same canonical artifacts, without SDKs or copied definitions. No migration, credential, collection switch, allow-list or schedule changed. This candidate has not been merged or deployed.

## Remaining acceptance

B2 still needs unresolved metric retention/total semantics and Instagram capability evidence after its protected credential binding is repaired through an approved operation. B4's Facebook owned-Page adapter, C1/C2 storage decision/migrations, C3 workers, C4 persisted reports/Instagram negotiation, C5 shared UI and C6/C7 separately approved pilots remain. The canonical G-X prerequisite remains mandatory before the Instagram owner pilot. Seven distinct scheduled due-date receipts, reconciliation, rollback and approved restoration are not supplied by fixture tests or read-only capability probes.
