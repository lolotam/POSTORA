# Live capability verification for owned Meta accounts

Scope: the owner's requested read-only verification under [design §6 and its authorization record in §12](../specs/2026-11-01-meta-analytics-completion-design.md). The operator selected the common active Flexitol brand accounts attached to the configured project administrator: Facebook `Flexitolkw`, Instagram `flexitolkw`, and Threads `flexitolkw`. The user did not separately choose this brand. The earlier extra account-choice question was unnecessary for the already requested reads; this record does not imply collection-pilot approval.

Before execution, a read-only database query required the configured owner, exact platform/username and active state. It returned one deterministically selected account per platform, with future stored expiry timestamps. A stored expiry timestamp does not prove that a token remains valid or that a permission is granted. No token value was returned by the selection query.

The Facebook/Threads runner is the independently reviewed, tested immutable `617699095ff8bb0a013bfca21c8d7f1326663f40` probe from [its runbook](https://github.com/lolotam/POSTORA/blob/617699095ff8bb0a013bfca21c8d7f1326663f40/docs/runbooks/meta-owned-analytics-capability-probe.md). Its canonical LF script SHA256 is `9b70831663d248ef0c60cc2174c6ec466053142fbe80032cdb507b1372ffad68`. Requested versions are Facebook `v22.0` and Threads `v1.0`, matching existing repository readers. These are probe choices, not assertions of metric validity. Instagram uses its separately resolved direct-login credential context; this runner does not accept Instagram.

The repository is public. Detailed sanitized provider measurements are retained outside Git in a mode-0700 server evidence directory, with files restricted by umask 077. Public evidence will record API/status/permission/capability/window/pagination metadata and artifact hashes, excluding private metric counts, account UUIDs, raw provider URLs, post text and credentials. No production analytics table, credential, permission, post, collection control or schedule is changed by these probes.

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
