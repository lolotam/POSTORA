# Live capability verification for owned Meta accounts

Scope: read-only verification under [design §6 and its target-approval record in §12](../specs/2026-11-01-meta-analytics-completion-design.md). Current owner-approved targets are `FB-01`, `IG-01`, and `TH-01`. The exact account handles, owner association and database identifiers remain in the restricted evidence directory. Waleed explicitly allowed selection among connected administrator accounts, subsequently chose an alternative brand, and separately selected its Threads replacement when that brand had no active Threads connection. The ordered instruction record is retained privately; these choices authorize bounded reads only and do not admit collection pilots.

The preliminary observations below preceded those later explicit target instructions. They remain diagnostic observations, not proof of target-approved acceptance or retrospective pilot approval. The follow-up sections concern the subsequently approved targets. This record does not waive the design's target-approval requirement.

Restricted target-authorization record SHA256: `5e8a7cfd73bb67567fbe82311016a66a1feac7f71fda96a342db5c0040c62181`. It records instruction order rather than inventing unavailable message timestamps. This revision minimizes the public target mapping; earlier Git revisions have not been rewritten.

Before execution, a read-only database query required the configured owner, exact platform/username and active state. It returned one deterministically selected account per platform, with future stored expiry timestamps. A stored expiry timestamp does not prove that a token remains valid or that a permission is granted. No token value was returned by the selection query.

