# Activation plan: Instagram insights collection (after PR #294)

**Status: plan only. Nothing in this document has been executed.** Waleed decides if and when activation starts, and approves each gate below separately. This plan follows milestone 4 of `docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md` §14: release readiness, not automatic release.

## 1. Production state on 2026-10-29 (verified, read-only)

| Item | State |
|---|---|
| Code | PR #294 squash-merged as `7f354eae`; hosted CI on `main` green |
| Edge functions | `7f354eae` deployed by the Dokploy schedule; volume byte-identical to git (only the server-only `main` router differs); no `postora-edge-deploy.failed`, no `postora-edge-deploy.paused` |
| Migrations | All 11 applied (`20261026120000` … `20261029160000`) as `supabase_admin`, with `lock_timeout=10s` |
| `credential_facebook_user_mode` | **absent** from `app_settings`, which means `legacy` |
| `collection_instagram_insights_enabled` | **absent**, which means off; `instagram-insights-sync` and `competitor-snapshot-sync` answer 503 `collection_disabled` |
| Cron | no job calls `instagram-insights-sync` or `competitor-snapshot-sync` |
| Protected credential tables | `facebook_user_credentials`, `facebook_user_credential_bindings`, `instagram_account_credentials`, `instagram_account_capabilities`, `instagram_collection_jobs`: **0 rows each** |
| Active accounts | 28 Instagram, 24 Facebook |

## 2. Why this is not a per-account switch

The drain and the owner intake refuse unless **both** global settings hold (`instagram-insights-sync/handler.ts`):

1. `collection_instagram_insights_enabled = true`, otherwise 503 `collection_disabled`;
2. `credential_facebook_user_mode = protected`, otherwise 503 `protected_credentials_required`.

Credential mode also changes `facebook-oauth`, `instagram-business-oauth`, `refresh-tokens` and the other credential readers for **every** user. The protected tables are empty and the plan forbids a trusted backfill (§10 R3.1), so after the cutover an existing account has no protected credential until it reconnects. Until it does, the readers return typed reconnect/capability errors.

**Open question that must be answered before Gate B:** in protected mode, does an account that has not reconnected keep **posting** through `process-post` and keep being refreshed by `refresh-tokens`? If not, the cutover is an outage for all 52 accounts until each one reconnects. Answer it by reading the code paths and rehearsing on a restored copy (Gate A), not by assuming.

**Answer (Gate A, 2026-10-29, code on `main` at `d4e12ed6`):**

- **Posting continues at first.** `process-post` never reads the credential mode or the protected tables. It keeps using `social_accounts.access_token`.
- **Refresh stops for every Meta account that has not reconnected.**
  - A direct Instagram account with no capability row returns `unsupported` before any capture (`protectedMetaRefresh.ts`).
  - A Facebook Page with no protected binding returns `page_binding_missing` (`protectedPageReconciliation.ts`).
  - The legacy path is never tried for them (`refreshSingleAccount` backstop).
  - The tests prove this: `protectedDirectRefresh.test.ts`, "an account without a capability row is refused before any capture" and "a facebook account never reaches the direct branch". `protectedPageReconciliation.test.ts`, "a missing protected binding refuses before the provider".
- **The expiry is silent.** In protected mode, Facebook and Instagram accounts are left out of the health population and the admin health alert (`refresh-tokens/index.ts`, health check).
- **Production exposure** (read-only count, no token values read):

  | | Accounts | Already expired | Expiring in < 14 days | Expiring in 14–60 days | Expiry > 60 days | `needs_reauth` |
  |---|---|---|---|---|---|---|
  | Facebook | 24 | 4 | 1 | 19 | 0 | 4 |
  | Instagram | 28 | 6 | 2 | 20 | 0 | 6 |

  Every active Meta token expires within 60 days, so every one depends on refresh.
- **The legacy OAuth callbacks refuse in protected mode.** An OAuth flow that is in progress at the moment of the flip fails, and the user has to start again.

**Consequence: Gate B as written is not safe.** A global flip would silently stop refresh for all 52 accounts and protect none of them. Posting would then fail one account at a time as each token reaches `token_expires_at`. Before any production change, one of these is needed:

