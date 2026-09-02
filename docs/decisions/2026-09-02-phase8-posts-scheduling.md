# Phase 8, first tranche — the posts surface and `post.scheduled`

**Date:** 2026-09-02
**Status:** implemented
**Owner decisions:** both approved 2026-09-02 (Decision A, Decision B below)
**Supersedes nothing.** Extends D6 (event families), D11 (account selection), D9 (publishing seam).

---

## What shipped, and what deliberately did not

| Spec §7 route | State |
|---|---|
| `POST /v1/posts` | shipped |
| `GET /v1/posts/{id}` | shipped |
| `GET /v1/posts/{id}/status` | shipped |
| `POST /v1/posts/{id}/schedule` | shipped |
| `DELETE /v1/posts/{id}/schedule` | shipped |
| `POST /v1/posts/{id}/publish` | **NOT shipped** |

`/publish` needs the 7.2/7.3 platform registry. The ten `postToX` bodies are still inside
`process-post/index.ts`, and D9 forbids both importing that entrypoint and bridging to it over
HTTP — so there is no permitted route from a `/v1` handler to a provider branch. Shipping
`/publish` today would mean building one of the two shapes D9 forbids, then deleting it.

A partner publishes by scheduling: `process-scheduled-posts` picks the row up and invokes
`process-post`, which is the same path the Postora UI uses.

---

## Decision A — addressability is an explicit binding, not an inferred tenant

**The problem.** `posts` predates workspaces. It carries `user_id` and nothing else. A partner key
is workspace-scoped (D3/D4), so `POST /v1/posts/{id}/schedule` had no `{id}` a partner could
legitimately name.

**Three options, and why the third won.**

1. **Add `workspace_id` to `posts` and backfill.** 1,300+ existing rows would need a backfill
   rule, and every rule is a *guess* about tenancy. A guessed tenant that reaches
   `partner_emit_webhook_event` is a cross-tenant delivery, and nothing downstream can detect one.
2. **Derive the workspace from the post's target accounts at read time.** Cheap, but it can
   return *two* answers for one post, and the natural resolution ("pick the first") is the guess
   from option 1 wearing a different hat.
3. **A binding table — `partner_api_posts`.** A row exists if and only if a partner key created
   the post. Presence *is* the grant.

Option 3 is the only one that cannot be **silently** wrong. Its failure mode is a post that `/v1`
refuses to serve; the other two can serve a post whose tenant was inferred.

**The consequence, stated plainly:** posts created in the Postora UI are **not addressable from
`/v1`**, permanently, by design. A partner cannot read, schedule or inspect them. This mirrors
`media_files`, where every pre-Phase-4 upload has `workspace_id NULL` and is unreachable from any
key without a policy having to say so, and it is the same fail-closed direction `v1/binding.ts`
argues for on the messaging side.

`partner_api_posts` is **workspace-scoped, not key-scoped** — unlike `partner_api_key_accounts`.
A key-scoped binding would mean that rotating a key orphans every post it created. `key_id` is
retained for audit only, `ON DELETE SET NULL`.

---

## Decision B — `post.scheduled` is produced by a database trigger

**The problem.** Schedule rows are created in **six browser code paths** (`usePosts.tsx`,
`useCanvasWorkflow.ts`, `BulkScheduler.tsx`, `Calendar.tsx`, `ScheduledPosts.tsx`,
`AdminUserDetail.tsx`) and nowhere on the server. An endpoint-only emitter would give a partner
events for `/v1`-scheduled posts and silence for every UI-scheduled one — partial producer
coverage, which D6 exists to prevent, and which is worse than no event because it looks like it
works.

**Why not the 7.5 shape.** Phase 7.5 would have needed a `SECURITY DEFINER` function callable by
`authenticated` — RLS-bypassing by definition, with its own body as the entire access-control
boundary — plus a refactor of all six frontend files. The owner deferred it for exactly that
reason.

**A trigger sidesteps the objection entirely.** It is not browser-callable, it exposes no new
surface to `authenticated`, and it touches no frontend file. It is also the mechanism this
codebase already names as correct for many-writer transitions — see the `account.connected` /
`account.disconnected` note in `_shared/partnerWebhookEvents.ts`, which says the right answer is
"a database trigger, not 24 hand-wired enqueues".

**The evidence that made it viable.** A trigger only achieves full coverage if a UI-scheduled post
can be attributed to a workspace *at schedule time*. Measured in production before building:

```
scheduled posts:  296 total | 296 with selected_account_ids | 296 non-empty
target accounts:  threads 4/4, instagram 3/3, facebook 1/1, pinterest 1/1
                  — every one resolves to a non-NULL workspace
```

Attribution works today for every scheduled post, on publishing platforms rather than only
WhatsApp.

**The caveat, not buried:** `social_accounts.workspace_id` is not universally populated
(instagram 18/24, threads 13/17, facebook 11/13, youtube 3/4 at time of writing), and
`process-scheduled-posts` tolerates a post with no `selected_account_ids` at all. Such a post
commits normally and emits nothing. **Unattributable is silent by design** — the alternative is a
guessed tenant, which Decision A already rejected.

### Attribution order

1. A `partner_api_posts` binding row — authoritative, used for every `/v1` post.
2. Otherwise every id in `metadata.selected_account_ids`, resolved through
   `partner_workspace_of_account`. All non-null resolutions must agree on **one** workspace.
3. Anything else — no binding, no resolvable account, or two workspaces — emits nothing.

### Occurrence identity

`post.scheduled:<post id>:<scheduled_at as UTC microsecond ISO>`.

