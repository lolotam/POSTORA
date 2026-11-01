# Read-only owned-account capability observations

This is the bounded Facebook/Threads observation tool for [Meta completion plan B2](../plans/2026-11-01-meta-analytics-completion.md#b2-capability-probes). It does not complete the platform capability matrix, approve a pilot or enable collection. The owning design's account/probe approval requirement applies before running it against a real account.

## Scope and execution

`scripts/probes/meta_owned_analytics.py` runs on the Postora Contabo host with Python 3.12 and the existing Docker CLI. It has no package dependencies. Its database container and functions container are fixed to the Postora stack. Execute host operations through the project's `ssh-contabo-mcp`; do not run this locally against a different Docker host.

The operator first records the exact approved owner/account/platform and pinned API version. UUID syntax is validated before constructing the query. One `BEGIN READ ONLY` query selects only the exact active account belonging to that owner/platform. A missing row or failed read refuses setup; there is no fallback to another account. The stored token stays in server process memory. Each platform's own app credentials are read through captured subprocess output only for its `/debug_token` permission probe; they are never printed or supplied as process arguments. Facebook uses its app token; Threads uses the configured `THREADS_APP_ID` / `THREADS_APP_SECRET` as a `TH|…` app credential. No token exchange or renewal occurs.

Threads' debugger must report a valid token, the exact stored platform user identity, and a well-formed actual scope list before `verified` becomes true. A missing/failed app-credential read, refused debugger, invalid token, missing scopes or mismatched identity stays unverified. Missing `app_id` is recorded as unreported, never as a differing app identity. This replaces the initial `/me/permissions` probe, whose HTTP 500 did not establish scope absence; see the [executed diagnostic evidence in PR #337](https://github.com/lolotam/POSTORA/pull/337).

After copying the reviewed script to a temporary server location, supply the IDs from that recorded decision through `APPROVED_OWNER_ID` and `APPROVED_ACCOUNT_ID`. These are account identifiers, not credentials. The following are alternative invocations for their respective approved platforms:

```sh
python3 /tmp/postora-meta-owned-analytics.py \
  --owner "$APPROVED_OWNER_ID" --confirmed-account "$APPROVED_ACCOUNT_ID" \
  --platform facebook --version v22.0

python3 /tmp/postora-meta-owned-analytics.py \
  --owner "$APPROVED_OWNER_ID" --confirmed-account "$APPROVED_ACCOUNT_ID" \
  --platform threads --version v1.0
```

`v22.0` is the version currently requested by the repository's Instagram/Facebook readers, not a statement that every candidate Facebook metric remains supported. Requested and observed API versions are recorded separately when the provider supplies its version header. Changing a probe version is an explicit evidence choice. Instagram is intentionally not accepted by this tool: its protected direct/Page-linked credential contexts must be resolved through their existing adapters rather than treating the legacy account token as canonical.

## Observations and bounds

The metric names in `METRICS` are **probe candidates**, not verified registry entries. Each is requested independently so rejection of one does not erase the others. Account requests cover 7/14/30/90 closed UTC-day windows. These UTC request bounds do not establish the provider's bucket timezone. Listing checks at most two pages of two posts, records duplicate counts/repeated cursors/continuation, and probes the first returned post's candidate insights. No post is published or modified.

The provider budget is 48 calls and 120 seconds, with each request limited to the remaining budget or five seconds. A POSIX request alarm covers opening, reading and decoding, rather than relying only on a socket inactivity timeout; the live CLI refuses platforms without these timers. There are no retries. Every request has a fixed Meta origin; pagination rebuilds the request with the opaque `after` cursor and never follows `paging.next`. HTTP redirects are refused before forwarding credentials. Provider response bodies are capped at one MiB. Setup subprocesses each have a ten-second limit.

A declared `next` key with an empty/invalid value or missing cursor is an invalid continuation, not end-of-list evidence. Malformed paging/IDs and duplicate IDs also prevent a completed-listing claim.

Output is sanitized JSON: numeric measurements (including genuine zero), retained bucket end times/periods, request bounds, numeric provider error codes, selected numeric usage values and retry hints, plus an owner/account fingerprint. Tokens, raw provider URLs, post text, raw error messages and unapproved headers are excluded. Credential and permission errors remain distinguishable. Missing measurements remain absent and unique reach is never summed. Completed metric receipts survive a later budget exhaustion.

Exit zero and `execution: finished` mean the observation run completed; individual requests can still have failed. `capabilityVerification: incomplete`, unknown provider timezone and unverified retention/window limits remain explicit. Successful 7/14/30/90 requests prove only those observed requests, not the earliest retention date or maximum supported window. A rejected candidate is not automatically `not_offered`. Review source documentation, exact provider semantics and account permissions before promoting any registry cell.

Setup failure returns nonzero with `execution: failed` and `reason: probe_setup_failed`. Budget exhaustion returns nonzero with `execution: budget_exhausted` and preserves completed metric observations. The script writes no analytics tables, tokens, rollout flags, cron entries or log rows. Its caller may save the sanitized JSON and add a reviewed Markdown interpretation to `docs/journeys/` after the approved run.

## Local validation

```sh
python3 -m unittest discover -s scripts/probes -p 'test_*.py' -v
python3 scripts/probes/meta_owned_analytics.py --help
```

Ten unit tests passed on Windows and on the Contabo Linux host. They cover true-zero/missing/multiple-bucket decoding, sanitized failures/usage, authenticated fixed-origin requests, repeated pagination, budget refusal/partial receipt retention, redirect refusal, failed account setup, granted-versus-declined permissions, invalid/oversized HTTP-200 responses, and request deadline enforcement. Windows verifies that the live CLI refuses unsupported timers; Linux verifies interruption and signal/timer restoration. The Linux run used reviewed copies in a temporary directory with matching SHA256 hashes and replaced HTTP/subprocess boundaries; it made no live Meta or account-database requests.

The separate real SQL check also passed against the labelled local disposable database: exact owned account success plus four identical refusals for foreign, inactive, wrong-platform and nonexistent accounts. It creates only fixed synthetic identities after proving they do not exist, then removes those fixtures. It refuses remote Docker endpoints, shared container names and non-harness database names. Local disposable database invocation:

```sh
python3 scripts/probes/check_meta_owned_analytics_sql.py \
  --container postora-owner-release-pg --database postora_owner_release_harness
```

CI uses its already migrated harness:

```sh
python3 scripts/probes/check_meta_owned_analytics_sql.py \
  --container pg-harness --database partner_api_harness
```

Provider decoding rejects nonstandard JSON numeric constants. Numeric observations and usage counts outside JavaScript's exact integer range are excluded without attempting an overflowing float conversion. The safety CI job has a ten-minute timeout and does not persist checkout credentials.

Independent review found that invalid JSON/oversized HTTP-200 reads could appear absent; the correction retains HTTP status and emits a sanitized decode-failure receipt. A socket inactivity timeout also proved insufficient for the elapsed deadline, prompting the POSIX alarm correction. A subsequent hosted review reproduced `http.client.IncompleteRead` escaping the response reader and preventing the report from being emitted. HTTP protocol/read failures now produce a sanitized `http_protocol_error` receipt, preserving earlier observations and the actual HTTP status when available. The eleventh regression and the preceding ten tests passed on both Windows and Linux, with matching source/test SHA256 hashes. Source/test/docs guards cover these fixes. No production capability probe has run as part of this work.

At authoring time, the official Meta Page/Threads/Instagram insights documentation endpoints returned HTTP 429. Search results from third-party sites were not used to assert current metric support. B2/B5 remain open until approved live evidence and the unresolved semantics are reviewed.
