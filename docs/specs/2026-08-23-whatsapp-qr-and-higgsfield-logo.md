# Spec — WhatsApp QR naming & history sweep, Higgsfield consent logo

Date: 2026-08-23
Task 3 of the queued set. Branch `feat/whatsapp-qr-and-higgsfield-logo` off `main`.

Four independent parts. **Two of the four were briefed with snippets that do not
match the deployed reality**; both are corrected below with the evidence.

---

## Facts verified before writing this spec

| Claim in the brief | Verified reality |
|---|---|
| Set `customBrowser` in the create-instance body | **False.** `customBrowser` does not appear anywhere in Evolution API 2.3.7's `dist`. The "Google Chrome (Evolution API)" label comes from the **`CONFIG_SESSION_PHONE_CLIENT` env var**, which the container currently does not set (so it falls back to the default `"Evolution API"`). Part 2 is a **container config change, not repo code.** |
| `findMessages` pagination uses `page` / `offset`, response has `messages.pages` | **True.** The dist contains `currentPage: s.page` and `pages: Math.ceil(o/s.offset)`. The briefed shape is correct for 2.3.7. |
| Use `logo_uri: "https://postora.cloud/logo.png"` | **False.** That URL returns **404**. Live square asset is `https://postora.cloud/favicon.png` (200, 50×50 PNG). `og-image.png` is live but 1536×1024 — wrong shape for a consent avatar. |

Evolution container: `postora-evolutionapi-zenkpi`, image `postora-evolutionapi-zenkpi:latest`, evolution-api **2.3.7**.

---

## Part 1 — Prompt for a connection name on QR connect / rescan

### Root cause

`syncEvolutionAccountConnection` (`_shared/evolutionQrAccount.ts:59`) sets
`platform_username` **only when Evolution supplies a `profileName`**:

```ts
const profileName = extractProfileName(identity);
if (profileName) updates.platform_username = profileName;
```

When it supplies none, the previous account's name survives untouched — which is
exactly the reported symptom after disconnecting on the phone and pairing a
different number.

### Requirements

- **R1.1** — `WhatsAppQrScanner` prompts for a **Connection Name** and submits it
  with the QR flow. The user can accept a prefilled suggestion or type their own.
- **R1.2** — the `whatsapp-evolution-bridge` accepts an optional `display_name`
  (or `account_name`) on the QR actions, and `syncEvolutionAccountConnection`
  takes it as a new optional argument.
- **R1.3 — precedence, the load-bearing rule.** A user-supplied name writes
  **both** `platform_username` and `account_metadata.display_name`. The
  auto-fill from `profileName` then applies **only when
  `account_metadata.display_name` is absent**. Without this, the phone's profile
  name overwrites the user's chosen label on every single reconnect.
- **R1.4** — validate the input: must be a string, trimmed, non-empty after
  trimming, and capped (60 chars). An invalid value is rejected, never silently
  substituted.
- **R1.5** — `platform_user_id` is **not** touched. It must stay digits-only
  (a WhatsApp inbox invariant).

### Interaction with task 2

A custom name containing spaces (e.g. `"Danat Main Line"`) now flows through
`normalizeHandleUsername`, so `account.username` becomes `danat_main_line` and
`account.handle` stays `null` (WhatsApp is not a handle platform). Consistent
with the merged behaviour, and stated here so it is not a surprise.

### Explicitly out of scope (declared so review does not block on it)

Re-scanning a **different phone number** leaves `platform_user_id` at the old
value, because the update is gated on `account.platform_user_id.startsWith("pending_")`.
That is a real adjacent gap this task does not close: the brief asks for naming,
and changing the identity column has inbox and dedup consequences well beyond
it. Recorded as follow-up.

## Part 2 — White-label the WhatsApp linked-device name

**This is a deployment change, not a code change.** Evolution 2.3.7 builds the
linked-device label from `CONFIG_SESSION_PHONE_CLIENT` (client) and
`CONFIG_SESSION_PHONE_NAME` (browser); neither is set on the container today, so
it shows the default `"Evolution API"`. There is no `customBrowser` field to
send — adding one to `createRequestBody` would be dead code the API ignores.

### Requirements

- **R2.1** — set `CONFIG_SESSION_PHONE_CLIENT=Postora` on the
  `postora-evolutionapi-zenkpi` service **via the Dokploy environment config,
  not by hand-editing `.env`.** Dokploy regenerates `.env` from its own database;
  a manual edit is silently reverted on the next deploy. (This exact trap was hit
  with `CRON_SECRET` earlier today.)