The initial Facebook/Threads runner is the independently reviewed, tested immutable `617699095ff8bb0a013bfca21c8d7f1326663f40` probe from [its runbook](https://github.com/lolotam/POSTORA/blob/617699095ff8bb0a013bfca21c8d7f1326663f40/docs/runbooks/meta-owned-analytics-capability-probe.md). Its canonical LF script SHA256 is `9b70831663d248ef0c60cc2174c6ec466053142fbe80032cdb507b1372ffad68`. Requested versions are Facebook `v22.0` and Threads `v1.0`, matching existing repository readers. These are probe choices, not assertions of metric validity. The runner does not accept Instagram; credential resolution must match the account's login context.

The repository is public. Detailed sanitized provider measurements and the exact target-authorization mapping are retained outside Git in a mode-0700 server evidence directory, with files restricted by umask 077. Public evidence records API/status/permission/capability/window/pagination metadata and artifact hashes, excluding account handles, administrator associations, private metric counts, account UUIDs, raw provider URLs, post text and credentials. No production analytics table, credential, permission, post, collection control or schedule is changed by these probes.

## Executed observations, 2026-11-01

These are capability observations, not acceptance of a complete report or a collection pilot. The requested windows ended at UTC midnight; provider-calendar alignment is unresolved. Successful HTTP responses alone do not establish exact-period semantics, retention limits, or permission grants.

| Probe | Capture interval (UTC) | Provider calls | Private artifact SHA256 |
|---|---|---:|---|
| Facebook | 04:35:17–04:35:31 | 21 | `457fd7ec6353c26e04c37ef049265a00b2f5cf43a4a71abf71cbea12b9523e14` |
| Threads | 04:35:32–04:35:40 | 33 | `fcb82e6b878036d9223bd71c6b4b43c14a8f18c522061d576f62d3600a521bcb` |

### Facebook Pages

- Token debug returned `is_valid: true`. Actual granted scopes include `read_insights`, `pages_read_engagement`, `pages_read_user_content`, and `pages_show_list`.
- Requests specified `v22.0`, but the response header reported **`v25.0`**. These observations must not be represented as proof of v22 metric semantics.
- Account metrics `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, and `page_follows` returned HTTP 200 and numeric measurements for every requested 7/14/30/90-day window. They reported `period: day` with bucket ends at `07:00 UTC`.
- Post metrics `post_media_view` and `post_total_media_view_unique` returned numeric measurements. The latter included both daily and lifetime rows; unique daily counts must not be summed into period reach. `post_engaged_users` returned HTTP 400/code 100; this remains an unresolved diagnostic, not proof of `not_offered`.
- Listing reached the end in one page, with no duplicates or repeated cursor. This verifies the observed small listing only.

### Threads

- `/me/permissions` returned HTTP 500. Granted scopes remain **unverified** despite successful insights calls.
- Account metrics `views`, `likes`, `replies`, `reposts`, `quotes`, and `followers_count` returned HTTP 200 and numeric measurements for all requested 7/14/30/90-day windows. Views contained daily buckets; the other tested responses contained totals without bucket end timestamps.
- For the UTC request `[2026-10-25T00:00Z, 2026-11-01T00:00Z)`, views included bucket ends from `2026-10-24T07:00Z` through `2026-10-31T07:00Z`. Reading only the first value or assuming seven matching UTC buckets is incorrect.
- All six tested post metrics (`views`, `likes`, `replies`, `reposts`, `quotes`, `shares`) returned numeric lifetime measurements.
- Two listing pages had no duplicates or repeated cursor, but continuation remained. End-of-list behavior has not yet been demonstrated.

### Calendar and acceptance limits

The observed `07:00 UTC` daily ends are consistent with Pacific daylight time, but one offset does not identify an IANA timezone or prove DST rules. At capture time, a Facebook bucket ending `2026-11-01T07:00Z` was still open. These raw UTC windows cannot establish reconciliation of closed provider days. Primary timezone documentation and aligned current/previous-window probes remain required.

Accepting a 90-day request does not prove a maximum supported window or the earliest retained date. Instagram direct-login verification, full Threads pagination, permission diagnostics, metric definitions, calendar alignment, and safe negative adapter journeys remain open. No registry cell is promoted to fully verified availability by this record alone.

## Follow-up on the owner's named targets

### Facebook `FB-01`

The updated immutable probe `7ab53ed5c0d4b24a28ccf232da6107cb6fa47546` has LF source SHA256 `f4ee0aa54442a7542c2cf17e5d0e8e42187efc926798df880817eaba78ebef7d`. Its private capture completed with 22 provider calls; artifact SHA256 `a38b64796a7e07779e1149cd4a9b4bbdf67d5867bd28171670dcab13f12ad853`. Token debug confirmed validity and actual grants including `read_insights`, `pages_read_engagement`, `pages_read_user_content`, and `pages_show_list`. Responses again reported `v25.0` despite requested `v22.0`. Both bounded listing pages retained continuation, without duplicates or repeated cursors; this capture does not prove end-of-list behavior.

Capture interval: `2026-11-01T04:51:13Z`–`04:52:08Z`. All four tested account metrics returned numeric daily measurements for 7/14/30/90 requests. Post views and unique-view metrics returned numeric measurements; `post_engaged_users` again returned HTTP 400/code 100. Definitions, exact-period semantics and provider-calendar alignment remain unresolved, so none of these successes establishes reconciliation.

### Instagram `IG-01`

The active row is `ig_auth_type: facebook_business`, not direct Instagram Login. Before making any Instagram provider call, the existing stable service-only `read_facebook_user_account_credential` was evaluated for the exact active owned account in a `BEGIN READ ONLY` transaction. The function exists in production, but returned `found: false`, `credential_kind: null`, and no capability generation. No token was returned to the operator. This proves that the protected account binding required by the current Page-linked owner worker is absent; it does not prove that Instagram insights are unsupported or that the legacy token is invalid. No fallback to the account's legacy credential was attempted. Credential repair/reconnection and collection acceptance remain separate from this read-only diagnostic.

The direct-login probe in [PR #338](https://github.com/lolotam/POSTORA/pull/338) is intentionally inapplicable to this selected account. Sixteen offline tests passed on Windows and Linux with matching source hashes; the actual disposable SQL harness also proved direct owned success and five context/ownership refusals. Those are tool-safety tests, not live Instagram capability evidence.

### Threads `TH-01`

The four-call diagnostic captured at `2026-11-01T04:53:24Z`–`04:53:25Z` confirmed `/me` matches the stored canonical identity. `/me/permissions` returned HTTP 500/code 100. `/debug_token` authenticated with the same user token returned HTTP 403/code 10; this is refusal of that debugger request, not proof that `threads_manage_insights` is absent. Actual grants remain unverified.

A bounded fixed-origin listing using a page limit of 25 reached the end without duplicate IDs, repeated cursors, malformed IDs or missing continuation. This establishes end-of-list behavior for the observed account at that capture, superseding the initial two-page incomplete listing. It does not implement production continuation or prove listing stability during concurrent publication. The diagnostic JSON SHA256 is `52baecc311a2b44a330f711b27f89165411517aac6ee63b0d9f03f2cd9f02395`; its script and artifacts remain in the restricted evidence directory. No provider URLs or identifiers are published here.

**Permission verification resolved at 04:55:27 UTC:** [Meta's official Threads collection](https://www.postman.com/meta/threads/request/34203612-e9a7f46e-e48c-4987-a203-22fb25a4b604) documents `/debug_token`; its [app-token example](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api) uses the Threads `TH|…` format. One read authenticated with the configured Threads app credentials returned HTTP 200, `is_valid: true`, the exact stored Threads user identity, future expiry, and actual scopes including `threads_basic` and `threads_manage_insights`. No token was created, exchanged, refreshed or modified. The sanitized result hash is `9fcf8d768a3f82021da61c37bda0c7dc18b52667793b51032d694dc3106a6662`.

The initial diagnostic's `matchesConfiguredApp: false` was caused by a **missing `app_id` field**, not an observed differing app ID. A one-call response-shape verification confirmed that absence; hash `02b18fe06a8b97abe856470e1697d1144b3508ab842b6435c1e2818fb585b9cc`. App-ID comparison is unavailable, while token validity, expected user identity and granted scopes are verified by the authenticated debugger response. The older `threads-debug.ts` comment claiming Threads has no debug-token endpoint is contradicted by this live evidence. The permission probe should use the Threads app-authenticated debugger rather than interpreting `/me/permissions` failure as absence of scope.

### Release decision

The owner explicitly retained the [complete G-X gate](../specs/2026-10-30-instagram-release-gates.md) before an Instagram owner pilot. No limited exception, collection activation, schedule or credential change was approved by target selection. Read-only diagnostics cannot satisfy that gate, and neither preliminary nor follow-up captures establish seven distinct scheduled due-date receipts.

## Metric definitions and implementation consequences

A four-call definition diagnostic captured at `2026-11-01T05:03:27Z` requested Facebook `v25.0` explicitly and observed the same version header. It retained only metric names, titles, descriptions, periods and sanitized failure metadata. JSON SHA256: `be28deeb1665463ac0eb8f160a520482b0cb28bd7e3429d8a5ad7825afb14fac`. The resulting candidate mapping and aggregation rules are owned by [design §4.3](../specs/2026-11-01-meta-analytics-completion-design.md#43-common-metric-set).

The provider explicitly described Facebook `page_follows` as lifetime total follows, although each response row said `period: day`. It described Threads account `views` as profile views, distinct from post content views. These findings rule out daily summation of follower snapshots and a shared content-view label for the account metrics. The Facebook rejected-post diagnostic classified code 100 as `invalid_insights_metric` without retaining its raw error text; no replacement is asserted.

The updated probe at `8247ab8f` verifies Threads scopes through the app-authenticated debugger and retains unreported app identity honestly. Seventeen boundary tests passed on Windows and Linux with matching LF source/test SHA256 values `c8676099af173a2d415f7409e84955e78c40cf71bc017b35be86fd53ce7de835` and `d09a479a73a83a4676ba4f2e40cc27ceb09221c8e1e68541886dc02802d50103`. These Linux tests used replaced network/database boundaries and made no live Meta calls.

## Threads runtime correction deployment

[PR #336](https://github.com/lolotam/POSTORA/pull/336) merged as `3755788b97c0ec03ed2d10688eb357b4bee6f581` at `2026-11-01T05:01:42Z`, after all reported hosted checks passed. The automatic edge reconciler deployed it; an explicit run of the versioned deployment helper at `05:02:17Z` confirmed the volume already matched that commit. The operator then verified these exact LF SHA256 hashes:

- `threads-insights/index.ts`: `486d3b51af5b0f0f84a6cfc2d9c9ccc7ce86d727bdb2621ea8634bf71187e37b`.
- `threads-insights/provider.ts`: `0ec0224544b175f6bf303e22ac295f6399ca2c66765704ee527b4061438a0b8e`.

Health and Threads OPTIONS returned 200; an unauthenticated POST returned the exact function 401 refusal. Local validation passed 13 Deno tests/47 nested steps, 11 translated component tests, typecheck/build and the immutable lint/i18n regression gate. These prove the correction's checks and deployment, not a signed-in browser journey or completion of the analytics project. No collection or schedule was activated.