1. A per-account cutover, where an account runs protected only once it holds a protected credential. This needs code.
2. Every Meta account reconnects through the protected flow first. **This is impossible today without code.** In legacy mode, `continueOAuthRequest` (`facebook-oauth/protectedPageConnect.ts`) sends `authorize` to the legacy branch, because no attempt exists yet. So no protected attempt is ever begun, and a reconnect writes legacy metadata only. The protected path is reachable only once the global mode is already `protected`.
3. Activation stays deferred.

The SQL suites already passed on a restored production copy before the migrations. The decisive behaviour is in the edge code, not the schema, so a second restore was not needed to answer this.

## 3. Gates (each needs Waleed's explicit approval)

### Gate A: rehearsal on a production copy (no production change)

1. Restore the latest dump into a throwaway `supabase/postgres:17.6.1.138` container. Before `pg_restore`, revoke the public-schema default privileges for both `supabase_admin` and `postgres`. Without that, the restore leaves anon/authenticated grants that production does not have.
2. Set `credential_facebook_user_mode=protected` on the copy only. Against the copy, run the protected OAuth, refresh, publishing and report suites, and trace what `process-post` and `refresh-tokens` do for an account with legacy-only credentials.
3. Write the answer to the open question in §2 into this document. If posting breaks for non-reconnected accounts, stop and redesign before any production change (for example, a per-account cutover).

### Gate B: credential cutover on production, collection still off

1. Fresh backup, as in the PR #294 rollout: `pg_dump -Fc` plus globals, with the TOC checked.
2. Pick a quiet window with no scheduled posts within ±15 minutes.
3. Upsert `credential_facebook_user_mode = protected`.
4. Reconnect **one** test-owned Instagram account through the protected OAuth flow. Verify a protected credential row exists, a refresh succeeds and a post publishes.
5. Watch for 24 hours: `refresh-tokens` failures, `needs_reauth` counts, `platform_posts` failures by platform, edge logs.
6. **Rollback:** upsert `credential_facebook_user_mode = legacy` (legacy branches before any new-schema access). Data written to the protected tables stays and is ignored.

### Gate C: owner collection for the test account

1. Upsert `collection_instagram_insights_enabled = true`.
2. Trigger one owner sync from `/analytics/instagram` for the test account (`enqueue`), then call the service `drain` by hand once.
3. Verify: one job claimed (owner batch 25, lease 120 s); snapshots written; the job completes or stays partial for the right reason; no repeated re-claim loop (`partial` comes due again after 1 minute, so watch several minutes); the report renders in the browser.
4. Live Meta verification: compare a sample of daily metrics with what Instagram itself shows.
5. **Rollback:** upsert `collection_instagram_insights_enabled = false`. Every collection path then refuses before reading jobs or credentials.

### Gate D: scheduled drain

1. Add one `pg_cron` job that calls `instagram-insights-sync` with `{"action":"drain"}` and the service key, every 5 minutes to start. The key comes from the existing vault/cron pattern used by the other workers, never inline.
2. Watch for 24 hours: claims per tick, partial/rate-limited counts, Meta throttle buckets, edge latency.
3. **Rollback:** unschedule the job. The setting from Gate C stays as it is.

### Gate E: competitors (milestone 3 scope)

Only after Gate D has been stable: `competitor-snapshot-sync` scheduling, with the approved quotas in §12 of the main plan. It gets a separate approval.

## 4. Release-readiness evidence still missing (milestone 4)

- Live Meta verification (Gate C.4).
- Browser journeys for `/analytics/instagram`: connect, sync, report, empty and error states. Arabic and English.
- The answer to the §2 posting question.

## 5. Backups and server artifacts

| Path on Contabo | What |
|---|---|
| `/root/backups/postora-pre-ig-insights-20261029-145908/` | First pre-rollout dump + globals (52 MB); directory mode is 755, files 600 |
| `/root/backups/postora-pre-ig-migrate-20261029-150828/` | Dump taken right before the production migrations (53.8 MB, 3589 TOC entries, sha256 prefix `5fc05dbd5d711ac6`); mode 700/600 |
| `/root/backups/ig-src/` | Shallow source clone at `ca7a367` used for the migrations (333 MB). Safe to delete |
| `/root/backups/ig-full.log`, `ig-prod-migrate.log`, `ig-deploy-diff.*`, `LATEST-ig-migrate-backup` | Rehearsal, migration and deploy-verification logs |
| `/root/backups/mig.sh`, `ig-src-clone.log` | Helper script and clone log. Safe to delete |
