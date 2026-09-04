# Runbook — YouTube comments rollout

Spec: `docs/superpowers/specs/2026-09-04-youtube-comments-design.md`. Order matters: the frontend auto-deploys on merge, the migration and the edge functions are applied by hand, and the feature is a visibility flag so nothing shows until step 5.

## 1. Apply the migration (before merging)

Via `ssh-contabo-mcp`, with the migration file copied to the host:

```bash
docker exec -i postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260904150000_youtube_comments.sql
```

Verify:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.comment_workflow_rules'::regclass
   and conname in ('comment_workflow_rules_platform_check', 'cwr_threads_has_no_dm', 'cwr_youtube_has_no_dm');
select jobname, schedule from cron.job where jobname = 'poll-youtube-comments';
select key, value from app_settings where key = 'feature_youtube_comments';
```

Expected: three constraints, the platform one listing `youtube`; one job at `*/5 * * * *`; the flag at `false`.

## 2. Merge the PR

Frontend deploys automatically (Dokploy). The tile stays hidden: `youtubeComments` is a visibility flag, so even admins do not see it until step 5.

## 3. Verify the edge-function deploy

The merge triggers `.github/workflows/deploy-edge-functions.yml`, which fetches `main` into `/root/postora-runtime`, rsyncs `supabase/functions/` into the functions volume (new directories included) and runs `docker compose restart functions`. Watch that run go green, then confirm on the host:

```bash
ls /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/youtube-poll-comments/
cd /root/postora-runtime && git log --oneline -1
```

If the workflow is blocked (GitHub Actions billing has blocked it before), follow `docs/runbooks/deploy-edge-function.md` by hand: fetch `main` in the runtime checkout, rsync, verify SHA256 per file, `docker compose restart functions`. Never `npx supabase functions deploy`, never `up -d`. Between steps 1 and 3 the cron job 404s every five minutes (visible in `net._http_response`); harmless, so keep the two steps close together.

## 4. Refresh the existing Composio YouTube connection

The connection's `tool_schema_cache` was frozen at activation and does not carry the comment tools. As the connection's owner (signed in), call:

```
POST https://api.postora.cloud/functions/v1/composio-connect/refresh-schema
{ "connection_id": "<connector_connections.id>" }
```

or reconnect the channel through the Composio option on Profiles.

## 5. Enable the flag

Admin → Settings → set `feature_youtube_comments` to `true` (or `update app_settings set value='true'::jsonb where key='feature_youtube_comments'`).

## 6. Reconnect a native channel

Profiles → YouTube → Connect Another YouTube Account (or reconnect the existing one). The Google consent lists three scopes. Verify:

```sql
select platform_username, account_metadata->'granted_scopes' from social_accounts
 where platform = 'youtube' and auth_provider = 'native' order by updated_at desc limit 3;
```

## 7. First poll seeds, second poll dispatches

```bash
curl -s -X POST https://api.postora.cloud/functions/v1/youtube-poll-comments \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected on the first call: `polled ≥ 1`, `dispatched 0` (history recorded without firing). Set the channel's comment handler on the Comment Manager tile (Off → Postora AI Agent or n8n) first, or `polled` is 0 — handler-off channels are not read.

```sql
select platform, count(*) from social_inbox_events where platform = 'youtube' group by 1;
```

Post a fresh comment on one of the channel's videos, wait for the next 5-minute tick (or call again): `dispatched 1`, and a `comment_workflow_events` row if a funnel rule matched.

Caveat: the "first pass seeds" rule keys on whether the channel already has inbox rows. A channel with **no comments at all** when it is enabled will have its first-ever comment seeded, not dispatched (same as the Threads poller); verify on a channel that already has comments, or post one before enabling the handler.

## 8. Live checks

- `/comments` → YouTube tile → the Composio channel lists comments grouped by video; an un-reconnected native channel shows the reconnect banner.
- Reply from the Comment Manager → the reply appears on YouTube.
- `/automation/agents?platform=youtube` shows Comments only.
- `/automation/comment-workflow` → Create → YouTube tile reads "N channels connected".

## 9. Record the verification demo

Test user signs in → Profiles → Connect YouTube → consent shows the three scopes → `/comments` YouTube tile lists comments → reply → the reply is visible on YouTube. Composio is not part of the recording.

## Known limits

- The sweep reads the newest 50 threads per channel per run and only the ≤5 replies YouTube inlines per thread; a new reply on an older thread is visible in the Comment Manager but is not ingested.
- Quota: 1 unit per poll per channel (≈288/channel/day at 5 min), 2 per Comment Manager read, 50 per reply/moderation/delete, against Google's 10,000/day default. `quotaExceeded` skips the channel for that run and never touches health columns.
