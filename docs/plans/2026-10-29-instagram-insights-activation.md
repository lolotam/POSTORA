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

Credential mode also changes `facebook-oauth`, `instagram-business-oauth`, `refresh-tokens` and the other credential readers for **every** user. The protected tables are empty. The main plan prescribes a revalidated backfill of the old credentials, fenced against reconnect (§10 credential-cutover subtask: "copy/revalidate old credentials without exposing values"; §13 activation prerequisites). §10 R3.1 forbids only backfilling *scope* state to a trusted `ok`, not credentials. That backfill has not been built, so today an existing account has no protected credential until it either reconnects or is revalidated by that backfill once it exists. Until it does, the readers return typed reconnect/capability errors.

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

**Consequence: the global flip is never used.** It would silently stop refresh for all 52 accounts and protect none of them; posting would then fail one account at a time as each token reaches `token_expires_at`.

**Since #298 (`b89fd08d`, on `main`) a per-account cutover exists** (`_shared/protectedAccountCutover.ts`). The global mode stays `legacy`:

- an account runs protected once it holds a protected authority owned by the same user; every other account stays legacy;
- a user listed in `credential_facebook_user_protected_pilot_user_ids` starts OAuth `authorize` on the protected branch (`facebook-oauth/protectedPageConnect.ts`), which is how an account gets that authority.

