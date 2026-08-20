# User Journey — Openinary dual-cloud & Higgsfield Hub

Manual test script for the two features brought online on 2026-08-20.
Self-hosted Supabase at `https://api.postora.cloud`. Live app at
`https://postora.cloud`.

Run as the admin account (`dr.vet.waleedtam@gmail.com`). Some steps need a
second, non-admin account — those are marked **[2nd account]** and can be
skipped on a smoke pass.

---

## Before you start — read this or half the steps will look broken

**The frontend fixes are not deployed yet.** Backend work (migrations, edge
functions) is live on the server, but the UI half ships with PR #4 when it
merges to `main` — Dokploy only deploys the frontend on a `main` push.

Until that merge:

| Step | Behaves how |
|---|---|
| J2 (Test connection) | Still shows the old stub toast. **Expected**, not a regression. |
| J1 (settings page loads) | Works — but because the RPC was fixed server-side, not because the guard shipped. |

Everything else in this document tests backend behaviour and is valid today.
After the merge, re-run **J1** and **J2** to confirm the UI half.

Two more things worth knowing before you judge a result:

- **Openinary answers a burst with HTTP 401**, not 429. A valid key looks
  revoked for ~90 seconds after roughly 100 rapid requests. If a step fails
  with an auth error right after another heavy step, wait two minutes and
  retry before reporting a bug.
- **Admin and user Higgsfield connections are different records.** The admin
  card connects the *platform* account (`provider_api_keys`); the settings
  card connects *your own* account (`higgsfield_connections`). Connecting one
  does not connect the other, and that is correct.

---

## Part A — Openinary

### J1. The CDN card loads

1. Sign in as admin, go to **`/admin/settings`**.
2. Scroll to the **CDN storage** card.

**Pass:** the page renders and the card is visible.

**Fail:** a full-page "Something went wrong / An unexpected error occurred"
screen. That was the original bug — the page crashed whenever the provider
counts could not load. If you see it again, capture the browser console; the
old signature was `Cannot read properties of undefined (reading 'cloudinaryOnly')`.

> Ignore any `static.cloudflareinsights.com/beacon.min.js … ERR_BLOCKED_BY_CLIENT`
> console line. That is an ad blocker, unrelated to Postora.

### J2. Test connection

1. In the **CDN storage** card, click **Test connection**.

