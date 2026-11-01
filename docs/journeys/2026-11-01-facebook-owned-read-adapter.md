# Owned Facebook Page analytics read adapter

Local B4 candidate built on the corrected contract proposal in [PR #340](https://github.com/lolotam/POSTORA/pull/340), head `680ee7f2ccc623930f423e97e92fd7658a40e517`. The parent review corrections have been incorporated: the canonical parser keeps its stronger `last` policy, and the shared cursor codec keeps the corrected bounded opaque grammar. This branch is not deployed. No collection, migration, credential or schedule change is included.

## Data path and behavior

`facebook-page-insights/index.ts` authenticates the caller with the shared helper and requires an explicit account UUID and `analyticsContractVersion: 1`. The account lookup structurally binds owner, ID, platform and active state. Missing/foreign/inactive/wrong-platform selectors share a 404 response; a failed database read remains 503. The stored Page token must identify the selected canonical Page through `/me` before any listing or insights read. User JWT identity takes precedence over a body owner. All refusals attempt an audit row, and the new endpoint uses restricted CORS.

The n8n `/api/v1/analytics` proxy and MCP's `get_post_analytics` select this reader only for an explicitly versioned Facebook request. Facebook has no legacy fallback. Existing Threads/TikTok/Instagram default requests retain their behavior and permissions. Actual proxy-to-handler composition tests exercise both signed pages; the invocation boundary forwards the actual body without filling missing version fields in the fixture.

Facebook requests pin Graph `v25.0` and require the response's `facebook-api-version` to agree before treating a success as verified data. Each metric is read separately, so a denied metric does not erase other results. Summable daily metrics use exact closed calendar ends; cumulative `page_follows` uses the final day only. Daily unique viewers remain unavailable as a period total, with their dated trend retained. Post views and unique viewers select the lifetime row even when Graph also returns a daily row. Missing values, permission failures, malformed responses and ambiguous code-100 parameter errors never become zero or an asserted `not_offered`/`outside_retention` classification.

The common fixed-origin transport, bounded read pool, count/calendar projection and signed cursor codec are shared with the production Threads consumer. Existing Threads signing bytes/API remain compatible. Facebook and Threads use different HMAC purpose namespaces, preventing a cursor from one platform being replayed in the other. Each request retains a 30-second provider budget, four-second attempt ceiling, 32-call maximum, at most three simultaneous provider reads, one-MiB response cap and no retries. Facebook returns at most five listed posts per page and at most eight continuation pages; exhaustion and failed listing stay explicit. Provider next URLs are never followed or returned.

The response remains `source: live` and `sync: never_synced`. It does not claim persisted history or scheduled collection. Stored Page analytics, Instagram adoption, shared UI and approved pilots remain later plan tasks.

Optional malformed or credential-bearing permalinks use the parent's canonical normalization policy and become null without dropping the post's usable measurements. Intentionally unmeasurable period aggregates do not mark a completed read as partial collection; provider failures, missing measurable values and actual pagination truncation still do.

This dependent change also closes [the remaining previous-period completeness finding on #340](https://github.com/lolotam/POSTORA/pull/340#discussion_r4434705432). A successful HTTP response that omits a measurable comparison metric still marks the report incomplete; current point-in-time followers intentionally have no historical comparison and remain exempt. The shared policy is consumed by both platform reports, and real endpoint regressions use a completed second page so ordinary pagination cannot mask the missing-comparison defect. Review the parent and this follow-up as the combined runtime candidate before acceptance.

## Additional bounded live evidence

A two-call read-only metadata diagnostic on the owner's authorized `FB-01` target ran at `2026-11-01T06:31:56.955761Z`–`06:31:57.675759Z`. Canonical Page identity matched; the post-list request returned HTTP 200 under requested/observed `v25.0` for `id,created_time,message,permalink_url`. The sampled response contained an owned composite ID, creation time and an HTTPS Facebook permalink. `message` was absent, so text is optional in the adapter and never synthesized. The diagnostic's strict all-fields `shapeVerified` flag was false because it required `message`; the individual presence facts, rather than that aggregate flag, support the optional-field implementation.

Only field-presence/shape metadata is retained in the private artifact. Its SHA256 is `1d3b90314e0eb4c2e3306406bbc2800a9c375ff856b5864ddf2a7a1221ecc786`. The artifact and target mapping remain in the restricted server directory. No caption, permalink, account ID, target mapping, provider URL or private metric count is committed here. The earlier restricted owned-post capture was also inspected by period/kind only: `post_media_view` had a lifetime bucket; `post_total_media_view_unique` had daily and lifetime buckets. No measurement values were printed.

Official Meta Page-post/Insights documentation could not be fetched in this session (inaccessible/throttled). No mirror was substituted as authoritative evidence. The [live capability record](2026-11-01-meta-live-capabilities.md#closed-window-and-dst-observations) remains the evidence for the tested windows. Per-metric earliest retention and exact unique-period totals remain unresolved; a generic invalid-parameter response does not resolve them.

## Local verification

- Deno real composition/provider/calendar/schema/cursor suites: 26 tests, 119 nested steps passed after rebase and comparison-policy corrections, with CI's exact permissions.
- MCP/service proxy: 150 tests passed; Vitest parity/existing translated Threads panel: 13 tests passed.
- Typecheck and production build passed. The immutable lint/i18n regression result is recorded separately before this candidate is published.
- Targeted ESLint passed for changed production/test files. `clean-code-guard` and `test-guard` were applied; extraction helpers have active production callers in both Facebook and Threads. Documentation was checked with `docs-guard` against the actual modules and probe metadata.

These are local fixture journeys and bounded provider-shape evidence, not a deployed signed-in journey or reconciliation. The complete G-X prerequisite remains in force before the Instagram owner pilot. No seven-day schedule receipts, rollback/restoration or widening acceptance is claimed.
