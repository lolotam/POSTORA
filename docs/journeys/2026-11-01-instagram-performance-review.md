# Instagram performance report: review corrections

This record extends PR #329's service-role, cursor, pagination and total corrections. It does not accept an owner pilot, canonical G-X, collection activation or concurrent snapshot consistency.

## Proven defects and correction

The HTTP handler accepted upper-case UUIDs but passed the service owner ID unchanged into ownership comparisons against PostgreSQL's canonical lower-case rows. Normalize validated owner IDs at the report boundary, including JWT identity, while retaining structural account/owner filters and JWT precedence over body identity.

The bounded history reader refused row/page overflows with `ReportHistoryUnavailableError`, but SDK storage failures and aborted deadlines used other error types. The handler consequently returned generic HTTP500 for those reads instead of its retryable `503 / HISTORY_UNAVAILABLE`. The shared feature-local query boundary now converts aborted/deadline outcomes to that typed refusal; account, history, status and checkpoint failures use the same unavailable path. Unexpected programming errors retain their original error and the existing internal-error behavior. Failed reads never become successful empty reports.

Seven composition regression steps failed before correction: owner UUID casing, two storage-error cases and four SDK deadline boundaries. The corrected report suite passes **86 tests / 20 nested steps**. It also verifies pre-aborted reads, an aborted boundary that still resolves, and propagation of unexpected failures. These are isolated fixtures, not production collection receipts.

## Remaining acceptance

The existing reader still fetches history/status through separate REST queries. Exact counts and a timestamp cutoff do not supply a database snapshot or a revision binding across changing captures. C4 must supply that consistency before concurrent pilot acceptance; the bounded reader is not represented as that proof. Full G-X, protected credential readiness, the owner pilot, Meta reconciliation and scheduled-run evidence remain pending. No credential, collection switch, allow-list, schedule or migration is changed by this correction.
