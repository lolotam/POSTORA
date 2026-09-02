# D9 — the publishing seam: what 7.0 found, and what it changes

**Date:** 2026-09-02 · **Owner:** Partner API programme · **Deliverable:** Phase 7 (7.0, 7.4)
**Status:** 7.0 complete; 7.4 built. **7.2/7.3 deferred and 7.5 moved to Phase 8 — both ratified
by the owner on 2026-09-02.**

The plan calls Phase 7 "the riskiest work in the programme" and makes 7.0 an **entry criterion,
not a deliverable**. Doing it first changed the shape of the phase, which is what an entry
criterion is for.

---

## 1. The 7.0 inventory

Counted on `main` at 2026-09-02, excluding tests. Each row is re-derivable from the grep beside
it.

### Terminal `platform_posts` status — 5 commit points, all in one file

| Site | Shape | Writes |
|---|---|---|
| `process-post/index.ts:965` | `UPDATE` | `status: "success"` (the TikTok poll settling) |
| `process-post/index.ts:1001` | `UPDATE` | `status: "failed"` + `posts.status = failed` |
| `process-post/index.ts:1568` | `INSERT` | `status: resultStatus` — born terminal |
| `process-post/index.ts:1630` | `INSERT` | `status: "failed"` — born terminal, guarded by `selfWroteRows` |
| `process-post/index.ts:4365` | `INSERT` | `status` + `posted_at` — born terminal |

```
grep -rn --include=*.ts -A10 'from("platform_posts")' supabase/functions/ | grep -E '\.(update|insert|upsert)\('
```

**This is the good outcome**, and it is not what v1.1 assumed. v1.1 changed one invocation seam
and asserted atomicity for "whatever writes terminal status"; the inventory shows there are
**five** such writers — but all five are in `process-post/index.ts`, so 7.4's "one database
operation used by every writer" is achievable without touching another function.

Two shapes, not one, and the operation has to serve both: a row can be **updated** to terminal, or
**inserted already terminal**. An operation that only handled the update would silently miss three
of the five.

**Not writers, despite appearing in the grep:** `send-weekly-analytics/index.ts:310` and
`threads-delete-post/index.ts:63` both only `SELECT`. `process-scheduled-posts` does not reference
`platform_posts` at all — it invokes `process-post`.

**Outside the edge functions:** `src/hooks/useCanvasWorkflow.ts:248,258` inserts `platform_posts`
**from the browser** — but only `pending` / `processing`. It creates rows; it never terminalises
them, so it is not a `post.published` producer. It matters for 7.5, below.

### Schedule rows — created **only in the browser**

| File | Role |
|---|---|
| `src/hooks/usePosts.tsx` | the primary creator |
| `src/hooks/useCanvasWorkflow.ts` | canvas flow |
| `src/components/post/BulkScheduler.tsx` | bulk |
| `src/pages/Calendar.tsx`, `src/pages/ScheduledPosts.tsx` | reschedule / edit |
| `src/pages/admin/AdminUserDetail.tsx` | admin |

Every `posts` reference to `scheduled_at` inside `supabase/functions/**` is a `SELECT`
(`ai-agent-reply/admin-tools.ts`, `send-weekly-analytics`). **No edge function creates a schedule
row.**

That is the finding that moved 7.5 to Phase 8 — see §4.

---

## 2. What this PR builds: 7.4

`partner_settle_platform_post` performs the terminal transition, the parent `posts` roll-up, and
the `post.published` / `post.failed` enqueue in **one statement**, and serves both shapes above.

Occurrence id: `post.published:<platform_post row id>`. The row id is the stable per-target
identifier — the *post* id would collide across targets, which is D11's per-target status
requirement expressed in the outbox's own terms, and exactly the collision the Phase 5 record
warned about for `message.delivered`/`.read`.

**The events stay uncertified.** `post.published` / `post.failed` are 8.4, not 7.x, and
`CERTIFIED_EVENT_TYPES` and the `partner_webhooks.events` CHECK are unchanged by this PR. The
operation enqueues for whatever subscriptions match — and today none can exist, by construction.
That is the intended state: Phase 7 builds the seam, Phase 8 advertises through it.

### How the crash-test exit criterion is satisfied with the event uncertified