**Pass (after PR #4 merges):** a toast reading **"Openinary reachable"** with a
message like `Connected. 2 file(s) under postora.cloud.`

> The count is small on purpose — it lists the top level of `postora.cloud`
> only. The ~842 mirrored files live in subfolders and are not counted here.

**Pass (today, pre-merge):** the old toast, "Connection test unavailable / The
edge connection-test endpoint is not present in this checkout." This is the
stub being replaced; it made no network call and said the same thing whatever
you typed.

**Fail:** "Openinary unreachable". The toast carries the reason — a `401`
means the key is rejected (or you are inside the rate-limit cooldown; wait two
minutes and retry), anything else usually means DNS/TLS/timeout.

### J3. The retirement gate reads correctly

Still in the **CDN storage** card, read the **Retirement gate** block.

**Expected at time of writing:**

| Line | Value |
|---|---|
| Cloudinary-only | **10** — with a red "← must reach 0" marker |
| Both providers | **842** |
| Openinary-only | **0** |

The 10 are videos whose Cloudinary originals return 404 — the source files are
gone, so nothing can be mirrored. This is pre-existing data rot, not a bug in
this feature, and it is why the gate stops at 10 rather than 0. It clears only
by deleting those media rows.

**Fail:** all three read 0. That means the counts RPC returned nothing —
check you are signed in as an admin, since the function is admin-gated and
returns zeros to everyone else by design.

### J4. Write providers and read preference

Confirm the card shows:

- **Write providers** — both `cloudinary` and `openinary` switches **on**.
- **Read preference** — **`openinary`** selected.

The Cloudinary switch is intentionally **disabled** while Cloudinary-only is
above 0. That is the retirement gate doing its job: you may stop *writing* to
Cloudinary only once everything is mirrored, and you never stop *reading* it.

### J5. New uploads reach both clouds — the real test

1. Go to **`/media`** (or the media picker inside **`/post`**).
2. Upload a fresh image you have not used before.
3. Wait for the upload to finish.

**Pass:** the upload succeeds and the image thumbnail renders.

4. Re-open **`/admin/settings`** → **CDN storage** and re-read the gate.

**Pass:** **Both providers** has increased by 1. Cloudinary-only is unchanged.

**Fail:** Both providers unchanged while Openinary-only or Cloudinary-only
moved — that means one leg of the dual-write failed. The failed provider row
is kept as the retry record; check `media_file_providers` for a row with
`status='failed'` and read its `error` column.

### J6. Media serves from Openinary

1. On **`/media`**, right-click any image that existed *before* today and
   choose "Open image in new tab" (or copy its URL).

**Pass:** the URL begins `https://openinary.walidmohamed.com/t/postora.cloud/…`
and the image loads. Content-type will be `image/webp` — Openinary converts
on delivery, so a `.png` path serving WebP is correct, not a bug.

**Fail:** the URL still points at `res.cloudinary.com`. For a *mirrored* file
that means read preference is not being honoured. Note that this is expected
and correct for the 10 unmirrored videos, which legitimately fall back to
Cloudinary.

### J7. Older Supabase-storage files still work

A handful of files predate Cloudinary and live in Supabase storage.

1. Scroll to the oldest items in **`/media`** (around January 2026).

**Pass:** they either render, or they are already-broken items you recognise
from before this work. Six of the seven no longer exist in storage at all.

**Fail:** a *previously working* old file breaks. Those files intentionally
fall through to the storage resolver rather than getting an Openinary URL, so
a regression here would be a real defect.

---

## Part B — Higgsfield Hub

### J8. Platform connection (admin)

This is the path that was broken — it writes to `provider_api_keys`, the table
that was missing its `meta` column.

1. Go to **`/admin/settings`** and scroll to the **Higgsfield Hub** card.
2. It should read **Not connected**.
3. Click **Connect with Higgsfield**.
4. You are redirected to `mcp.higgsfield.ai`. Authorise there.
5. You land back on `/admin/oauth/higgsfield/callback`, which shows
   "Connecting Higgsfield", then **"Higgsfield connected"**, then redirects.

**Pass:** the card now shows **Connected account** with the account email.

**Fail:** the callback page shows **"Connection failed"**. This was the
reported symptom — authorising succeeded upstream, then failed to land. If it
returns, capture the message on the callback page and check the edge log for
the function name and error:

```
docker logs --since 10m postorasupabase-supabase-j8axyh-supabase-edge-functions 2>&1 | grep -i higgsfield
```

The original signature was `column provider_api_keys.meta does not exist`.

### J9. Sync the model catalog

1. With the platform account connected, click **Sync models**.

**Pass:** a toast reading **"Model catalog synced"**.

**Fail:** "Higgsfield action failed" — the toast carries the reason.

### J10. Your own connection **[2nd account]**

1. Go to **`/settings`** → **Integrations** tab.
2. Find **Your Higgsfield account**. It should read as not connected.
3. Click **Connect with Higgsfield** and authorise.

**Pass:** the card shows your connected Higgsfield account email.

This is a separate record from J8 — it stores under your user, so each user
brings their own Higgsfield account and pays their own provider costs.

### J11. Disconnect

1. Admin card: click **Disconnect** → confirm **"Disconnect Higgsfield?"**.
   **Pass:** toast **"Higgsfield disconnected"**, card returns to
   **Not connected**.
2. Settings card: click **Disconnect**.
   **Pass:** same toast, card returns to not-connected.

Re-run J8 afterwards to confirm reconnecting still works — the OAuth client is
registered once and reused, so a reconnect exercises a different path than a
first connect.

### J12. Non-admin cannot reach admin controls **[2nd account]**

1. Sign in as a non-admin user and open **`/admin/settings`** directly.

**Pass:** you are blocked or redirected. The backing endpoints are
independently admin-gated and answer `401 Admin access required`, so even a
crafted request cannot read the CDN counts or run a connection test.

---

## Result log

| # | Journey | Result | Notes |
|---|---|---|---|
| J1 | CDN card loads | | |
| J2 | Test connection | | pre-merge: stub toast expected |
| J3 | Retirement gate 10 / 842 / 0 | | |
| J4 | Providers + read preference | | |
| J5 | New upload dual-writes | | |
| J6 | Media serves from Openinary | | |
| J7 | Old storage files unaffected | | |
| J8 | Platform connect (admin) | | the previously broken path |
| J9 | Sync models | | |
| J10 | User connect | | 2nd account |
| J11 | Disconnect both | | |
| J12 | Non-admin blocked | | 2nd account |

---

## If something fails

Collect these before filing:

1. Browser console output (the real error is usually the first `TypeError`,
   not the Cloudflare beacon line).
2. Which account and which page.
3. Edge function log for the window:
   ```
   docker logs --since 15m postorasupabase-supabase-j8axyh-supabase-edge-functions 2>&1 | grep -iE 'error|boot'
   ```

Known-good baseline as of 2026-08-20: 643 media mirrored with 0 failures,
gate at 10 / 842 / 0, 30 of 30 sampled Openinary URLs returning 200, and zero
edge boot errors. 557 vitest plus 5 Deno tests passing.

## Related

- Edge deploy steps: `docs/runbooks/deploy-edge-function.md`
- Feature plan: `docs/plans/higgsfield-and-openinary.md`