**Collection is not covered by it.** `instagram-insights-sync` still refuses unless the **global** mode is `protected` (`handler.ts`, `protected_credentials_required`), and `collection_instagram_insights_enabled` is one global setting. Collection therefore stays blocked until a reviewed, server-enforced per-account collection eligibility mechanism exists (the D1 prerequisite in `docs/specs/2026-10-30-instagram-release-gates.md`, added by PR #309).

## 3. Gates (each needs Waleed's explicit approval)

### Gate A: rehearsal (done, 2026-10-29)

- **Done:** the SQL suites passed on a restored production copy before the migrations, and the §2 question was answered from the edge code on `main` at `d4e12ed6`, with the protected-path tests it cites.
- **Not done:** a production-copy run of the protected OAuth, refresh, publishing and report edge suites. The decisive behaviour is in the edge code and its tests, so it was skipped; it is not claimed.
- **Not covered:** the analysis predates the #298 per-account cutover (`b89fd08d`). Gate A answers why the **global** flip is unsafe; it does not verify the per-account path Gate B runs. That rehearsal is Gate B's step 1.

### Gate B: one pilot account on the per-account cutover, collection still off

The global `credential_facebook_user_mode` stays `legacy` throughout; it is never set to `protected`.

1. **Rehearse the #298 cutover first**, on a restored production copy at the exact commit that will run: the pilot reconnect creates a protected authority, protected refresh succeeds for that one account, and refresh for a non-pilot account is unchanged (`accountCredentialMode` keeps it legacy). Gate B does not start until this passes.
2. Fresh backup, as in the PR #294 rollout: `pg_dump -Fc` plus globals, with the TOC checked.
3. The pilot list is **per user**, not per account: every Meta `authorize` that user starts takes the protected branch. So use a dedicated test owner whose only active Meta account is the test account (check the count of that user's active Facebook and Instagram accounts is exactly 1 before and during the gate), and connect no other Meta account for that user until Gate B ends. Then add that owner's **user UUID** to `credential_facebook_user_protected_pilot_user_ids`.
4. That owner reconnects the **one** test-owned Instagram account. Verify a protected authority row exists for it, a refresh succeeds and a post publishes.
5. Watch for 24 hours with **direct** checks, because the usual signals stay quiet here (§2):
   - the count of Meta accounts whose last refresh outcome is `unsupported` or `page_binding_missing`, or whose last successful refresh is older than the expected interval: it must stay at its pre-change value;
   - only the pilot account holds a protected authority;
   - `platform_posts` failures by platform, and edge logs.
6. **Rollback:** remove the UUID from the pilot list. This stops new protected attempts; it does **not** downgrade the already protected account, which keeps working on its protected authority. While it is off the list, a new `authorize` for that owner starts on the legacy branch, so it **cannot repair** the protected credential. If that credential is revoked or needs reauthorization after rollback, re-add the owner to the pilot list for that reconnect only, then remove them again. No downgrade path exists to move the account back to legacy; building one (restore a usable legacy credential, then remove the authority atomically) is a separate change.

### Gate C: owner collection for the test account (blocked)

**Blocked** until the per-account collection eligibility mechanism (§2) is reviewed, tested and deployed. Today `collection_instagram_insights_enabled` opens enqueue for **every** authenticated user, the `drain` takes no target and claims whatever is due (owner batch 25), and the handler refuses anyway while the global mode is `legacy`.

Once the prerequisite is in place:

1. Enable collection for the test account only, through that mechanism.
2. Trigger one owner sync from `/analytics/instagram` (`enqueue`). **Before** calling the service `drain` by hand, check that the only due job is the test account's.
3. Verify: one job claimed (lease 120 s); snapshots written; the job completes or stays partial for the right reason; no repeated re-claim loop (`partial` comes due again after 1 minute, so watch several minutes); the report renders in the browser; other accounts saw zero provider calls.
4. Live Meta verification: compare a sample of daily metrics with what Instagram itself shows.
5. **Rollback:** turn the test account's eligibility off, and keep `collection_instagram_insights_enabled = false`. Every collection path then refuses before reading jobs or credentials.

### Gate D: daily collection (blocked)

**Blocked** on a daily enqueue mechanism. The handler exposes only a user `enqueue`, `status` and a target-less `drain`; nothing creates the daily owner jobs (00:30 UTC) that the main plan (§5.3) requires. A scheduled drain alone would only process jobs users trigger by hand. The mechanism is specified in `docs/specs/2026-10-30-instagram-collection-rollout-controls.md` (durable daily dispatch, added by PR #310); it is not implemented.

Once it exists:

1. Add the daily enqueue job and one `pg_cron` drain job calling `instagram-insights-sync` with `{"action":"drain"}`, every 5 minutes to start. The key comes from the existing vault/cron pattern used by the other workers, never inline.
2. Watch for 24 hours: jobs created per day, claims per tick, partial/rate-limited counts, Meta throttle buckets, edge latency.
3. **Rollback:** unschedule both jobs. The setting from Gate C stays as it is.

### Gate E: competitors (milestone 3 scope)

Only after Gate D has been stable: `competitor-snapshot-sync` scheduling, with the approved quotas in §12 of the main plan. It gets a separate approval.

## 4. Release-readiness evidence still missing (milestone 4)

- Live Meta verification (Gate C.4).
- Browser journeys for `/analytics/instagram`: connect, sync, report, empty and error states. Arabic and English.
- The per-account collection eligibility mechanism and the daily enqueue (Gates C and D).

## 5. Backups and server artifacts

| Path on Contabo | What |
|---|---|
| `/root/backups/postora-pre-ig-insights-20261029-145908/` | First pre-rollout dump + globals (52 MB); directory mode is 755, files 600 |
| `/root/backups/postora-pre-ig-migrate-20261029-150828/` | Dump taken right before the production migrations (53.8 MB, 3589 TOC entries, sha256 prefix `5fc05dbd5d711ac6`); mode 700/600 |
| `/root/backups/ig-src/` | Shallow source clone at `ca7a367` used for the migrations (333 MB). Safe to delete |
| `/root/backups/ig-full.log`, `ig-prod-migrate.log`, `ig-deploy-diff.*`, `LATEST-ig-migrate-backup` | Rehearsal, migration and deploy-verification logs |
| `/root/backups/mig.sh`, `ig-src-clone.log` | Helper script and clone log. Safe to delete |