Phase 7's exit criteria include *"a crash after a platform result is written still produces a
queued delivery row"* — but with `post.published` uncertified, no subscription may exist to
receive one, so the criterion appears untestable.

It is tested by **widening the CHECK inside the test transaction only**. The SQL suite creates a
subscription for `post.published` after temporarily relaxing the constraint, proves the atomicity
in both directions (a committed status carries its delivery row; a rolled-back one leaves none),
and restores the constraint. The published surface is never widened; the *proof* is.

The alternative readings were considered and rejected: widening the DB CHECK but not the TS list
would leave the two enforcement points disagreeing, which is the drift they exist as a pair to
prevent; and deferring the whole criterion to Phase 8 would let Phase 8 inherit an unproven seam,
which is what D9 exists to stop.

---

## 3. Why 7.2 and 7.3 are a separate PR

7.2 moves eleven `postToX` bodies — `process-post/index.ts` is **7,249 lines** and those functions
span lines 1823–7249, about **5,400 lines, three quarters of the file**.

The plan's own exit criteria pull against each other here, and the tension is worth naming rather
than resolving silently:

- 7.2 says the bodies **move**, and 7.3 says there is **exactly one publish path**.
- The exit criteria demand a **feature flag with an exercised rollback** and a **shadow parity
  soak**.

If the bodies move, there is no second path to roll back to without a deploy — the same
mutual-unsatisfiability the plan documents for v1.1's four constraints. The reading adopted here:

> **The provider bodies are byte-identical by construction** — that is what "a move, not a
> rewrite" means, and `git diff --color-moved` makes it checkable rather than asserted. Parity
> there is trivially true. The *behaviourally* new thing is this PR's database seam, so the flag,
> the soak and the exercised rollback belong to **that**, not to the provider calls.

Separating the PRs follows from it: the flagged, soakable change is here; the mechanical move is a
refactor whose correctness is proven by `--color-moved`, one platform per commit. Landing both at
once would put a 5,400-line move and a live database-behaviour change in one reviewable unit, and
the move would hide the seam.

**Owner decision, 2026-09-02: approved** — the separation "keeps the review focused and eliminates
regression masking".

**Verified before proposing the move:** the deployed `process-post/index.ts` in the functions
volume is byte-identical to `origin/main` (`26cec7e8…`). This matters because `refresh-tokens` was
once found *ahead* of the repository, and a git-based move over an out-of-band fix would ship a
regression nothing catches.

---

## 4. 7.5 moves to Phase 8 — ratified, not deferred by default

7.5 wants schedule-row creation and its enqueue in one transaction. The inventory says schedule
rows are created **only from the browser**, in six `src/` files, under the end user's own session.

So the atomic operation for 7.5 cannot be a service-role function like every other partner
producer. It must be a `SECURITY DEFINER` function **callable by `authenticated`** — the first in
this programme. That is a real widening:

- every partner function so far is `REVOKE ALL … FROM PUBLIC, anon, authenticated` with a
  `service_role`-only grant;
- a `SECURITY DEFINER` function reachable by `authenticated` bypasses RLS by definition, so its
  own body becomes the entire access-control boundary;
- it would have to re-derive the caller's ownership from `auth.uid()` internally rather than
  trusting its arguments, and a mistake there is a cross-tenant write.

The alternative is moving schedule creation server-side into an edge function and changing six
call sites — a larger change with a smaller blast radius.

**Both are defensible and the choice was not mine to make silently.** It was put to the owner with
the two shapes and their trade-off, in the same way the D10 malware row was.

**Owner decision, 2026-09-02: neither. `post.scheduled` moves to Phase 8.**

The reasoning is better than either option I offered: Phase 8 implements
`POST /v1/posts/{id}/schedule` as a **server-side** endpoint, which makes schedule creation
reachable from an edge function for the first time. At that point the atomic operation is an
ordinary service-role function like every other producer in this programme — no
`authenticated`-callable `SECURITY DEFINER` function, no RLS-bypassing body acting as its own
access-control boundary, and no six-file frontend refactor.

Building it now would mean choosing between two shapes that Phase 8 makes unnecessary. Phase 7 is
therefore strictly the **terminal** seam: `post.published` and `post.failed`. `post.scheduled` is
Phase 8's, with its own producer-ledger row, and nothing here forecloses it.
