# Read-only Instagram Login capability observations

This companion to the [Facebook/Threads probe](./meta-owned-analytics-capability-probe.md) executes the direct-login portion of [completion plan B2](../plans/2026-11-01-meta-analytics-completion.md#b2-capability-probes). Its production consumer is the CLI in `scripts/probes/instagram_direct_analytics.py`. It imports the bounded HTTP transport from the adjacent `meta_owned_analytics.py`; copy both reviewed files together to the restricted server evidence directory and verify their SHA256 hashes before execution.

The operator records the owned active account before running the probe. This is read-only verification, not collection-pilot admission. The canonical credential is selected from `social_accounts.access_token` only where owner, account ID, `platform='instagram'`, active state and `ig_auth_type='business_login'` all match. This follows the direct writer in `supabase/functions/instagram-oauth/index.ts` and the credential reader in `20261029160000_instagram_direct_collection_credential.sql`. Page-linked accounts are refused. No credential RPC, collection job, token renewal, app-secret read or Facebook credential substitution occurs.

All requests use `graph.instagram.com/v22.0`. `/me` must return the exact canonical `platform_user_id` before permission, profile, account-insight or media requests begin. The messaging-scoped `user_id` alias never substitutes for this identity. Permission observations retain granted direct-business scopes only; a failed permission endpoint stays unverified even if insights requests succeed.

```sh
umask 077
python3 /tmp/reviewed-probe/instagram_direct_analytics.py \
  --owner "$APPROVED_OWNER_ID" --confirmed-account "$APPROVED_ACCOUNT_ID" \
  --version v22.0 > /tmp/reviewed-probe/instagram-private.json
```

The paths above are examples: use the actual mode-0700 evidence directory holding both reviewed scripts. POSIX request timers are required. The shared limits remain 48 calls, 120 seconds, five seconds per HTTP attempt, one MiB per body, no retries, no redirect following, and ten seconds per setup subprocess. Media pagination rebuilds at most two pages of two items from the fixed origin and opaque cursor; it never follows provider URLs. Invalid/missing continuation and repeated cursors prevent an end-of-list claim.

Account requests independently observe `reach`, `views`, `accounts_engaged`, and `total_interactions` with `period=day`, `metric_type=total_value`, and explicit 7/14/30/90-day UTC bounds. Those are probe candidate windows, not proof of provider-calendar alignment or retention. The profile observation reads `followers_count` and `media_count` at capture time; it cannot establish historical growth. The first listed media is independently probed for `views`, `reach`, `shares`, and `total_interactions`. All numeric values stay in the restricted private artifact; public journey records contain capability metadata and hashes only.

`execution: finished` indicates completion of the bounded observation run, including any individual failed requests. Identity or setup refusal and budget exhaustion return nonzero. The report deliberately keeps `capabilityVerification: incomplete`, unknown provider timezone, and unverified earliest retention/maximum window. No production database, permission, credential, post, collection control or schedule is changed.

Validation:

```sh
python3 -m unittest discover -s scripts/probes -p 'test_*.py' -v
python3 scripts/probes/check_meta_owned_analytics_sql.py \
  --container postora-owner-release-pg --database postora_owner_release_harness
```

The HTTP tests replace only network/database boundaries and exercise the real transport, identity gate, decoding and pagination. The actual SQL regression runs only in the guarded disposable harness; it proves the canonical direct lookup and refusal for foreign, inactive, Page-linked, wrong-platform and missing accounts. CI runs that checker against `pg-harness` / `partner_api_harness`, as documented in the companion runbook.
