# Decision: CORS `Access-Control-Allow-Origin: *` on the Partner API (0.10)

- **Date:** 2026-08-30
- **Owner:** the repository owner (Postora)
- **Status:** In effect — `*` is **retained** on the frozen alias and adopted as
  the reviewed default for `/v1` when it is built. This record is the explicit
  decision ARCHITECTURE.md §25 and spec §9.9 require; until it existed, the
  header was an inherited default, which is what both documents forbid.

## What the current headers are

From `supabase/functions/partner-api/index.ts:35-43`, verified on this branch:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: content-type, x-postora-key, idempotency-key
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Expose-Headers: x-postora-request-id, idempotency-replayed,
                               retry-after, x-ratelimit-limit,
                               x-ratelimit-remaining, x-ratelimit-reset
```

`OPTIONS` preflights get the same set and a 200 (`index.ts:145`). There is **no
`Access-Control-Allow-Credentials`** anywhere in the partner surface (verified by
grep over `partner-api/**`, `_shared/partnerApi*.ts`, `_shared/whatsappPartnerOps.ts`).

## Why `*` is defensible HERE — verified, not assumed

The argument turns on the credential being a custom header rather than ambient
browser authority, and that premise was checked in the code before being relied
on:

1. **The only credential this function reads is `x-postora-key`**
   (`index.ts:181`). It never reads `Authorization`, never touches `Cookie`, and
   holds no session of its own — verified by reading the file, not by assumption.
   A browser attaches none of these automatically: a cross-origin page's
   `fetch()` carries the key only if that page's JavaScript *knows the key and
   sets the header explicitly*. At that point the attacker holds the credential
   itself and CORS is irrelevant — `curl` works equally well. CORS governs which
   origins may read responses; it is not, and cannot be, the thing protecting the
   key (spec §9.9: "CORS is not authorization").
2. **The credentialed-request combination is structurally absent.** The dangerous
   pairing is `Allow-Origin: *` with ambient credentials (cookies, HTTP
   authentication) that a browser would attach silently. This API has no cookie
   surface, and per the Fetch specification a wildcard origin is not honoured for
   credentialed requests anyway — a server must echo an exact origin to enable
   them. Adding `Allow-Credentials` under `*` would simply not work, which makes
   the current posture fail-safe against the classic mistake rather than merely
   undocumented.
3. **The exposed headers leak nothing.** `Access-Control-Expose-Headers`
   publishes only the correlation handle, the replay marker, and the rate budget
   (whose pre-auth omission is itself deliberate — see `index.ts:74-76`). No key,
   token, or account material appears in any header a browser is told to expose.

What `*` buys: any legitimate browser-based client (a partner's internal web
tool, a future debug console) can call the API from any origin without a
per-origin allowlist to maintain, and a non-browser client is unaffected either
way. What it costs: nothing beyond the above, given a custom-header credential.

## What would change the answer

Recorded so the next reader knows where the edge of this decision is:

1. **Any future partner route that authenticates from ambient browser state** —
   cookies, a session, or an `Authorization` header the browser might attach on
   its own. That route needs an exact-origin allowlist plus
   `Access-Control-Allow-Credentials`, and it contradicts this record until the
   record is rewritten.
2. **Key material ever held in a first-party browser client** (localStorage,
   etc.). `*` remains technically non-exploitable, but the threat model would
   then include browser-resident secrets, where origin restriction plus CSP
   reduce blast radius; that deserves its own review, not this record stretched.
3. **Any response becoming sensitive to a third party who does NOT hold the
   key** — nothing today is: every datum the API returns belongs to the key's own
   workspace (threat review §1).
4. **Adding `Authorization: Bearer pk_live_…` as an accepted key transport.**
   Still an explicit, non-ambient header, so `*` remains defensible — but
   `Allow-Headers` would need a deliberate update and this record re-checked as
   part of that change, not after it.

## Decision

`Access-Control-Allow-Origin: *` stays on the frozen alias, and is the reviewed
default for the `/v1` router when Phase 2 builds it — **provided** the `/v1`
implementation re-verifies the premise this record rests on at the time:
credential is a custom header, no cookies, no `Allow-Credentials`, no
browser-ambient authentication of any kind. The 0.9 threat review's §7 already
obliges a re-review when `/v1` lands; this decision is part of that re-run's
checklist. Copying these headers into any *unauthenticated-user* function (the
OAuth doors, for example) is not covered by this record and remains governed by
ARCHITECTURE.md §25 unchanged.


## Corrections from adversarial review (2026-08-31)

Two points in the reasoning above were imprecise, and precision is the whole
value of a recorded decision:

1. **`Authorization: Bearer` is not ambient authority.** Browser JavaScript has
   to set it explicitly, exactly like `x-postora-key`. The genuinely ambient
   cases are **cookies** and browser-managed HTTP authentication, neither of
   which this function uses. The conclusion is unchanged; the argument for it
   is narrower than first written.

2. **This decision covers the frozen alias only.** It does not pre-adopt `*`
   for `/v1`, which does not exist yet. `/v1` will have its own authentication
   and response surface, and must make its own CORS decision when it is built
   rather than inheriting one taken before there was anything to inherit it
   for. Recording a decision about code that does not exist is the same
   copy-paste-by-default that ARCHITECTURE.md §25 forbids, just performed in
   advance.
