# Threads webhook: verify token + field subscription

**Symptom this fixes:** Facebook and Instagram comment automation works, Threads does not.
The n8n Comment Trigger never fires for Threads, and the Postora UI shows no Threads
activity, because `threads-webhook` receives nothing.

## How to confirm you have this problem

Threads has *never* delivered an event if both of these come back empty:

```sql
select * from social_inbox_events where platform = 'threads';
select * from threads_mentions where source = 'webhook';
```

Then check the function's own log. `verify failed` on a GET means the Meta App Dashboard
tried to verify the callback and Postora rejected it:

```bash
docker logs postorasupabase-supabase-j8axyh-supabase-edge-functions --since 72h 2>&1 \
  | grep threads-webhook
```

## Required environment variable

`threads-webhook` needs **`THREADS_WEBHOOK_VERIFY_TOKEN`**, which is separate from the
Messenger/Instagram one (`META_MESSAGING_WEBHOOK_VERIFY_TOKEN`) and from
`THREADS_APP_SECRET`. When it is unset, the `hub.challenge` branch can never match, so the
callback cannot be verified — and Meta delivers no `replies` and no `mentions` at all.

Dokploy regenerates the stack's `.env` from its own database on every deploy, so setting it
in only one place does not survive a redeploy. Set it in both:

```bash
TOKEN=$(openssl rand -hex 24)
DIR=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code

docker exec dokploy-postgres.1.<id> psql -U dokploy -d dokploy -c \
  "update compose set env = env || E'\nTHREADS_WEBHOOK_VERIFY_TOKEN=$TOKEN' \
   where \"appName\" = 'postorasupabase-supabase-j8axyh';"
printf '\nTHREADS_WEBHOOK_VERIFY_TOKEN=%s\n' "$TOKEN" >> "$DIR/.env"

cd "$DIR" && docker compose up -d --no-deps functions
```

Confirm before touching the Meta dashboard — this must echo the challenge back:

```bash
curl 'https://api.postora.cloud/functions/v1/threads-webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=12345'
# => 12345
```

## Meta App Dashboard (manual, cannot be automated)

Threads use case → Webhooks:

- Callback URL: `https://api.postora.cloud/functions/v1/threads-webhook`
- Verify token: the value set above
- Subscribe **`replies`** and **`mentions`**

`replies` is the field that carries comments on your own Threads posts. `mentions` is
subscribed too because `threads-webhook` feeds mentions into the same comment automation, so
it keeps working for accounts that only ever got the mentions field.

## Reading the rejection logs

A POST is rejected with one reason per line, and they need different fixes:

| Log line | Meaning |
|---|---|
| `rejected POST: missing-header` | Unsigned request. Internet noise, not Meta. Ignore. |
| `rejected POST: mismatch` | A signed delivery failed the HMAC — `THREADS_APP_SECRET` belongs to a different app. |
| `rejected POST: no-secret` | `THREADS_APP_SECRET` is unset. |
| `verify failed (verify_token configured: no)` | The variable above is missing. |

## End-to-end check

Reply to one of the account's Threads posts from a different account, then:

```sql
select platform, event_type, external_event_id, created_at
from social_inbox_events where platform = 'threads' order by created_at desc limit 5;
```

A row here means delivery works; the n8n Comment Trigger fires from the same path, gated by
`social_accounts.account_metadata->>'comment_automation_handler'` being `n8n` or `internal`.
