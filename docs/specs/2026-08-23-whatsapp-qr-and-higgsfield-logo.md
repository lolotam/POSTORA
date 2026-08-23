# Spec — WhatsApp QR naming & history sweep, Higgsfield consent logo

Date: 2026-08-23
**Revision 2** — Codex round 1 returned 12 blocking objections. All are folded
in; §6 records each disposition. Parts 1 and 4 are substantially rewritten,
and one requirement (R3.2) was **withdrawn as a fix for a non-existent bug**.

Branch `feat/whatsapp-qr-and-higgsfield-logo` off `main`. Four parts, one PR,
four scoped commits — they share a deploy.

---

## 1. Facts verified before writing (three briefed claims, two wrong)

| Claim in the brief | Verified reality |
|---|---|
| Set `customBrowser` in the create-instance body | **False.** No `customBrowser` anywhere in Evolution API 2.3.7's `dist`. The "Google Chrome (Evolution API)" label comes from the **`CONFIG_SESSION_PHONE_CLIENT` env var**, unset on the container so it falls back to `"Evolution API"`. Part 2 is a **config change, not repo code**; adding the field would be dead code the API ignores. |
| `findMessages` pagination uses `page`/`offset`, response has `messages.pages` | **True.** The dist contains `currentPage: s.page` and `pages: Math.ceil(o/s.offset)`. |
| `logo_uri: "https://postora.cloud/logo.png"` | **False — 404.** Live square asset is `https://postora.cloud/favicon.png` (200, 50×50). `og-image.png` is live but 1536×1024, wrong shape for a consent avatar. |
| Pagination will fix `SQLSTATE 21000` | **False, and withdrawn.** `whatsappSyncEngine.ts:131-140` **already** dedupes by `message_id` before the RPC, with a comment naming 21000. See R3.2. |

Container `postora-evolutionapi-zenkpi`, evolution-api **2.3.7**.

## 2. Part 1 — Prompt for a connection name on QR connect

### Root cause

`syncEvolutionAccountConnection` (`_shared/evolutionQrAccount.ts:59`) writes
`platform_username` **only when Evolution supplies a `profileName`**:

```ts
const profileName = extractProfileName(identity);
if (profileName) updates.platform_username = profileName;
```

When it supplies none, the previous account's name survives — the reported
symptom after pairing a different number.

### Where the name must be collected (Codex #1)

`create_and_get_qr` fires at **`WhatsAppSetup.tsx:528`, before
`WhatsAppQrScanner` mounts**; the scanner only ever calls `get_qr_status`
(`WhatsAppQrScanner.tsx:29-32`). Collecting the name in the scanner is
therefore too late — the webhook can activate the account first, and
`reconcileAccountConnection` early-returns (`bridge:274-276`) without applying
it.

- **R1.1** — the name is collected in `WhatsAppSetup` **before**
  `create_and_get_qr`, and sent as a field on that action.
- **R1.2** — the bridge validates it and persists it at creation time.

### Precedence must live inside the helper (Codex #2)

`syncEvolutionAccountConnection` is the **only** writer of `platform_username`
on the WhatsApp path — but it has **three call sites**: `bridge:276`,
`bridge:279`, and `whatsapp-evolution-webhook:169`. An optional argument would
be silently omitted by whichever caller was not updated, and the phone profile
would overwrite the user's name on the next reconnect.

- **R1.3** — the helper **loads `account_metadata` itself** (one query by
  account id) rather than taking it as an argument, and applies:
  `profileName` fills `platform_username` **only when
  `account_metadata.display_name` is absent**. A user-set name is never
  overwritten by a reconnect, from any caller.

### Metadata must be merged, never replaced (Codex #3)

`account_metadata` already carries `connection_mode`, a consent timestamp and a
client IP (`bridge:183-198`). Writing the object wholesale would erase them.

- **R1.4** — all `account_metadata` writes are **read-modify-merge on named
  keys only**. A test asserts `connection_mode` and the consent keys survive a
  name write.

### Remaining Part 1 rules

- **R1.5** — validation: string, trimmed, non-empty after trim, ≤60 chars.
  Invalid input is rejected, never silently substituted.
- **R1.6** — `platform_user_id` is **not** touched; it must stay digits-only
  (a WhatsApp inbox invariant).
