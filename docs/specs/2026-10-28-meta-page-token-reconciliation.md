# Captured Page-token reconciliation for the owner Instagram flow

Status: contract approved for bounded local SQL implementation by consultations 38–39, after correcting the migration version. This is not implemented, deployed or enabled.

Parent authority: [Instagram implementation plan §13–14](../plans/2026-10-26-instagram-insights-and-competitor-tracking.md#14-user-approved-sequential-milestone-gates-2026-10-27). Accepted direct refresh `dd7257d2` is unchanged. This slice precedes the owner collector/report/UI and does not authorize competitor work.

## Goal and distinction

Reconcile one selected Page-linked Instagram account's, or Facebook Page account's, operational Page token using its **unchanged captured Facebook User grant**. Do not claim the User grant was renewed. When that grant needs renewal, use the accepted protected reconnect/OAuth procedure; unlimited server renewal of an already-long-lived User token is not established.

The accepted `page_token` capture returns no User secret. The accepted `facebook_user_token` success writer cannot update operational Page tokens. Neither post-HTTP recapture nor grant-only rotation solves that contract gap.

## Provider evidence

Official public references retrieved 2026-10-28, HTTP 200; raw snapshots and hashes: `E:/Dev/Temp/opencode/instagram-page-refresh-preparation-01/research.json`.

- [Long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/): valid User-token exchange, expired-grant reconnect, and Page-token derivation via User `/accounts`. SDK daily-refresh wording is not proof of an indefinite server renewal procedure.
- [Access token types](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/): User/Page tokens are distinct and may invalidate early.
- [Instagram with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started/): `/me/accounts` and Page `instagram_business_account` relationship verification.
- [Pages getting started](https://developers.facebook.com/docs/pages-api/getting-started/): Page IDs/tokens/tasks from the User account edge.

Current examples use v26.0; the implementation must retain configured `FACEBOOK_GRAPH_API_VERSION` and the existing v22.0 default. No live account or configured-version probe has occurred.

## Captured authority and atomic result

1. One owner-scoped explicit target per attempt. Reuse accepted `begin_meta_account_refresh` with `facebook_user_token`; only its captured User secret, subject, credential revision, full grant membership and explicit target may authorize HTTP or a result.
2. Add a distinct service-only `write_meta_page_reconciliation_success(p_user_id uuid, p_payload jsonb)` in a **new migration**. Do not edit accepted migrations or change their RPC signatures.
3. Payload is exactly `capture_id`, `operation: "page_reconciliation"`, and `fields`. Required fields are `access_token`, `facebook_page_id`, `instagram_user_id` and `token_expires_at`. For Instagram the IG ID is its captured canonical ID; for Facebook the Page ID is its captured canonical ID and IG ID must be explicit null. The initial slice requires expiry to be explicit null: unknown, not infinite. No refresh-token, User-token, scope, metadata, account-ID or caller health fields.
4. Validate original open owner capture, `facebook_user_token` operation and exactly one target. Lock owner, all captured members/target in accepted order, then credential. Require original membership, subject/revision, account identity/health/expiry, binding/fence and capability generations; require live active target and live active grant. Compare submitted provider identity against protected binding evidence, not metadata. Missing or contradictory Page-linked IG evidence refuses rather than bootstrapping it during refresh.
5. The service-only binding already stores `verified_facebook_user_id`, `verified_facebook_page_id`, `verified_instagram_user_id`. For IG, require submitted Page ID to equal the locked verified Page ID and submitted IG ID to equal both locked verified IG ID and captured canonical ID. For both platforms require locked binding User ID to equal the captured and locked credential subject. Facebook's null verified Page/IG columns are legitimate; its Page ID comes from captured canonical account identity. Original connection/revision/generation/membership fences plus locked evidence agreement cover supported lifecycle writers. Do not add a begin wrapper or change the capture projection. Arbitrary service-role identity changes without fence advancement are outside this guarantee; do not claim to detect their entire history.
6. Write only the selected account token/unknown expiry and accepted failure-evidence reset; preserve refresh token, `needs_reauth`, `is_active`, metadata and permission state. Advance the selected IG generation or Facebook connection fence exactly once. Preserve the User token/revision/expiry and **every** unselected sibling. Recheck capture liveness and any known captured User-grant expiry after potentially waiting operations; consume once in the same transaction. A late refusal rolls back all token/health/fence/capture effects. Do not compare original versions against the transaction's own legitimate advances. No successful replay.
7. Return only `capture_id`, `operation: "page_reconciliation"`, `applied: true`, `credential_id`, unchanged `credential_revision`, selected `credential_generation` (null for Facebook), `expiry_state: "unknown"`, and the existing nonsecret `account` state. A malformed/lost postwrite response is indeterminate, not rollback, and cannot invoke another writer or an alert.

## Bounded provider procedure

- Verify `/me?fields=id` against the captured User subject with the captured User token.
- Enumerate `/me/accounts` on the configured trusted host/version, requesting explicit Page ID/token fields. Only opaque cursor reconstruction is allowed; never fetch an arbitrary provider `next` URL.
- Facebook: select exact captured canonical Page ID, then verify the derived Page token by requesting that Page's identity.
- Instagram: verify Page identity and `instagram_business_account.id` with each necessary candidate's Page token; require exactly one proven match to the captured IG identity and protected binding's Page evidence. No username or browser metadata evidence.
- P2 may use a narrow service-side protected binding read tied to the same owner/credential/connection context to locate the exact Page. That permits stopping `/accounts` when that Page is found and verifying its exact relationship, rather than proving uniqueness across every unrelated Page. It does not authorize a new token-derivation endpoint. Finalize and test that read in P2; no new begin RPC belongs in P1.
- Initial finite limits: at most two listing pages of 25 entries, 50 total candidates, four relationship requests and six total HTTP requests; sequential calls, no retry. Each call gets at most 4 seconds and the remaining account budget, reserving at least 4 seconds for persistence/logging. All work must fit the existing 24-second account and 45-second sweep budget. Reaching a cap before proof is `incomplete`, never success or account-health evidence. These limits may defer large Page portfolios; they are not advertised as full coverage.
- Never infer token lifetime from its prefix, User expiry, request time plus a default, or the documentation's general long-lived label. The initial success intentionally replaces stale operational expiry with unknown SQL null. Do not describe that as infinite validity or User renewal.
- Missing material or locally known expired User grant produces reconnect-required/deferred without fabricated provider revocation evidence. Do not inherit the direct-token 24-hour minimum for Page derivation.

## Failure and compatibility

Use existing captured failure RPC only for positively classified evidence attributable to this selected target/grant; it owns counters, escalation, event and alert marker and consumes once. Unknown identity/mapping, incomplete enumeration, ambiguity, unrelated candidate failures and local budget exhaustion do not become target permission failures. No sibling-wide health change. Existing failure semantics are target/revision fenced; do not claim they validate every unrelated member mutation.

Keep strict admin/cron authorization, manual/bulk/sweep response compatibility and safe refusal history. Ordinary owners gain no direct refresh authority. Preserve direct refresh and legacy/unrelated-platform paths, including schema-free legacy dispatch. Keep protected User-only renewal unsupported outside reconnect; no grant-only rotation disguised as account refresh.

## Acceptance and rollout boundary

Independent real SQL verifies privileges, exact payload and identities, selected-only writes, User/sibling preservation, stale versions/membership, active state, live expiry after waits, competing consume/replay, reconnect/deletion and job-result fences. Existing full harness and suites remain required; maintained types must match final catalog. HTTP integration adds actual-handler, copied-root positive/broken negative, budget/mapping/cursor/redaction and indeterminate-write checks, then immutable full regressions.

No live Meta/browser proof is claimed from synthetic fixtures. Provider-version/permissions/pagination/derived-token usability and capture cleanup remain activation prerequisites. PR294 stays draft; legacy stays active; collection/schedules stay OFF. No new-work push, production migration, deployment, merge, cutover or activation is authorized here.