- A reschedule to a **new** time is a new transition and a new occurrence.
- Rewriting the **same** time is not a transition (`IS NOT DISTINCT FROM` guard) and emits nothing.
- The timestamp is rendered explicitly in UTC via `to_char(... AT TIME ZONE 'UTC', ...)`. A bare
  `::text` follows the session timezone, which would make one transition two occurrences depending
  on who wrote it.
- **Schedule → unschedule → reschedule to the same time** deduplicates against the original. This
  is deliberate: the occurrence names the *state* "scheduled for T", and re-arriving at that state
  is the same fact. There is no `post.unscheduled` event to have made the round trip visible.

### Blast radius

This trigger runs inside **every** schedule write, the browser's included, and it deliberately does
not swallow exceptions — a transactional producer that catches its own failure is precisely the
silent loss D5 exists to prevent. A defect here therefore blocks scheduling for the whole product,
not just for partners.

That is why `supabase/tests/partner_posts.sql` exercises the UI-shaped write, the unattributable
write and the ambiguous write, not only the `/v1` happy path.

---

## Certification: `post.scheduled` only

`CERTIFIED_EVENT_TYPES` and the `partner_webhooks.events` CHECK were widened by exactly one value.

`post.published` / `post.failed` have had a live producer since Phase 7
(`partner_settle_platform_post`, deployed 2026-09-02) but stay **uncertified** until the seam has
settled at least one real publish in production — the owner's observation gate. The producer exists;
what has not yet been observed is the producer *firing*. Certifying an event whose producer has
never run in production is the implicit promise the allowlist exists to prevent.

Certifying them later is two edits and nothing else: the DB CHECK and the TypeScript constant, in
one commit.

---

## The cron contract

A `/v1`-scheduled post publishes only if its row matches `process-scheduled-posts`' pickup
predicate **exactly**:

```sql
status IN ('pending','scheduled') AND scheduled_at IS NOT NULL AND scheduled_at <= now()
```

So `partner_create_post` writes `status = 'scheduled'` with a non-null `scheduled_at`, and never any
other combination. `supabase/tests/partner_posts.sql` asserts a created row against that predicate
verbatim. An endpoint that returned 201 while writing an unmatchable row would look correct forever
and publish nothing — the failure shape this programme has now caught three times.

---

## Two constraints discovered while building

**The quota trigger charges a user, not a workspace.** `trg_enforce_post_quota_on_insert` raises
`POST_QUOTA_*` against `NEW.user_id`. Two consequences:

- `posts.user_id` must be a real owner, so all targets must share **one** owner. A workspace can
  hold accounts belonging to different members; mixed-owner targets would bill member A for member
  B's post. The route refuses them with `invalid_request`.
- The raised message is mapped to `quota_exceeded` (429) by its `POST_QUOTA_` prefix, matched on
  the message rather than on `SQLSTATE` — `posts_status_check` raises the same `check_violation`
  code, so the code alone would misreport a status defect as a quota refusal.

**The create is one RPC, not two client writes.** `partner_create_post` writes the `posts` row and
the binding row in one transaction. Two client-side inserts would leave a crash window in which the
post exists, is charged to quota, and is invisible to the partner — whose retry, its idempotency
claim never settled, creates and bills a second one.

Inside that function `scheduled_at` is set in a follow-up `UPDATE` rather than in the `INSERT`, so
the trigger always sees the binding row and attributes a `/v1` post by its authoritative row rather
than by the metadata fallback. Within one transaction the intermediate state is invisible.

---

## Two findings from review (Codex on PR #125), both verified before fixing

**Unscheduling raced the scheduler and lost.** `process-scheduled-posts` SELECTs due rows, refreshes
tokens, then invokes `process-post`, which wrote `status = 'processing'` with a bare `.eq("id")`.
An unschedule or reschedule landing in that window returned 200 and the post published anyway.
The scheduler now passes the `scheduled_at` it selected, and `process-post`'s transition is a
compare-and-set on it (`_shared/postProcessingClaim.ts`): a row that no longer carries that
instant matches nothing, `process-post` answers 409, and the scheduler records a skip. Status is
deliberately not part of the predicate — retrying a `failed` post through `process-post` is a
supported path.

**The create RPC trusted its caller.** `partner_create_post` wrote whatever workspace, key, account
and media ids it was handed, and the binding row it writes *is* the authorisation grant for every
`/v1/posts` route. It now refuses, with `foreign_key_violation`, any key outside the workspace, any
target account not owned by `p_user_id` in that workspace, and any media file outside it — and the
suite proves each refusal leaves no `posts` row behind.

Three smaller ones in the same round: malformed `selected_account_ids` (a scalar or object) made
`jsonb_array_elements_text` raise *inside the trigger*, rolling back the user's own schedule write —
now `jsonb_typeof`-gated and treated as unattributable; `Date.UTC` normalises Feb 30th and 24:00, so
timestamps are round-tripped through it and refused if they changed; and target bindings are queried
for the requested ids rather than through `boundAccountIds()`, whose 200-binding refusal would have
stopped a key creating posts for its first account once it bound a 201st.

## Migrations for the owner to apply

| File | Contents |
|---|---|
| `20260902150000_partner_api_posts.sql` | `partner_api_posts` table; events CHECK widened by `post.scheduled`; `partner_post_scheduled_emit` + its trigger on `posts`; `partner_create_post` |

Followed by `NOTIFY pgrst, 'reload schema';` — PostgREST answers from a cached schema and
`partner_create_post` is invisible to the edge function until it reloads.