- **R1.7 — tenant isolation (Codex #10)** — the name rides only the existing
  owner-checked bridge actions. **No new generic update path** that takes an
  account id and a value. One test asserts a cross-tenant account id is
  rejected.

### Interaction with task 2

A custom name with spaces (`"Danat Main Line"`) flows through
`normalizeHandleUsername`, so `account.username` becomes `danat_main_line` and
`account.handle` stays `null` (WhatsApp is not a handle platform). Consistent
with what shipped in PR #26; stated so it is not a surprise.

### Out of scope — the different-number hazard (Codex #12)

Re-pairing a **different phone number** leaves `platform_user_id` at the old
value, because the update is gated on `startsWith("pending_")`. Conversation
ids, inbox dedup and ownership logic then reference the wrong phone. Migrating
that identity is a spec-sized change of its own and is **not** in this task,
which the brief scopes to naming.

Codex is right, though, that a purely cosmetic rename can *mask* a wrong-number
pairing. So one cheap detection is added, without migration:

- **R1.8** — when the sync observes an `ownerNumber` that differs from a
  non-`pending_` `platform_user_id`, log it loudly and set
  `account_metadata.number_mismatch = true`. Surfacing it in the UI is
  follow-up work.

## 3. Part 2 — White-label the linked-device name (deployment only)

- **R2.1** — set `CONFIG_SESSION_PHONE_CLIENT=Postora` on the
  `postora-evolutionapi-zenkpi` service **through the Dokploy environment
  config, not by editing `.env`**. Dokploy regenerates `.env` from its own
  database; a manual edit is silently reverted on the next deploy. This exact
  trap was hit with `CRON_SECRET` earlier today.
- **R2.2** — restarting Evolution briefly drops live Baileys sessions; they
  reconnect. Expected, not a fault.
- **R2.3 — honest expectation:** already-linked devices keep the old label. The
  new name appears only on a **newly paired** device. That is a user check, not
  a machine gate.

**No repo file changes in this part.**

## 4. Part 3 — Paginate the WhatsApp history sweep

`findMessages` (`_shared/evolutionApi.ts:163`) posts
`{ where: { key: { remoteJid } } }` with no pagination, so it returns one page.

- **R3.1** — loop `page` from 1 with `offset: 50`, accumulating records. Stop
  when a page returns fewer than `offset` rows, when `page >= messages.pages`,
  or at a **20-page ceiling**.
- **R3.2 — WITHDRAWN, and why it matters.** The brief said pagination must add
  id-deduping to avoid `SQLSTATE 21000`. It is already handled:
  `whatsappSyncEngine.ts:131-140` builds a `Map` keyed on `message_id` before
  the RPC, with a comment naming that exact error. What replaces it is a
  **preservation** requirement: all pages for one chat must be returned as
  **one array feeding one `messageRows` call**, so the existing single-batch
  dedup still covers cross-page duplicates. The accumulate-then-return shape
  already does this — it is load-bearing, and a cross-page-duplicate test pins
  it.
- **R3.3 — response-shape robustness (Codex #5)** — a **bare array** response
  is treated as a single page and never re-requested (a server ignoring `page`
  would otherwise be asked 20 times for the same 50 rows). `pages` is validated
  as a finite positive number before being trusted.
- **R3.4 — a time budget, not a page count (Codex #6)** — the ceiling bounds
  one chat, not the sweep. A `Date.now()` deadline (~60s) is checked **between
  chats**; on expiry the sweep stops, logs chats done and chats remaining, and
  returns partial. A re-run resumes naturally because the upserts are
  idempotent. No continuation-token machinery.
- **R3.5** — when either bound is hit, log it. Silent truncation reads as "we
  imported everything".
- **Noted, out of scope:** `conversationRows` / `contactRows` do not dedupe
  their conflict keys and are a plausible *remaining* 21000 source (Codex #4).
  Not this task, unless trivially adjacent while in the file.

## 5. Part 4 — Postora logo on the Higgsfield consent screen

`getOrRegisterClient` (`higgsfield-oauth.ts:218`) registers `client_name:
"Postora"` but no `logo_uri`/`client_uri`.

- **R4.1** — add `client_uri: "https://postora.cloud"` and
  **`logo_uri: "https://postora.cloud/favicon.png"`**. Not `/logo.png` — it
  404s, and a dead image is worse than the placeholder.
- **R4.2 — the delete-the-row plan is withdrawn (Codex #7, #8).** The client is
  cached in `oauth_clients` and only re-registered when no row matches, so the
  new metadata needs *something*. But `refreshTokens` resolves its client
  through `getOrRegisterClient` (line 477): deleting the row means the next
  refresh registers a **new** client and then presents the **old** client's
  refresh token, which fails. The safer path, in order:
  1. the code change covers all **future** registrations;
  2. post-deploy, **read** the stored `registration_response` — if it carries
     RFC 7592 `registration_client_uri` + `registration_access_token`, do an
     **in-place PUT**. The `client_id` survives, refresh keeps working, no
     re-authorization;
  3. only if 7592 is unsupported, fall back to a **targeted** delete matching
     `provider_code` **and** `redirect_uri` (never all Higgsfield rows),
     immediately followed by re-authorization.
- **R4.3 — secrets (Codex #9)** — `oauth_clients` holds `client_secret` and
  possibly a registration access token inside `registration_response`. The row
  stays queryable in the database as its own backup: **do not dump it to a
  file, a log, or the repository.**
- **R4.4** — none of this gates the merge. It is an explicit post-deploy step.

## 6. Codex round-1 objections and disposition

| # | Objection | Disposition |
|---|---|---|
| 1 | name must be collected at `create_and_get_qr` (`WhatsAppSetup.tsx:528`), not in the scanner | **Accepted** — verified; R1.1/R1.2 rewritten |
| 2 | precedence cannot be an optional argument; `EvolutionQrAccount` lacks `account_metadata` and there are 3 call sites | **Accepted** — verified 3 call sites; R1.3 moves the rule inside the helper, which loads metadata itself |
| 3 | replacing `account_metadata` would erase `connection_mode`/consent/IP | **Accepted** — R1.4 requires read-modify-merge plus a survival test |
| 4 | the 21000 diagnosis is false; `messageRows` already dedupes | **Accepted — requirement withdrawn.** R3.2 becomes a preservation requirement. The real remaining suspect (`conversationRows`/`contactRows`) is named and scoped out |
| 5 | pagination edge cases underspecified; a bare 50-row array could be re-requested 20× | **Accepted** — R3.3 |
| 6 | a per-chat ceiling does not bound the sweep against the function timeout | **Accepted** — R3.4 replaces it with a time budget and partial return |
| 7 | deleting the OAuth client is not proven necessary; RFC 7592 in-place update may exist | **Accepted** — R4.2 tries 7592 first, delete only as fallback |
| 8 | the refresh-breakage description is incomplete and the delete must be targeted | **Accepted** — R4.2 states the new-client/old-token failure and scopes the delete to `provider_code` + `redirect_uri` |
| 9 | the backup instruction mishandles `client_secret` | **Accepted** — R4.3 forbids file/log/repo copies; the row is its own backup |
| 10 | tenant isolation criteria missing | **Accepted** — R1.7, no new generic update path, cross-tenant rejection test |
| 11 | acceptance split too generous | **Accepted** — §7 rewritten; the create-payload, metadata survival, cross-tenant, exact logo URI and pagination request bodies are all machine gates now |
| 12 | rescan identity is a data-integrity hazard, and no rescan UI exists | **Accepted as scoped-out with detection** — §2 states the hazard in full; R1.8 adds `number_mismatch` logging without attempting migration |

## 7. Acceptance criteria

**Machine-verifiable — these gate the merge:**

- Part 1: the `create_and_get_qr` payload carries the name; validation
  (trim/60/non-empty/reject); precedence — user name wins, `profileName` fills
  only when `display_name` is absent, a reconnect does **not** overwrite a
  user-set name **from any of the three call sites**; `account_metadata` merge
  preserves `connection_mode` and the consent keys; `platform_user_id`
  untouched; a cross-tenant account id is rejected; `number_mismatch` is set
  when the owner number differs from a non-`pending_` id.
- Part 3: multi-page accumulation returned as one array; stop on short page;
  stop at `pages`; 20-page ceiling logs; **bare array treated as one page and
  not re-requested**; malformed/missing `pages` handled; cross-page duplicate
  ids collapse through the existing `messageRows` dedup; the time budget stops
  between chats and logs done/remaining.
- Part 4: the registration body carries `client_uri` and a `logo_uri` that is
  **exactly** `https://postora.cloud/favicon.png`.
- `deno check` on every changed function; `deno test supabase/functions/_shared/`
  at or above the **183 passed / 8 failed** baseline (those 8 are pre-existing
  in `whatsappPartnerOps.test.ts` and neighbours — establish the baseline before
  reading that suite's red as a regression); `npx tsc --noEmit`; `npm test` at
  or above **663 passed / 15 skipped / 0 failed**; `npm run build`.
- `clean-code-guard` and `test-guard` clean.

**User-verifiable — follow-up, cannot gate a merge:**

- the rename dialog reads well and the chosen name shows on the messaging page;
- a **newly paired** phone shows "Postora" under Linked Devices;
- the Higgsfield consent screen shows the Postora logo;
- a long-history account imports more than one page into `whatsapp_messages`.

## 8. Deployment

1. Merge to `main` (frontend auto-deploys).
2. `ssh-contabo-mcp`: SHA-diff and copy changed `supabase/functions/**` into the
   functions volume, restart the functions container.
3. **Dokploy UI:** set `CONFIG_SESSION_PHONE_CLIENT=Postora` on the Evolution
   service, redeploy it (brief session reconnect).
4. **Post-deploy:** read the existing `oauth_clients` row's
   `registration_response`; RFC 7592 in-place PUT if supported, else targeted
   delete + immediate re-authorization. No secret leaves the database.
