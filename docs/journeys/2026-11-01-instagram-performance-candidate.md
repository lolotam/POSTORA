# Instagram performance repairs — local candidate

Date: 2026-11-01. Scope: owned-account performance analytics, Batch A2–A5 of the Meta analytics completion plan. This record is local evidence, not production acceptance or an activation approval.

## Proven defects and corrections

| Defect | Evidence and resulting behavior |
|---|---|
| Service-role report requests returned 401 | The composition root omitted the validated body user ID required by the shared auth helper. Real composition tests now prove owned success, foreign-account non-enumerating 404, JWT identity precedence, and missing/invalid service identity refusal before reads. |
| Gateway cursor fields differed from the server contract | One pure codec owns `publishedAt`/`mediaId`; the gateway sends that tuple and the HTTP handler delegates to the codec. Tuple, JSON and legacy base64 encodings preserve microseconds; malformed cursors fail before database reads. |
| The UI consumed an obsolete flattened report DTO | The actual assembler returns `account.daily`, `account.latestProfileObservation` and `media.page`; old tests constructed the obsolete shape. Frontend types now come from the canonical runtime-neutral contract and UI fixtures use the real server assembler. |
| Load more never advanced the report | An infinite query fetches and accumulates pages, preserving server ordering and deduplicating media IDs. Integration tests cover the final page, period reset and retained data after next-page failure. |
| The store silently stopped at 200 snapshots, 100 daily rows and 50 profile observations | Owner/account-filtered keyset traversal now reads all three series independently of the display cursor. Exact PostgREST counts prevent a server row cap from masquerading as end-of-list. A real SDK/HTTP-boundary regression reads 522 snapshots representing 261 distinct media, with a synthetic server cap of 37 rows, and reaches all media through three display pages. |
| Unique reach was a daily sum, partial sums looked complete, and chart gaps became zeros | Unique period reach is unavailable until an exact provider total exists. Additive metrics expose per-metric day coverage using the report's date bounds. True zero remains numeric; missing/failed days remain chart gaps. Views are labelled as views. |
| Failed collection-status reads looked like never-synced accounts | A failed status RPC now fails the report, preserving the distinction between missing data and failed reads. |

The previously reviewed error-message fix, [PR #326](https://github.com/lolotam/POSTORA/pull/326), was merged before integration into this candidate. Its translated refusals and regression tests are preserved.

## Validation

- Node/Vitest: 46 focused tests passed, including real gateway/assembler pagination, account/period isolation and metric coverage cases.
- Deno 2.9.0 via pinned npm package: 82 report tests and 13 substeps passed, with typechecking enabled. CI config specifies a different Deno patch version; the local result does not claim patch-version parity.
- `npm run typecheck` passed.
- `npm run build` passed; existing WhatsApp circular-chunk and large-chunk warnings remain.
- Production/test guard passes checked the changed scopes; documentation review checked this record against the implementation and executed results. These are agent guard passes, not independent approval.
- The lint/i18n regression gate initially caught two translation keys orphaned by the metric-copy correction. Both obsolete keys were removed; the corrected production code at `914eb868` passed with **NO REGRESSIONS**, retaining the historical baseline of 1224 ordinary lint errors and 364 i18n aggregate findings. Subsequent account-isolation test/documentation additions still require the final PR revision's hosted check; a historical pass is not that result.
- `graphify update .` completed. Generated graph changes are excluded from task commits.

## Operational limits and remaining acceptance

The reader permits at most 40 database pages and 20,000 rows per series, with a shared 20-second budget across ownership, history and status reads. Exceeding a row/page bound, missing exact counts or a non-advancing page produces a 503 refusal rather than a successful truncated report. Ordinary database failures remain sanitized errors. Large-history behavior above these bounds needs a separately reviewed database-side reader; this candidate does not claim unbounded history or production scale acceptance.

No migration or collection-setting change is included. No pilot account, switch, allow-list or cron was enabled, and this backend candidate has not been deployed. Merging it into `main` can trigger the existing automatic Edge reconciler, so merge/deployment remains subject to the authoritative release B1/B2 prerequisites and separate approval.

Owner-only release artifacts, the canonical Task 11 prerequisite decision, capability probes, provider reconciliation and seven distinct scheduled due-date receipts remain pending. Facebook/Threads persisted analytics and the shared versioned contract are subsequent workstreams. A green local suite does not close those obligations.
