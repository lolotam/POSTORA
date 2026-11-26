# YouTube Analytics rollout runbook

Stage 5 is dark by default. The specification and release gates are in `docs/specs/2026-11-24-youtube-stage5-analytics.md` and `docs/plans/2026-11-24-youtube-stage5-analytics.md`. Production changes require Waleed's approval at each checkpoint. This runbook does not authorize a migration, probe, policy change, or deployment.

## Switches and access rules

| Control | Purpose | Default |
| --- | --- | --- |
| `youtube_analytics_stage5_rollout` in `app_settings` | The access switch. Controls whether `youtube-analytics` may release credentials and call Google for an account. | Absent means off for every account. |
| `feature_analytics_youtube` in `app_settings` | The visibility switch. Controls `/analytics/youtube`, its sidebar item, and video links. It is not an authorization check. | Off, including for admins. |
| Owner acceptance in the product | Per-owner, per-channel acceptance of the current Analytics Purpose Clause. | No acceptance means no analytics read. |
| `youtube_analytics_stage5_scope_gate` | Branch B only. Controls whether OAuth asks selected owners for `yt-analytics.readonly`. | Absent means off. |

Listing a channel only offers analytics. Its owner must accept in the product before any read. Nobody can accept on the owner's behalf. Turning the visibility flag off does not stop direct endpoint access; use the rollout policy to contain access.

## Policy examples

Off, and also the recommended containment state:

```json
{ "version": 1, "mode": "off", "account_ids": [] }
```

One probe or pilot account:

```json
{
  "version": 1,
  "mode": "allowlist",
  "account_ids": ["00000000-0000-4000-8000-000000000001"]
}
```

All accounts, only after the separate quota review and approval:

```json
{ "version": 1, "mode": "all", "account_ids": [] }
```

Branch B uses a separate scope-gate document:

```json
{ "version": 1, "mode": "users", "user_ids": ["00000000-0000-4000-8000-000000000002"] }
```

or, after Google's approval and the rollout review:

```json
{ "version": 1, "mode": "all", "user_ids": [] }
```

Rollout `all` is not admitted while the branch B scope gate is not `all`. Closing the scope gate changes future OAuth requests; it does not revoke grants already made.

## Migration and predeployment verification

1. Confirm CI and required reviews are green on the exact head. Record the migration's SHA-256 and object list and obtain the owner's merge/migration card.
2. Take a production database snapshot and keep its receipt.
3. Apply the Stage 5 migration as `supabase_admin` before merging the code that calls it. Do not edit an already-applied migration.
4. Verify the objects and privileges:
   - `social_accounts.binding_incarnation` and its trigger exist.
   - The rollout RESTRICTIVE policy names exactly `youtube_analytics_stage5_rollout` and `youtube_analytics_stage5_scope_gate`, with both `USING` and `WITH CHECK`.
   - `youtube_analytics_purpose_consents` exists, is empty, has RLS enabled and no policies, and no role holds table privileges.
   - Every new decision/consent/lease/store function is `SECURITY DEFINER`, has the pinned `search_path`, and is executable only by its intended service role. The parser is executable by nobody.
   - The narrow `youtube_stage4_refresh` role still owns exactly its three Stage 4 functions.
   - Neither rollout key was seeded.
   - Non-admin settings visibility and admin settings writes are unchanged, including renames into and out of the protected keys.
5. Check `decide` with synthetic records: an unknown account returns `not_found`; an owned account with no policy returns `not_enabled`; an owned account admitted by a synthetic policy returns `consent_required` until its owner accepts.
6. Run the complete disposable-database SQL suite, including the two-session binding and withdrawal interleavings. Do not treat a suite on disk as run unless it is registered in `scripts/db-harness.sh`.

## Deployment checkpoint

1. Merge only after the migration verification and owner approval.
2. Confirm the frontend deployment serves the merge commit.
3. Confirm the Edge Functions Sync schedule ran for that commit and did not park it, following `docs/runbooks/deploy-edge-function.md`.
4. Compare SHA-256 for every synced `youtube-analytics` file with `git show <merge>:<path>`. Include `youtube-oauth` only for branch B.
5. On the deployed route, smoke-test `status` with an authenticated owner:
   - a random account ID returns `not_found`;
   - an owned, ineligible account returns `not_enabled`;
   - every response has `Cache-Control: no-store`.
6. With the policy absent, verify dark behavior: no page or sidebar link, unchanged connect scopes, unchanged existing settings and responses, no acceptance rows, and the corrected disclosure/privacy text live.

## Owner acceptance and withdrawal

1. Add only the intended account to the rollout policy, then enable `feature_analytics_youtube`.
2. The owner opens `/analytics/youtube`, selects the channel, reads the eight purpose elements, and chooses either equal-weight button.
3. `Not now` writes no event and reads no analytics. `Allow analytics for this channel` records the displayed purpose version and locale, then status and reports load.
4. While accepted, `Analytics permission` → `Stop using analytics for this channel` opens one confirmation. Confirming removes reports immediately, records a withdrawal, and shows the acceptance panel again. The channel, publishing, comments, and Google grants are unaffected.
5. Disconnecting is not withdrawing. Acceptance is keyed by owner and channel and survives reconnect; another owner has a separate acceptance state.