- **R2.2** — restarting Evolution drops live Baileys sessions briefly; they
  reconnect. Note it in the deploy step rather than discovering it.
- **R2.3 — honest verification expectation:** already-linked devices keep the old
  label. The new name appears only on a **newly paired** device. "Scan and check
  your phone" is the user's follow-up check, not a machine gate.

No repo file changes in this part.

## Part 3 — Paginate the WhatsApp history sweep

`findMessages` (`_shared/evolutionApi.ts:163`) posts
`{ where: { key: { remoteJid } } }` with no pagination and reads
`payload?.messages?.records`, so it returns only the first page (~40–50 rows).

### Requirements

- **R3.1** — loop `page` from 1 with `offset: 50`, accumulating `records`, and
  stop when a page returns fewer than `offset` rows, when `page >= payload.messages.pages`,
  or at a hard ceiling of **20 pages** (1000 messages/chat) so a runaway cannot
  hang the function.
- **R3.2 — dedupe by message id before returning.** Page boundaries can repeat a
  row, and a repeated id inside one batch upsert is what raises
  **SQLSTATE 21000** (`ON CONFLICT DO UPDATE command cannot affect row a second
  time`). Deduping in the client is cheaper and clearer than making the upsert
  tolerate it.
- **R3.3** — when the ceiling is hit, **log how many pages were taken and that
  more may remain.** A silent truncation reads as "we imported everything".
- **R3.4** — the existing single-page response shape stays supported: a response
  that is a bare array, or has no `messages.pages`, must still work.
- **R3.5** — total work is bounded by chats × pages; the sweep already runs per
  account, so log the totals to make a timeout diagnosable.

## Part 4 — Postora logo on the Higgsfield consent screen

`getOrRegisterClient` (`_shared/higgsfield-oauth.ts:218`) registers with
`client_name: "Postora"` but no `logo_uri` / `client_uri`, so the consent screen
shows an unbranded placeholder.

### Requirements

- **R4.1** — add `client_uri: "https://postora.cloud"` and
  **`logo_uri: "https://postora.cloud/favicon.png"`** to the registration body.
  **Not `/logo.png`** — that 404s, and pointing a consent screen at a dead image
  is worse than the placeholder it replaces.
- **R4.2 — re-registration is destructive; treat it as such.** The client is
  cached in `oauth_clients` and only re-registered when no row matches, so the
  new `logo_uri` needs the row cleared. But `refreshTokens` resolves its client
  through `getOrRegisterClient` (line 477), so **deleting the row breaks token
  refresh for the existing connection until someone re-authorizes.** Therefore:
  back the row up first, do it as an explicit post-deploy step, and re-authorize
  immediately after. It is not part of the merge gate.

## Acceptance criteria

**Machine-verifiable (these gate the merge):**

- Part 1: unit tests for the name-precedence rule — user name wins;
  `profileName` fills only when `account_metadata.display_name` is absent; a
  reconnect with a profile name does **not** overwrite a user-set name; invalid
  input rejected; `platform_user_id` untouched.
- Part 3: tests for multi-page accumulation, early stop on a short page, stop at
  `pages`, the 20-page ceiling with its log, id dedup across a page boundary, and
  the bare-array/legacy response shape.
- Part 4: a test asserting the registration body carries `client_uri` and a
  `logo_uri` that is **not** `/logo.png`.
- `deno check` on every changed function; `deno test supabase/functions/_shared/`
  at or above the **183 passed / 8 failed** baseline (those 8 are pre-existing in
  `whatsappPartnerOps.test.ts` and neighbours — establish the baseline before
  reading that suite's red as a regression); `npx tsc --noEmit`; `npm test` at or
  above **663 passed / 15 skipped / 0 failed**; `npm run build`.
- `clean-code-guard` and `test-guard` clean.

**User-verifiable (follow-up, cannot gate a merge):**

- The rename dialog reads well and the chosen name shows on the messaging page.
- A newly paired phone shows **"Postora"** under Linked Devices.
- The Higgsfield consent screen shows the Postora logo.
- A long-history account imports more than one page into `whatsapp_messages`.

## Deployment

1. Merge to `main` (frontend auto-deploys).
2. `ssh-contabo-mcp`: SHA-diff and copy changed `supabase/functions/**` into the
   functions volume, then restart the functions container.
3. **Dokploy UI:** set `CONFIG_SESSION_PHONE_CLIENT=Postora` on the Evolution
   service and redeploy it (brief session reconnect).
4. **Post-deploy, explicitly:** back up the `oauth_clients` row for
   `provider_code = 'higgsfield'`, delete it, then re-authorize Higgsfield to
   re-register with the logo.