## Gates G-P1 and G-B

**G-P1 blocks every account except the probe account.** The first policy entry is Waleed's probe channel only. Do not add another account until P1-a has a recorded conclusion and the deployed `YOUTUBE_ANALYTICS_REQUIRED_SCOPES` equals that conclusion. A different conclusion requires a reviewed code change first.

**G-B applies only to branch B and is per connection.** Before each account is added to the rollout, check under approval that a token minted from that account's stored refresh token carries `yt-analytics.readonly`. Never record the token, response body, channel name, or metrics. Closing the scope gate later does not remove an existing grant.

## P1 procedure

Each part requires its own approval immediately before execution. P1-a additionally requires deployed code, a policy containing only Waleed's probe channel, and his in-app acceptance.

1. Use the approved isolated OAuth client for P1-i/P1-b/P1-c, or the bound production path for P1-a.
2. Record the effective scopes using Google's token-information endpoint with the access token in an Authorization header. Never put a token in a URL, log, chat, file, or recorded header set.
3. Send the four documented read-only report shapes over one seven-day window: channel summary, daily, top videos, and one-video summary.
4. Classify each as `ok`, `insufficient_permission`, `api_not_enabled`, `quota`, `unauthorized`, `unsupported_query`, `server_error`, `timeout`, or `unrecognised`. Any unexpected shape is inconclusive; do not retry automatically.
5. For P1-c, compare identical requests on the same channel and client with the existing three scopes, then those scopes plus `yt-analytics.readonly`.
6. Record only the part/date, HTTP statuses, effective scope list, classifications, and on success header names and row counts. Record no provider text, response body, channel name, token, or numbers.
7. Record G-P1 before any further enablement. Branch B additionally records G-B per account.

## Further enablement

- Add further pilot accounts one approval at a time. Each owner still accepts or declines in the product.
- Before `mode: "all"`, read both Google API limits and existing Data API feature peaks in Cloud Console, review the Stage 5 ceilings and headroom, and obtain separate approval.
- Branch B requires scope-gate `all` before rollout `all`, each separately approved, and Google's required verification first.

## Raising the purpose version

A material change to what is read, why, who sees it, or whether it is stored requires one coordinated change:

1. Update English and Arabic panel strings and the public disclosure/privacy clauses.
2. Increment `ANALYTICS_PURPOSE_VERSION` in the canonical contract and update the clause date.
3. Update the purpose-version guard test and obtain wording approval.
4. Deploy together. Existing acceptances become `outdated`; reports stay disabled until each owner accepts the new text.

Editorial changes with no meaning change do not automatically require a version increase; Waleed decides that classification.

## Incident containment

Triggers include wrong-channel or stale-connection numbers, analytics changing account health/grants, quota pressure on publishing/comments, failures appearing as empty reports, another setting becoming unreadable, or an existing response changing.

1. Set `youtube_analytics_stage5_rollout` to `off` or remove the key. Running instances refuse subsequent attempts before credentials or Google calls.
2. Do not rely on the feature flag for containment. Open pages lose reports at the next status check or lease expiry. An already-authorized attempt and a response whose final check just passed cannot be recalled; an in-flight refresh may still store its token as designed.
3. For a wrong-channel display requiring an immediate presentation cut, revert the frontend deployment.
4. If the RESTRICTIVE policy itself broke other settings, remove the rollout key and, only with Waleed's approval, drop `app_settings_youtube_stage5_rollout_private`. The existing settings allow-list then applies.

## Recovery and code rollback

1. Keep the policy off while investigating. Use `system_logs` rows with source `youtube-analytics` to scope accounts and operations. These rows are best-effort and contain no analytics values.
2. Establish the cause before re-enabling. Waleed decides owner communications.
3. For code rollback, revert the feature commits and verify frontend/function synchronization. There are no stored analytics values to delete.
4. Do not roll back the migration as part of code rollback. Inert schema and acceptance rows remain; acceptance rows are owners' records, not analytics data. Removing them requires a separate migration, snapshot, and approval.
5. Keep the corrected three-scope disclosure. Analytics wording stays accurate while the feature exists but is policy-off. Branch B keeps the fourth-scope disclosure while any corresponding grant can exist.

## R1 rehearsal

Run only on the pilot channel after first acceptance, with separate approval and no induced failures or YouTube writes.

1. Open the page and select one period. Confirm overview, daily trend, and top videos load and share the pinned Pacific window.
2. Record the requested window, last returned day, and provider request counts.
3. Open one owned video and confirm its summary/trend and isolated not-found behavior with a synthetic unowned ID only if the approved fixture supports it.
4. Ask the owner to compare the same period with YouTube Studio and record only yes/no.
5. Record blocks loaded, requested window, last returned day, counts, and Studio comparison. Record no metric values, provider text, tokens, or channel name.
