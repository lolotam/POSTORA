# WhatsApp Chat Overhaul Implementation Plan

> **For agentic workers:** implement phase-by-phase, in order. Each phase is one PR and must be reviewable on its own. Do not batch phases.

**Revision 3** — after two Codex adversarial review rounds. Revision 3 rewrote the message-cache design again (an accumulating store plus a mutable-state overlay, replacing the two-snapshot merge), made the composition root concrete, and defined media admission control and revoke reconciliation. Do not work from revision 1 or 2.

**Goal:** Make `/messaging/whatsapp/conversations` look and behave like the WhatsApp application — full-height layout with collapsing chrome, inline media, newest-first paginated history, a restyled collapsed nav rail, per-message copy/pin/delete actions, a real voice-note recorder, and single/multi chat export.

**Architecture:** The WhatsApp inbox is **forked into a new feature module**, not edited in place. `MessagingInbox.tsx`, `ConversationDetail.tsx` and `MessageBubble.tsx` are shared by four call sites — including `src/pages/BrandIntelligence.tsx:367`, which renders `<MessagingInbox />` with no `platform` prop and would be wrecked by a viewport-height layout. `ARCHITECTURE.md` §2 states `src/features/` does not exist yet and that "the first substantial new feature creates the directory."

**Tech Stack:** React 18, TypeScript, Vite, Tailwind, shadcn/Radix, TanStack Query v5, Deno edge functions, self-hosted Supabase + Postgres RLS, Evolution API 2.3.7 (Baileys, ffmpeg 8.1.2 in-container).

**Spec:** `docs/specs/2026-08-25-whatsapp-chat-experience.md` revision 2 — read it first. Its §3, §4, §6 and §7 are binding.

---

## Global Constraints

- **Required reading before any edit under `src/**` or `supabase/functions/**`:** `ARCHITECTURE.md`. Binding sections: §4 (dependency direction), §8, §9, §10, §11, §12–17, §20/§21, §23, §26, §31, §33/§34, §35, §36.
  **Zero Dead Modules** lives at `ARCHITECTURE.md` **lines 66-90**, a subsection of §1. The document ends at §47; there is no §66. The rule: every new module needs a named non-test production caller landed **in the same change**.

- **Wiring is part of every task.** No task may end with a component that only its own test renders. Each task below names the composition file it edits and the line it adds. If you finish a task and cannot point at a non-test file that renders or calls the new module, the task is not done.

- **Files that must end this work byte-identical** (the scope fence):
  - `src/components/messaging/MessagingInbox.tsx`, `ConversationDetail.tsx`, `MessageBubble.tsx`
  - `src/pages/messaging/FacebookMessaging.tsx`, `src/pages/messaging/InstagramMessaging.tsx`
  - `src/pages/BrandIntelligence.tsx`
  - anything under `src/components/messaging/threads/`
  - `src/pages/History.tsx`, `src/components/post/BulkScheduler.tsx`, `src/components/messaging/contacts/ContactExportMenu.tsx`

  One deliberate exception, stated in its phase: `ConversationList.tsx` gains three **optional** props (Phase 6).

- **Gates**, from `F:/Postora_wa_chat`: `bun run test`, `npx tsc --noEmit`, `bun run lint`, plus the Deno tests where the phase touches `supabase/functions/**`.

- **Dependency budget: exactly one**, `fflate`, in Phase 6. `@radix-ui/react-context-menu`, `context-menu.tsx`, `alert-dialog.tsx`, `papaparse`, `date-fns` and two lightboxes already exist. CI runs `bun install --frozen-lockfile` (`.github/workflows/test.yml:26,69`), so **`bun.lock` must be updated**, and `package-lock.json` in the same commit.

- **Edge-function deploy — use the runbook's command, not `up -d`.** `docs/runbooks/deploy-edge-function.md:92-101` states that `docker compose up -d --no-deps functions` "prints `Container ... Running` and does nothing when the compose config is unchanged — the container keeps serving the old code, so the deploy looks successful and isn't." Function sources are a bind mount, so the correct command is:
  ```
  docker compose restart functions
  ```
  (`up -d --force-recreate --no-deps functions` is only for env-var changes.) Every phase's deploy step must **enumerate every file copied** — the function directory *and* each `_shared` file it newly imports — and verify SHA256 against the repository copy before restarting. A new `_shared` module that is not copied makes the import fail at runtime.

- **Migrations do not auto-apply.** Rehearse on a throwaway database inside the prod container (`supabase start` is broken locally), apply over `ssh-contabo-mcp`, and regenerate `src/integrations/supabase/types.ts` in the same change.

- **`main` auto-deploys the frontend**, so backend changes deploy *before* their PR merges. Any contract change must therefore be safe for the **currently deployed** frontend, not only the new one.

- **TanStack Query v5 object form only.** `useQuery(key, fn)` positional syntax is not valid v5; every query in this plan uses the object form, and every `useInfiniteQuery` declares `initialPageParam`.

- **Testing:** vitest, colocated. `userEvent` is unusable — use `fireEvent`. Already mocked in `src/test/setup.ts`: `IntersectionObserver` (:19), `scrollIntoView` (:52), `navigator.clipboard` (:62). **`MediaRecorder` and `getUserMedia` are not mocked** — hand-write them. Comment regression tests with the date and symptom, matching `src/lib/messageOrder.test.ts`.

---

## Module layout

```
src/features/whatsapp-inbox/
├── domain/                        # pure: no React, no Supabase, no Radix
│   ├── whatsappCapabilities.ts
│   ├── messageCursor.ts           # cursor codec + page merge/dedupe
│   ├── voiceNotePolicy.ts
│   ├── mediaKind.ts
│   ├── scrollAnchor.ts
│   └── conversationTranscript.ts
├── application/
│   ├── ports.ts                   # the interfaces application code depends on
│   ├── useWhatsAppMessages.ts
│   ├── useWhatsAppMedia.ts
│   ├── useWhatsAppMessageActions.ts
│   ├── useVoiceRecorder.ts
│   └── useConversationExport.ts
├── infrastructure/
│   ├── whatsappInboxApi.ts        # implements ports.ts; the only messaging-api caller
│   └── downloadBlob.ts            # reached through the port, never imported by ui/ directly
├── ui/ (see phases)
└── index.ts                       # exports { WhatsAppInboxScreen }
```

**Dependency direction (ARCHITECTURE.md §4, lines 212-246):** `ui → application → domain`. Application code depends on **ports it defines**, not on infrastructure. `infrastructure/whatsappInboxApi.ts` *implements* `application/ports.ts`.

**The composition root is concrete, not aspirational.** Saying "a boundary injects it" without naming the boundary is how the last revision left every hook unable to reach the adapter:

- `ui/WhatsAppInboxApiProvider.tsx` (created in Task 2.3) is a React context holding a `WhatsAppInboxApi` — the interface from `application/ports.ts`.
- `ui/WhatsAppInboxScreen.tsx` is the **composition root**: it constructs `createWhatsAppInboxApi()` from `infrastructure/` once, memoized, and renders the provider around the whole feature. This is the single place in the feature that imports `infrastructure/*`.
- Every `application/*` hook obtains its dependency with `useWhatsAppInboxApi()` and imports **only** `application/ports.ts`. Tests inject a fake through the same provider, which is also what makes them cheap.
- **Every phase that adds a capability names three edits: `application/ports.ts`, `infrastructure/whatsappInboxApi.ts`, and the consuming component.** A phase that adds a hook without extending the port has not wired anything.
- Enforced, not merely documented: an ESLint `no-restricted-imports` rule forbidding `**/infrastructure/**` from `application/**` and `domain/**`, plus a test asserting the same by reading the files. Added in Task 2.3 alongside the first adapter.
- `ui/WhatsAppExportDialog.tsx` therefore takes its download helper through the port too, rather than importing `infrastructure/downloadBlob` directly — otherwise Phase 6 reintroduces exactly the violation this rule exists to stop.

Server-side, the same rule applies to `messaging-api/index.ts`, which is already 1,609 lines. Per §12 (lines 462-486) and §13 (lines 490-509) the entrypoint validates, authorizes, delegates and maps responses. **Media materialization, revoke, voice send, conversation state and page building each go in their own `_shared` module**, with the entrypoint calling them. Do not add orchestration inline.

**No server-side capabilities mirror.** An earlier revision proposed `_shared/whatsappCapabilities.ts` as a canonical twin of the frontend module. It is deleted from this plan: no task created, called, tested or deployed it, which made it an orphan contract of exactly the kind the Zero Dead Modules rule exists to prevent. Server-side capability checks live where the transport is resolved, expressed as the `supportsMessageRevoke` / `supportsVoiceNote` type guards (§20) — the transport that cannot do a thing simply does not implement the interface, which is a stronger guarantee than a parallel table that can drift.

---

## Phase 1 — Layout, chrome, and the collapsed rail

Frontend only, no deploy. Fixes R5 and R6; delivers §5.1 and §5.4.

Phase 1 creates **both** the screen and the conversation pane, because the header-collapse trigger needs the pane's scroller. A phase cannot depend on a component a later phase creates.

### Task 1.1: Fork the screen, the pane, and the bubble

**Files:**
- Create: `ui/WhatsAppInboxScreen.tsx`, `ui/WhatsAppConversationPane.tsx`, `ui/WhatsAppMessageBubble.tsx`, `index.ts`
- Modify (**the wiring**): `src/pages/whatsapp/Conversations.tsx`
- Test: `tests/WhatsAppInboxScreen.test.tsx`, `tests/scopeFence.test.ts`

**Interfaces produced:**
```ts
export function WhatsAppInboxScreen(): JSX.Element;              // no props; owns account + conversation state
export function WhatsAppConversationPane(props: {
  conversation: Conversation | null; socialAccountId: string; pageId: string;
  onScrollStateChange(scrolledAway: boolean): void;
}): JSX.Element;
export function WhatsAppMessageBubble(props: { message: WhatsAppMessage; isSent: boolean }): JSX.Element;
```
Later phases extend `WhatsAppMessageBubble` and `WhatsAppConversationPane`; they exist from Phase 1 so nothing is created twice or modified before it exists.

- [ ] **Step 1: Write the failing tests**

```tsx
// Regression guard, 2026-08-25: the chat was a hard h-[600px] inside a min-h-[640px] page
// inside an overflow-y-auto main, giving nested scrollbars and dead space on tall screens.
it("sizes to its flex parent instead of a fixed pixel height", () => {
  renderWithProviders(<WhatsAppInboxScreen />);
  const shell = screen.getByTestId("wa-inbox-shell");
  expect(shell.className).toContain("min-h-0");
  expect(shell.className).not.toMatch(/h-\[\d+px\]/);
});

it("keeps the setup panel expanded and non-collapsible with no account connected", () => {
  renderWithProviders(<WhatsAppInboxScreen />, { accounts: [] });
  expect(screen.getByTestId("wa-setup-panel")).toBeVisible();
  expect(screen.queryByRole("button", { name: /connection details/i })).not.toBeInTheDocument();
});

it("renders the conversation list and thread as siblings that each scroll independently", () => {
  renderWithProviders(<WhatsAppInboxScreen />);
  expect(screen.getByTestId("wa-conversation-list").className).toContain("min-h-0");
  expect(screen.getByTestId("wa-message-pane").className).toContain("overflow-y-auto");
});
```

```ts
// tests/scopeFence.test.ts — the WhatsApp screen is a fork. MessagingInbox is still rendered
// by BrandIntelligence.tsx:367 with no platform prop, so its layout must survive untouched.
it("leaves the shared MessagingInbox layout alone", () => {
  const src = readFileSync("src/components/messaging/MessagingInbox.tsx", "utf8");
  expect(src.match(/h-\[600px\]/g)).toHaveLength(3);
});
```

- [ ] **Step 2: Run and confirm failure.** `bun run test whatsapp-inbox`

  Note what these assertions are and are not: matching Tailwind class strings is a **tripwire against regression**, not proof that the pane scrolls independently or fills the viewport. The manual browser checks at the end of this plan carry that burden and are not optional.

- [ ] **Step 3: Implement the screen.** Copy `MessagingInbox.tsx:130-181` and keep every behaviour that already works — `useMessagingAccounts`, `useConversations(accountId, "WHATSAPP")`, `useWhatsAppLabels` + `LabelFilter`, `AccountSelector`, `NewConversationDialog`, `<WhatsAppSetup>` unmodified, and the deep-link effect at `MessagingInbox.tsx:60-80` (`parseInboxRoute` / `withInboxRoute`) copied **exactly**, including the deliberate "an unknown `chat` id selects NOTHING" rule.

  Layout: `flex h-full min-h-0`, `<aside className="hidden lg:flex w-80 shrink-0 border-r flex-col min-h-0">`, `<section className="flex-1 min-w-0 flex flex-col min-h-0">`. **`min-h-0` on every flex child is the mechanism** — a flex child without it refuses to shrink below content height and the inner `overflow-y-auto` never engages, which is the actual cause of the nested scrollbars.

- [ ] **Step 4: Implement single-pane mobile (spec §5.1).** Below `lg` the `w-80` rail and the thread cannot coexist. Render list *or* thread based on whether a conversation is selected, with a back button in the thread header. Without this, Phase 4's long-press and the `100dvh` work are meaningless.

- [ ] **Step 5: Implement the pane and the bubble** as straightforward ports of `ConversationDetail.tsx:240-284` and `MessageBubble.tsx` — same rendering, no new behaviour yet. Later phases add paging, media, actions and the composer. The pane calls `onScrollStateChange` from its `onScroll`.

- [ ] **Step 6: Wire it.** `src/pages/whatsapp/Conversations.tsx` becomes a composition boundary (§8): render `<WhatsAppInboxScreen />`, **delete `WhatsAppPageHeader` and the `min-h-[640px]` wrapper**. This is the production caller that satisfies Zero Dead Modules for the whole feature module.

- [ ] **Step 7: Gates, then commit** `src/features/whatsapp-inbox/` and `src/pages/whatsapp/Conversations.tsx`.

### Task 1.2: Immersive chrome and the connection chip

**Files:**
- Create: `src/components/whatsapp/WhatsAppChromeContext.tsx`, `ui/WhatsAppConnectionStatusChip.tsx` (+ test)
- Modify (**the wiring**): `src/components/whatsapp/WhatsAppLayout.tsx`, `ui/WhatsAppInboxScreen.tsx`, `src/pages/whatsapp/Conversations.tsx`

- [ ] **Step 1: Write the failing tests** — the chip is collapsed by default with ≥1 active account; expanded and non-collapsible at zero; state persists under `postora.whatsapp.setupExpanded`; renders without throwing when `localStorage` throws.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the chip** — green dot, `platform_username` or phone, mode badge (`Direct QR` / `Cloud API` / `Coexistence`), chevron — wrapping the unmodified `<WhatsAppSetup>` in a shadcn `Collapsible`. Copy the try/catch `localStorage` guard from `WhatsAppLayout.tsx:17-23`; privacy-mode browsers throw on access, and that guard is why the existing sidebar does not crash. **Wire it into `WhatsAppInboxScreen` in this step**, replacing the bare `<WhatsAppSetup>`.

- [ ] **Step 4: Add the chrome context and modify the shell.**
  - `:53` — `h-[100dvh]` with an `h-screen` fallback; on iOS Safari `h-screen` includes the collapsing URL bar and clips the composer. Flag this for the reviewer: it affects all 14 WhatsApp routes.
  - `:97` — **already has `min-h-0`** (`className="flex min-h-0 flex-1"`); leave it.
  - `:54-95` — when `compact`: drop the subtitle `<p>` at `:79-81`, shrink the logo circle `h-11 w-11 → h-8 w-8`, reduce padding. Use a `transition-all duration-200` **class swap, not conditional unmounting**, so focus is never lost. Skip the transition (not the collapse) under `prefers-reduced-motion`.
  - `:124` — `cn("wa-app min-w-0 flex-1", immersive ? "overflow-hidden" : "overflow-y-auto ...")`.
  - `:125` — `cn(immersive ? "flex h-full min-h-0 flex-col" : "space-y-6 px-4 py-6 sm:px-6 lg:px-8")`. `<WhatsAppCoexistenceSetupBanner />` stays in the non-immersive branch and moves into the chip's expanded panel on the immersive route.

- [ ] **Step 5: Define the collapse contract precisely.** On this route `<main>` no longer scrolls, so the trigger is the pane's `onScrollStateChange` from Task 1.1. The contract, stated once so requirement and test agree: **compact when the pane's `scrollTop > 72`; expanded when `scrollTop < 24`; unchanged in between.** It is position-based hysteresis, not direction-based, so a pixel of jitter cannot oscillate the header. Debounce with `requestAnimationFrame`, not a timer. Test both thresholds and the dead band.

- [ ] **Step 6: Set `immersive` from `Conversations.tsx`** on mount and clear it on cleanup.

- [ ] **Step 7: Gates, then commit.**

### Task 1.3: Collapsed nav rail

**Files:** modify `src/components/whatsapp/WhatsAppNavList.tsx:36,43`; test `WhatsAppNavList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// 2026-08-25: the 68px rail kept h-4 w-4 icons, so a 16px glyph floated in 68px of space.
it("renders larger icons when collapsed", () => {
  const { container } = render(<MemoryRouter><WhatsAppNavList collapsed /></MemoryRouter>);
  expect(container.querySelector("svg")?.getAttribute("class")).toContain("h-5 w-5");
});
it("keeps the accessible name when collapsed", () => {
  render(<MemoryRouter><WhatsAppNavList collapsed /></MemoryRouter>);
  expect(screen.getByRole("link", { name: /conversations/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run and confirm the first fails.**
- [ ] **Step 3: Implement.** `:43` → `<Icon className={cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4")} />`. `:36` collapsed row → `justify-center px-0 py-2.5 mx-auto h-11 w-11 rounded-xl`, active fill on the tile. **Do not touch** the `sr-only` label at `:44-45` or the tooltip at `:51-56`.
- [ ] **Step 4: Gates, then commit.**

**Deploy:** none.

---

## Phase 2 — Media

Backend + frontend. Deploy required. Fixes R1.2 and R3; delivers §5.6.

**Design: lazy materialization with server-side signed URLs.** On first view the edge function tries `createSignedUrl` on a deterministic path; on a miss it fetches through the existing fetchers, uploads with the service role, and signs. Idempotent, no backfill.

Rejected, and why it matters: a *public bucket* would expose every customer's photos to URL guessing; *client-side signing* is impossible for a workspace agent whose `auth.uid()` will not match the object's owner prefix; a *header-bearing proxy* cannot work because `<img src>` sends no headers; *eager materialization at ingest* is better but adds a download to the webhook hot path and needs a 527-row backfill — **recommended as the immediate follow-up**, deliberately not built here.

Storage layout, inside the existing private `media` bucket:
```
{owner_user_id}/whatsapp/inbound/{whatsapp_messages.id}.{ext}    # service-role written
{auth.uid()}/whatsapp/outbound/{buildPostoraFileName(...)}        # client written, RLS-legal
```

### Task 2.1: `_shared/whatsappMediaResolver.ts` and the `whatsapp_get_media` action

**Files:**
- Create: `supabase/functions/_shared/whatsappMediaResolver.ts` + test
- Modify (**the wiring**): `messaging-api/index.ts` (register + delegate), `messaging-api/whatsappAccess.ts` (role `viewer`)

**Contract:** request `{ social_account_id, message_row_ids[] }`; response `{ media: [{ message_row_id, kind, url, expires_in, mime_type, file_name, size_bytes }] }` or per row `{ url: null, error: "MEDIA_UNAVAILABLE" }`.

- [ ] **Step 1: Write the failing tests** — a cached object is signed without calling any fetcher; a miss selects `EvolutionFetcher` for `evolution_qr` and `CloudGraphFetcher` otherwise; a row on another account is refused; a fetcher failure yields `MEDIA_UNAVAILABLE` and never leaks the provider message; **a null or `sched_`-prefixed `message_id` is refused without calling the provider**; and the aggregate budget admits only one unknown-size fetch at a time, reconciles the reservation to the real size afterwards, and the batch deadline delivers a real `AbortError` to an in-flight fetch rather than merely abandoning it.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the resolver module.** Reuse `selectFetcher` + `fetchMediaBytes` from `_shared/inboundMediaFetchers.ts` — **do not write a fourth fetcher.**

  **Memory budget, and why it is not just a per-item cap.** `EvolutionFetcher` (`inboundMediaFetchers.ts:327-353`) calls `response.json()`, retains the encoded string, decodes with `atob` into a binary string, then allocates a `Uint8Array` — so one 16MB file transiently occupies several multiples of 16MB across four representations, plus the upload buffer. Eight concurrent worst-case items is hundreds of megabytes in an isolate whose limit this repo cannot verify. Therefore:
  - **max 10 rows per request** (not 25),
  - **max 2 concurrent** materializations,
  - **admission by reservation, not by measurement.** A budget "checked before each fetch starts" is useless here: the size is unknown until the response has already been parsed, so two concurrent fetches both pass a zero-byte precheck and then allocate. Instead, each item **reserves the per-item maximum (16MB) up front** against a 24MB aggregate budget — so exactly one unknown-size fetch is admitted at a time — and the reservation is **reconciled down to the actual byte count** once known, freeing headroom for the next. Where `media_metadata` carries a trustworthy size, reserve that instead and admit more in parallel. Rows that cannot be admitted return `MEDIA_UNAVAILABLE` with a retryable flag.
  - a 20s wall-clock deadline that genuinely **aborts** in-flight fetches. This needs a change to the shared fetcher: `timedFetch` currently owns a private `AbortController` (`inboundMediaFetchers.ts:184-185`) and accepts no external signal, so a deadline outside it can only stop awaiting, not stop allocating. Add an **optional external `signal`** to `fetchMediaBytes` and compose it with the internal timeout controller. This is an additive change to a file the inbound pipeline also uses: re-run its existing tests, and enumerate it in this phase's deploy.

  Cache to `{owner_user_id}/whatsapp/inbound/{row.id}.{ext}` with `{ contentType, upsert: true }`, write the storage path back to `media_url` so the second view is a plain signed lookup, then sign for 3600s. `file_name` and `size_bytes` come from `media_metadata` and the stored object — `FetchedMedia` (`inboundMediaFetchers.ts:85-88`) carries neither, so both are optional in the contract and the UI degrades without them. **Never return 5xx for an application error** — Cloudflare replaces the body and the real reason is lost.

- [ ] **Step 4: Register the action in `index.ts` as a thin delegation** (§12) — validate, authorize with `withWhatsAppActionAccess`, call the resolver, map the response. No orchestration inline.
- [ ] **Step 5: Gates, then commit.**

### Task 2.2: Response contract — provider id, direction, revocation, understanding, typed attachments

**Files:**
- Create: `supabase/functions/_shared/whatsappMessageView.ts` + test (the row → API shape mapper), `src/features/whatsapp-inbox/domain/mediaKind.ts` + test
- Modify: `messaging-api/index.ts:1291-1298,1326-1387`

- [ ] **Step 1: Write the failing tests** for the mapper — `provider_message_id` from `m.message_id` (**named this, not `wamid`**: for QR rows it holds a Baileys `key.id`, which is not a Meta Cloud wamid); `direction`; `revoked_at`, `revoked_by` and `status` (the export's CSV column needs it, and it is one of the mutable fields the overlay carries); `media_understanding`; `attachments` typed with `kind` from `media_type` (`sticker` renders as an image — 26 live rows) and `[]` when `media_type IS NULL`; `file_url` retained for back-compat (§36).
- [ ] **Step 2: Run and confirm failure. Step 3: implement the mapper and use it in the action.**

  `revoked_at` in the response is what makes a teammate's delete-for-everyone visible to other workspace members. Without it the column is written and never read.

- [ ] **Step 4: Add `media_path` to `whatsapp_send_media`.** Assert the prefix is the caller's own uid — reject `../`, an absolute URL, and a foreign uid — then mint a 7-day signed URL server-side and pass that to `transport.sendMedia`. Persist the **durable storage path**, not the expiring signed URL, into `media_url`. Comment that `media_url` now holds either an `http(s)://` provider URL or a bucket-relative path, and that `whatsapp_get_media` branches on the prefix. Existing `media_url` callers are untouched.
- [ ] **Step 5: Gates, then commit.**

### Task 2.3: Media rendering and the outbound upload fix

**Files:**
- Create: `application/ports.ts`, `infrastructure/whatsappInboxApi.ts`, `ui/WhatsAppInboxApiProvider.tsx`, `application/useWhatsAppMedia.ts`, `ui/WhatsAppMediaAttachment.tsx`, `ui/VoiceNotePlayer.tsx` (+ tests), `tests/architecture.test.ts`
- Modify (**the wiring**): `ui/WhatsAppInboxScreen.tsx` becomes the composition root and renders the provider; `ui/WhatsAppMessageBubble.tsx` renders `WhatsAppMediaAttachment`; `ui/WhatsAppConversationPane.tsx` gains the fixed composer upload; `eslint.config.js` gains the `no-restricted-imports` rule

- [ ] **Step 1: Write the failing tests** — `kind: "image"` renders an `<img>`; `video` renders `<video controls preload="metadata">`; `audio` renders the player with a scrubber, and its duration resolves from all three sources in order — `media_metadata.duration_seconds`, then the loaded element, then **elapsed-only when neither is available** (the absolute "always shows a duration" phrasing was wrong); `document` renders filename and size **and degrades to a generic label when the source provides neither**; and a `{ url: null, error }` row renders the **"unavailable" placeholder, not a download link** — for the 527 zero-URL rows there is no download target.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Define `ports.ts` first**, then implement `whatsappInboxApi.ts` against it. The adapter carries the 3× retry on 502/503/504 from `useMessaging.ts:80-88`; the duplicated copy at `ConversationDetail.tsx:25-46` lacks it and the fork must not inherit that.
- [ ] **Step 4: Implement `useWhatsAppMedia`** — a batched query keyed `["wa-media", socialAccountId, sortedRowIds]`, `staleTime: 50 * 60_000` (under the 1h signature), collecting ids as bubbles enter the viewport via `IntersectionObserver`, in batches of 10. A 707-message thread must not fire hundreds of recovery calls on mount. Note this bounds the *browser*, not one server batch — Task 2.1's aggregate budget is what bounds the server.
- [ ] **Step 5: Implement the renderers.** Images `max-h-72`, `loading="lazy"`, click opens a lightbox — reuse `src/components/post/MediaLightbox.tsx`, do not add a dependency; Esc closes, ←/→ walk the conversation's images. Video: native controls; a poster only where derivable without client-side decoding, otherwise native first-frame. Audio: duration from `media_metadata.duration_seconds`, else from the loaded element's `durationchange`, else elapsed-only. `media_understanding` in a collapsible captioned "AI description".
- [ ] **Step 6: Fix the outbound upload in the pane's composer.** Upload to `` `${user.id}/whatsapp/outbound/${await buildPostoraFileName(user.id, ext)}` `` — this is what makes the storage INSERT policy pass — then send `{ media_path }`. Reuse `buildPostoraFileName`. Keep the 16MB guard, invalidate the message query on success, and revoke the preview object URL on the success path.
- [ ] **Step 7: Verify live.** Send an image; over `ssh-contabo-mcp` confirm the newest `storage.objects` row for bucket `media` begins with the sender's uuid; confirm arrival on a real handset. A signed URL the provider cannot fetch fails silently — that is the failure this removes.
- [ ] **Step 8: Gates, then commit.**

**Deploy:** copy `messaging-api/` **and** `_shared/whatsappMediaResolver.ts`, `_shared/whatsappMessageView.ts`; verify SHA256 for each; `docker compose restart functions`; smoke-test inbound ingest as well as the new action.

---

## Phase 3 — Paging, scroll anchoring, mark-read

Backend + migration + frontend. Fixes R2; delivers §5.3.

### Task 3.1: Keyset index

**Files:** create `supabase/migrations/<ts>_whatsapp_messages_keyset_index.sql`

- [ ] **Step 1: Write it** — exactly one statement, no transaction block, since `concurrently` cannot run inside one:

```sql
-- whatsapp_get_messages filters (social_account_id, conversation_id) and pages on
-- (timestamp DESC, id DESC). None of the four existing indexes serves that: the composite
-- idx_whatsapp_messages_conversation leads with user_id, which this query never filters on.
create index concurrently if not exists idx_whatsapp_messages_account_conv_keyset
  on public.whatsapp_messages (social_account_id, conversation_id, "timestamp" desc, id desc);
```

- [ ] **Step 2: Rehearse, apply over `ssh-contabo-mcp`, confirm with `\di`. Step 3: commit.**

### Task 3.2: Cursor — additive, and legacy-safe

**Files:** create `supabase/functions/_shared/whatsappMessagePage.ts` + test; modify `messaging-api/index.ts:1258-1300`

**Contract:**
- **No pagination fields → 100 rows, the same top-level envelope, the same ordering, the same cardinality, and no `page_info`.** This is not a nicety: the backend deploys before the frontend merges, and the currently deployed client would otherwise silently drop from 100 reachable messages to 40 with no pagination controls.

  Precisely what "backward compatible" means here, because "exactly today's shape" was self-contradictory in revision 2: the **envelope** is unchanged (same key, same ordering, same count, no new top-level keys), while **message objects gain additive fields** (`provider_message_id`, `direction`, `revoked_at`, `revoked_by`, `status`, `media_understanding`, typed `attachments` alongside the retained `file_url`). Additive object properties are safe for the deployed client, which reads named fields and ignores the rest — and they are required, because the new latest cache uses this same legacy call and needs them. Test both facts: an old-client projection over the response still resolves, and the fields the latest cache needs are present.
- `limit` (default 40 **only when the caller paginates**, cap 100) and `before: { timestamp, id }` → adds `page_info: { next_before, has_more }`.

- [ ] **Step 1: Write the failing tests** — a legacy call (no `limit`, no `before`) returns 100 rows and **no `page_info`**; a paginated call defaults to 40; cursor round-trip; a malformed cursor throws rather than silently returning page one; `clampLimit` handles `undefined`, `0`, `5000`, `"abc"`.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement, and mind the PostgREST trap.** The installed client **appends duplicate `or` parameters** (`PostgrestFilterBuilder.ts:2039-2048`), so two top-level `.or()` calls silently produce the wrong SQL. Rewrite the existing conversation `.or()` at `:1278` as `.in("conversation_id", [normalizedConvId, conversation_id])` — behaviourally identical, since `eq OR eq` is `in` — which frees the single `.or()` slot for `` .or(`timestamp.lt.${ts},and(timestamp.eq.${ts},id.lt.${id})`) ``. Compute `has_more` by requesting `limit + 1` and trimming.
- [ ] **Step 4: Gates, then commit.**

### Task 3.3: Two queries, not a capped infinite query

**Files:** create `domain/messageCursor.ts`, `domain/scrollAnchor.ts`, `application/useWhatsAppMessages.ts` (+ tests); modify (**the wiring**) `application/ports.ts` (adds `getMessagesPage`), `infrastructure/whatsappInboxApi.ts` (implements it), `ui/WhatsAppConversationPane.tsx` (consumes the hook)

**Why this shape.** The obvious design — one `useInfiniteQuery` with `refetchInterval` and `maxPages` — is broken. TanStack v5 appends an older page and **evicts the first** (`query-core/src/utils.ts:392-399`); interval refetch then starts from the retained `oldPageParams[0]` and walks that retained chain (`infiniteQueryBehavior.ts:97-110`). After enough history pages the newest page is gone, polling no longer requests it, and **new messages silently stop appearing** with no `getPreviousPageParam` route back. `staleTime` does not change explicit `refetchInterval` behaviour. Removing the cap instead means re-fetching the entire loaded history every 15 seconds.

So: **an accumulating store fed by two queries plus a mutable-state overlay.**

```ts
// application/useWhatsAppMessages.ts
export function useWhatsAppMessages(socialAccountId: string, conversationId: string | null): {
  messages: WhatsAppMessage[];        // accumulated, deduped, oldest-first
  isLoading: boolean;
  hasOlder: boolean;
  isFetchingOlder: boolean;
  fetchOlder(): void;
};
```

**The store accumulates; it never renders a concatenation of two snapshots.** This is the correction for the defect that sank the previous design twice over:

- The latest query returns a *moving* newest-N window. When ten new messages arrive, ten formerly-newest rows fall out of the next response. Rendering `latest ∪ historyPages` would make those ten **disappear from the thread** unless history happened to have fetched them.
- So `useWhatsAppMessages` keeps a `Map<rowId, WhatsAppMessage>` per `(socialAccountId, conversationId)`. Every latest poll and every history page **merges into** it and nothing is ever removed while the conversation is open. Switching conversation or account discards the store wholesale.
- **Duplicate ids resolve to the freshest representation**, not "first wins" — an older history copy must never overwrite a newer polled one. Freshness is decided by the mutable fields below, not by arrival order.

Query shapes (TanStack v5 object form — the positional form is not valid v5):

```ts
useQuery({ queryKey: ["wa-latest", socialAccountId, conversationId], queryFn, refetchInterval: 15_000 })
useInfiniteQuery({
  queryKey: ["wa-history", socialAccountId, conversationId],
  queryFn, initialPageParam: undefined,
  getNextPageParam: (last) => last.page_info.next_before,
  refetchInterval: false,                    // no maxPages: history pages are fetched once
})
```

- **Latest** uses the legacy call shape and is the only freshness source. It is never evicted.
- **History's first cursor is anchored at the oldest row currently in the store**, not left unanchored. Unanchored, the first history page would fully overlap the latest window, add no DOM height, and the top sentinel would never fire again — the "load older" path would silently dead-end.
- **Every message query key includes `socialAccountId`**, or a re-pair or account switch reuses another account's cache. Late responses from a previous conversation are discarded by checking the key against the current selection before merging.

**Mutable state is an overlay, not a property of the cached body.** History is *not* immutable, and more fields change than is obvious. Old rows are mutated by at least three writers: `whatsapp-webhook/index.ts:563-595` (delivery status and errors), `_shared/inboundMediaPipeline.ts:242-259` (`media_understanding`, written asynchronously well after ingest), and this work's own revocation. The existing realtime invalidation cannot cover them for a workspace teammate — it is owner-filtered (`useRealtimeQueryInvalidation.ts:43-53`). Therefore:

- `whatsapp_get_conversation_state` (Task 4.2) returns, for the row ids currently in the store, `{ revoked_at, revoked_by, status, media_understanding }` plus the viewer's flags. It is polled on the same 15s cadence as latest and is workspace-authorized, so a teammate's revoke, a delivery-status change and a late AI description all land without refetching message bodies.
- **Merge authority is explicit: the overlay wins for the fields it carries; the body wins for everything else.** This is what makes "revoked is visible to every workspace member" true rather than "true after you close and reopen the conversation".
- `media_url` write-back by the media resolver is *not* a staleness problem: media is fetched through the separately-keyed `["wa-media", ...]` query, never read off the cached row.
- Any future field that mutates on an old row must be added to the overlay, or this design silently starts lying.

Ordering uses the existing `sortMessagesForDisplay` from `src/lib/messageOrder.ts` — **import it, do not reimplement the tie-break**, or the two orderings drift.

- [ ] **Step 1: Write the failing tests**

```ts
// 2026-08-25: the pane force-scrolled to the bottom on every 15s poll because the effect
// keyed on the raw query array, whose identity changes on each refetch.
it("is true at the bottom", () => expect(shouldStickToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true));
it("is false while reading history", () => expect(shouldStickToBottom({ scrollTop: 100, scrollHeight: 1000, clientHeight: 100 })).toBe(false));
it("tolerates sub-pixel rounding", () => expect(shouldStickToBottom({ scrollTop: 899.6, scrollHeight: 1000, clientHeight: 100 })).toBe(true));
it("pins the read position when older messages prepend", () => expect(anchorOffsetAfterPrepend(1000, 1400, 0)).toBe(400));

it("dedupes a row that appears in both the latest and a history page", () => {
  expect(mergeMessagePages([A, B], [[B, C]]).map(m => m.id)).toEqual(["C", "B", "A"].reverse());
});
```

```tsx
// The bug this whole design exists to prevent: after several history pages, a bounded
// infinite-query cache evicts the newest page and new messages stop arriving forever.
it("still shows a new message after four history pages are loaded", async () => {
  const { result } = renderHook(() => useWhatsAppMessages("acct", "conv"));
  for (let i = 0; i < 4; i++) { act(() => result.current.fetchOlder()); await waitFor(() => !result.current.isFetchingOlder); }
  server.pushNewestMessage({ id: "brand-new" });
  await waitFor(() => expect(result.current.messages.at(-1)?.id).toBe("brand-new"));
  expect(result.current.hasOlder).toBe(true); // and older navigation still works
});

// The second, subtler loss: the latest window MOVES. Rows that fall out of it must survive
// in the store, or ten new arrivals silently delete the ten oldest visible messages.
it("keeps messages that roll out of the moving latest window", async () => {
  const { result } = renderHook(() => useWhatsAppMessages("acct", "conv"));
  await waitFor(() => expect(result.current.messages).toHaveLength(100));
  const rolledOut = result.current.messages[0].id;
  server.pushNewestMessages(10);                  // the window now excludes `rolledOut`
  await waitFor(() => expect(result.current.messages).toHaveLength(110));
  expect(result.current.messages.map(m => m.id)).toContain(rolledOut);
});

// An older history copy must never overwrite a newer polled one.
it("resolves a duplicate id to the freshest representation", async () => {
  const { result } = renderHook(() => useWhatsAppMessages("acct", "conv"));
  server.setLatest([{ id: "x", revoked_at: "2026-08-25T10:00:00Z" }]);
  await waitFor(() => expect(result.current.messages[0].revoked_at).toBeTruthy());
  act(() => result.current.fetchOlder());          // history still has the pre-revoke copy
  await waitFor(() => !result.current.isFetchingOlder);
  expect(result.current.messages.find(m => m.id === "x")?.revoked_at).toBeTruthy();
});

it("does not dead-end the older path when the first history page overlaps the latest window", async () => {
  // History is anchored at the oldest row in the store, so page one adds real height.
  const { result } = renderHook(() => useWhatsAppMessages("acct", "conv"));
  await waitFor(() => expect(result.current.messages).toHaveLength(100));
  act(() => result.current.fetchOlder());
  await waitFor(() => expect(result.current.messages.length).toBeGreaterThan(100));
});

it("discards a late response from a conversation the user already left", async () => {
  const { result, rerender } = renderHook(({ c }) => useWhatsAppMessages("acct", c), { initialProps: { c: "conv-a" } });
  server.delayNext("conv-a");
  rerender({ c: "conv-b" });
  server.flush("conv-a");
  await waitFor(() => expect(result.current.messages.every(m => m.conversation_id === "conv-b")).toBe(true));
});

it("does not corrupt the store when a poll lands mid-fetchOlder", async () => { /* interleave both */ });
```

- [ ] **Step 2: Run and confirm failure. Step 3: implement.** `shouldStickToBottom` → `scrollHeight - scrollTop - clientHeight <= 80`. `anchorOffsetAfterPrepend` → `previousScrollTop + (nextScrollHeight - previousScrollHeight)`.
- [ ] **Step 4: Implement the two queries and the merge.**
- [ ] **Step 5: Implement the scroll behaviour in the pane.**
  - Conversation change: after the first page paints, set `el.scrollTop = el.scrollHeight` **directly in a `useLayoutEffect`**. No `scrollIntoView`, no `behavior: "smooth"` — "no visible scroll animation" is then satisfied by construction.
  - Append at bottom: smooth-scroll only when `shouldStickToBottom` was true *before* the update; otherwise show a "↓ N new messages" pill.
  - Prepend: capture `scrollHeight` before the commit, restore via `anchorOffsetAfterPrepend` in `useLayoutEffect`.
  - `fetchOlder` from a top sentinel observed by `IntersectionObserver`, guarded by `hasOlder && !isFetchingOlder`.
- [ ] **Step 6: Wire mark-read, and mind the role trap.** Call the existing `useMarkConversationRead` on conversation select. **`whatsappAccess.ts:38` sets `whatsapp_mark_read` to minimum role `agent`, so a `viewer` gets 403 on every chat open.** Fire-and-forget with a swallowed error, and skip the call entirely for `viewer`. **Do not relax the policy to quiet the UI.**
- [ ] **Step 7: Behaviour tests** — selecting a conversation sets `scrollTop` once and never calls `scrollIntoView` (assert against the `src/test/setup.ts:52` mock); a refetch returning the same page does not re-scroll; a prepended page preserves the anchor.
- [ ] **Step 8: Gates, then commit.**

**Deploy:** migration; then copy `messaging-api/` **and `_shared/whatsappMessagePage.ts`** (a new runtime import — the function will fail without it), verify SHA256, `docker compose restart functions`.

---

## Phase 4 — Per-message actions

Migration + backend + frontend. Fixes R4; delivers §5.5.

### Task 4.1: Migration

**Files:** create `supabase/migrations/<ts>_whatsapp_message_flags.sql`

- [ ] **Step 1: Write it** exactly as spec §6 specifies: `revoked_at` / `revoked_by` on `whatsapp_messages` with the comment explaining why runtime ingest cannot clobber them; `whatsapp_message_flags` with `pinned_at` / `hidden_at`, `unique (user_id, message_row_id)`, RLS enabled, four policies all `auth.uid() = user_id`, and the existing `update_updated_at_column()` trigger.
  - **Only one extra index**: the partial `(user_id, pinned_at) where pinned_at is not null`. The unique constraint already indexes `(user_id, message_row_id)`; a second identical index is redundant.
  - **No UPDATE policy on `whatsapp_messages`** — revocation is privileged and goes through the edge function.
  - **Do not denormalize `social_account_id` or `conversation_id`** — `import_whatsapp_messages` rewrites both in place on a re-pair.
  - Comment the `on delete cascade` with the fact that `20260710100000:5-17` deleted rows once, so any future dedupe migration will take pins with it.
- [ ] **Step 2: Rehearse, then apply.** Verify per §23: a normal user reads and writes only their own rows; a second user sees zero; service role bypasses.
- [ ] **Step 3: Regenerate types and commit both together.**

### Task 4.2: Conversation state — viewer flags *and* the mutable-field overlay

**Files:** create `_shared/whatsappConversationState.ts` + test; modify (**the wiring**) `messaging-api/index.ts`, `whatsappAccess.ts`, `application/ports.ts`, `infrastructure/whatsappInboxApi.ts`, `application/useWhatsAppMessages.ts`

**Why an API and not a direct table read.** `whatsapp_messages` RLS is owner-only, so a workspace agent cannot join through it in the browser to scope flags by conversation, nor discover pins outside the loaded pages.

**Why one action rather than two.** The same per-conversation call that carries the viewer's flags also carries the **mutable-field overlay** Task 3.3 depends on. Merging them avoids a second poll on the same cadence, and it is the mechanism that makes "a revocation is visible to every workspace member" actually true — the alternative was "true after you close and reopen the conversation", which contradicts the spec.

**Contract.**
```jsonc
// request
{ "action": "whatsapp_get_conversation_state",
  "social_account_id": "uuid", "conversation_id": "wa_...",
  "message_row_ids": ["uuid"] }
// response
{ "flags":   [{ "message_row_id": "uuid", "pinned_at": "...", "hidden_at": null }],
  "pinned":  [{ "message_row_id": "uuid", "preview": "...", "timestamp": "..." }],
  "mutable": [{ "message_row_id": "uuid", "revoked_at": null, "revoked_by": null,
                "status": "delivered", "media_understanding": null }] }
```
`whatsapp_set_message_flag` takes `social_account_id`, **`conversation_id`**, `message_row_id`, and `pinned` and/or `hidden`. Both actions are role `viewer` — a viewer's own UI state is theirs to set — authorize with `withWhatsAppActionAccess`, and derive `user_id` from the authenticated session, never from the request body.

- [ ] **Step 1: Write the failing tests** — returns only the acting viewer's flags, scoped to the conversation; a teammate sees their own flags but the **same** `mutable` rows; `pinned` carries enough to render the bar **without loading that message's page**; `mutable` reflects a revocation made by a different member, a delivery-status change written by `whatsapp-webhook`, and a `media_understanding` written asynchronously by `inboundMediaPipeline`; `whatsapp_set_message_flag` upserts, cannot target another account's row, and ignores a `user_id` supplied in the body.
- [ ] **Step 2-3: implement**, entrypoint delegating to the `_shared` module.
- [ ] **Step 4: Wire the overlay into `useWhatsAppMessages`** — polled on the same 15s cadence as latest, overlay winning for the fields it carries and the body winning for the rest. Without this step the endpoint exists and nothing reads it.
- [ ] **Step 5: Gates, then commit.**

### Task 4.3: Revoke

**Files:** create `_shared/whatsappRevoke.ts` + test; modify `_shared/evolutionApi.ts`, `_shared/whatsappTransport.ts`, `messaging-api/index.ts`, `whatsappAccess.ts`, and (**the wiring**) `application/ports.ts`, `infrastructure/whatsappInboxApi.ts`

**Provider key construction stays server-side.** An earlier revision put a `domain/revokeKey.ts` in the frontend; that duplicates provider-key logic across the boundary for no benefit, since only the edge function ever calls Evolution. It is deleted. The derivation also does **not** need extracting: `remoteNumberFor` is already exported from `_shared/evolutionMessage.ts:114-121`, so `whatsappRevoke.ts` imports it. No edit to `evolutionMessage.ts`, and therefore no extra deploy surface.

- [ ] **Step 1: Write the failing tests for the key derivation** — from a row with `to_phone` present, absent (fall back to the digits after `wa_<pnid>_` in `conversation_id`), `+`-prefixed, and multi-device; plus the capability truth table across all three modes × both directions; plus **null and `sched_`-prefixed `message_id` both refused**.
- [ ] **Step 2: Run and confirm failure. Step 3: implement the derivation in `whatsappRevoke.ts`** using the existing `remoteNumberFor` (`_shared/evolutionMessage.ts:114-121`). `remoteJid` is never stored, so reconstruct it as `` `${remoteNumber}@s.whatsapp.net` `` — safe because ingest filters `@g.us`, `@lid` and `status@broadcast` (`:40-46`), so every stored conversation is an individual chat.
- [ ] **Step 4: Extend the Evolution client** with `deleteMessageForEveryone(instanceName, key)` → `DELETE /chat/deleteMessageForEveryone/{instance}`, following the existing `sendText`/`sendMedia` shape at `:237-242`.
- [ ] **Step 5: Use a capability interface, not a universal transport method (§20).**
```ts
export interface SupportsMessageRevoke {
  revokeMessage(key: { id: string; remoteJid: string; fromMe: boolean }): Promise<void>;
}
export function supportsMessageRevoke(t: WhatsAppTransport): t is WhatsAppTransport & SupportsMessageRevoke;
```
  Implement on `EvolutionTransport` only. `CloudApiTransport` gets **no throwing stub**.
- [ ] **Step 6: Implement `whatsapp_revoke_message` with a reconciliation that actually reconciles.** Load the row scoped by `social_account_id`. Reject unless `evolution_qr`, `direction === "outbound"`, and a real provider id.

  **No local revoke-window check.** An earlier revision gated on "inside WhatsApp's revoke window" without a duration, a source or a test. The window is not verifiable from this repository, and a guess would either block legitimate revokes or promise ones the provider rejects. The item stays enabled and a provider refusal surfaces as a typed error; the capability matrix's disabled states are the three that *can* be proven — wrong mode, inbound, synthetic id.

  The reconciliation, concretely. The failure being handled is *provider succeeded, local write failed*, which leaves `revoked_at` null while the message is already gone on WhatsApp — permanently present in Postora and permanently absent for the recipient:
  1. If `revoked_at` is already set, return success without calling the provider. Retries are then free.
  2. Otherwise call the transport. **Treat an "already revoked" / "message not found" provider response as success**, not as an error, and stamp the tombstone. That is what turns the second attempt after a failed local write into a repair instead of a loop.
  3. Only a transport-level failure is returned as an error.

  **Verify Evolution's actual already-revoked response shape during implementation** and encode it in the test. It cannot be determined from this repository, and step 2 is unsafe if that response is indistinguishable from a genuine failure. If it proves indistinguishable, say so and fall back to a durable pending marker rather than guessing.

  Then stamp `revoked_at`/`revoked_by` with the service role. Return `{ error_type: "UNSUPPORTED_CAPABILITY" }`, never a 5xx. **Leave the legacy `delete_message` untouched.**
- [ ] **Step 7: On the client, a successful revoke must invalidate BOTH `["wa-latest", ...]` and `["wa-history", ...]`** for that conversation. The history cache is deliberately not polled, so without this the user revokes an old message and watches it stay on screen. Cover it with a test.

- [ ] **Step 8: Deno tests** — rejects `cloud_api`/`coexistence`; rejects inbound; rejects null/synthetic ids; second call is a no-op success; an already-revoked provider response becomes a local tombstone rather than an error; wrong-workspace account refused by `withWhatsAppActionAccess`.
- [ ] **Step 9: Gates, then commit.**

### Task 4.4: Context menu, pins, tombstones

**Files:** create `ui/WhatsAppMessageContextMenu.tsx`, `ui/PinnedMessagesBar.tsx`, `application/useWhatsAppMessageActions.ts`, `domain/whatsappCapabilities.ts` (+ tests); modify (**the wiring**) `ui/WhatsAppMessageBubble.tsx` and `ui/WhatsAppConversationPane.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// userEvent is unusable here (its clipboard shim breaks), so copy uses fireEvent against
// the navigator.clipboard mock already installed at src/test/setup.ts:62.
it("copies the message text", () => {
  render(<WhatsAppMessageBubble {...props} message={{ id: "a", message: "hello" }} />);
  fireEvent.contextMenu(screen.getByTestId("wa-bubble"));
  fireEvent.click(screen.getByText("Copy"));
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
});

// One consistent contract: delete-for-everyone is ALWAYS present and ALWAYS disabled with a
// reason where it cannot apply. It is never absent — a missing item reads as a bug.
it.each([
  ["a cloud account", { capabilities: { canRevoke: false }, direction: "outbound" }],
  ["a received message", { capabilities: { canRevoke: true }, direction: "inbound" }],
  ["a synthetic provider id", { capabilities: { canRevoke: true }, direction: "outbound", providerMessageId: "sched_1" }],
])("disables delete-for-everyone for %s", (_case, override) => {
  render(<WhatsAppMessageBubble {...props} {...override} />);
  fireEvent.contextMenu(screen.getByTestId("wa-bubble"));
  const item = screen.getByText(/for everyone/i);
  expect(item).toBeInTheDocument();
  expect(item).toHaveAttribute("aria-disabled", "true");
});

// A long press must not fire while the user is scrolling the thread on touch.
it.each(["pointermove", "pointerup", "pointercancel"])("cancels the long press on %s", (evt) => {
  vi.useFakeTimers();
  render(<WhatsAppMessageBubble {...props} />);
  const bubble = screen.getByTestId("wa-bubble");
  fireEvent.pointerDown(bubble);
  fireEvent[evt === "pointermove" ? "pointerMove" : evt === "pointerup" ? "pointerUp" : "pointerCancel"](bubble, { clientY: 200 });
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByText("Copy")).not.toBeInTheDocument();
});
```

  Plus: revocation is visible to a second workspace member while pin and hide are not — a two-viewer test proving the split in spec §6 actually holds.

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement using the vendored `src/components/ui/context-menu.tsx`.** Right-click opens it; a hover kebab `DropdownMenu` reuses **the same item list** so the two cannot diverge; long-press is a 450ms `pointerdown` timer cancelled by move/up/cancel/unmount. Items: Copy · Pin/Unpin · Delete ▸ { for me · for everyone }, the last behind an `AlertDialog` (already vendored).
- [ ] **Step 4: Wire it** — `WhatsAppMessageBubble` renders the menu and the tombstone; `WhatsAppConversationPane` renders `PinnedMessagesBar` and filters `hidden_at` rows, showing a single "1 message hidden — Undo" row for 8s. **Hiding a pinned message also unpins it** — otherwise it stays advertised in the pinned bar while being hidden from the thread, which is incoherent. Cover that interaction with a test.
- [ ] **Step 5: Pinned bar.** Render from `whatsapp_list_message_flags`' `pinned` payload. Clicking scrolls to the message when it is loaded. When it is not, the row **expands in place** to show the full message with a "not loaded in this view" note — the bar already shows a preview, so silently doing nothing would read as a broken click.
- [ ] **Step 6: Gates, then commit.**

**Deploy:** migration; then copy `messaging-api/` **and** `_shared/whatsappMessageFlags.ts`, `_shared/whatsappRevoke.ts`, `_shared/evolutionApi.ts`, `_shared/whatsappTransport.ts`; verify SHA256 for each; `docker compose restart functions`. `_shared` is imported by ~10 other functions — smoke-test inbound ingest, not only the new actions.

---

## Phase 5 — Voice recorder

Backend + frontend. Depends on Phase 2's storage plumbing. Delivers §5.2, fixes R1.1.

### Task 5.1: Policy, transport, action

**Files:** create `domain/voiceNotePolicy.ts` + test, `_shared/whatsappVoiceSend.ts` + test; modify `_shared/evolutionApi.ts`, `_shared/whatsappTransport.ts`, `messaging-api/index.ts`, `whatsappAccess.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// WhatsApp voice notes are Ogg/Opus. Chromium only records WebM/Opus; the Evolution container
// has ffmpeg 8.1.2 and transcodes under encoding: true, so no client-side transcoder.
it("prefers ogg/opus", () => expect(pickRecordingMimeType(t => t.startsWith("audio/ogg"))).toBe("audio/ogg;codecs=opus"));
it("falls back to webm/opus", () => expect(pickRecordingMimeType(t => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus"));
it("returns null when nothing is supported", () => expect(pickRecordingMimeType(() => false)).toBeNull());

// Cloud API voice notes are out of scope: Meta needs a media upload plus audio.voice: true,
// which nothing here verifies. Sending a plain audio message and calling it a voice note
// would look like success and not be one.
it("allows voice notes only on evolution_qr", () => {
  expect(canRecordForMode("evolution_qr", () => true)).toBe(true);
  expect(canRecordForMode("cloud_api", () => true)).toBe(false);
  expect(canRecordForMode("coexistence", () => true)).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure. Step 3: implement** with `MAX_DURATION_SECONDS = 300` and `MAX_BYTES = 16 * 1024 * 1024`.
- [ ] **Step 4: Add `sendWhatsAppAudio(instanceName, { number, audio, delay?, encoding? })`** → `POST /message/sendWhatsAppAudio/{instance}`, reusing `sendResult()`.
- [ ] **Step 5: Add a `SupportsVoiceNote` capability interface (§20), implemented on `EvolutionTransport` only.** `CloudApiTransport` gets **nothing** — no method, no stub. Spec §4 puts Cloud voice notes out of scope.
- [ ] **Step 6: Implement `whatsapp_send_voice`** (role `agent`) in `_shared/whatsappVoiceSend.ts`, delegated from the entrypoint. Validate the `media_path` prefix exactly as Task 2.2 does — an action that fetches whatever URL the browser hands it is an SSRF sink (§26). Mint the signed URL server-side, check `supportsVoiceNote(transport)`, send with `encoding: true`, then persist a row with `message_type: "audio"`, `media_type: "audio"`, `media_url: <storage path>`, `message_text: "[Voice note]"`, `media_metadata: { mime_type, duration_seconds, ptt: true }`, and call the existing `upsertOutboundConversation` so the chat surfaces immediately.
- [ ] **Step 7: Gates, then commit.**

### Task 5.2: Recorder hook and composer

**Files:** create `application/useVoiceRecorder.ts`, `ui/WhatsAppVoiceComposer.tsx` (+ tests); modify (**the wiring**) `ui/WhatsAppConversationPane.tsx`

```ts
export type RecorderState = "idle" | "requesting" | "recording" | "preview" | "uploading" | "denied" | "unsupported";
export function useVoiceRecorder(): {
  state: RecorderState; elapsedMs: number; level: number; blob: Blob | null; mimeType: string | null;
  start(): Promise<void>; stop(): void; cancel(): void; reset(): void;
};
```

- [ ] **Step 1: Write the failing tests** with hand-written `MediaRecorder` and `getUserMedia` mocks — jsdom has neither, and `src/test/setup.ts` does not mock them. Assert: start→stop produces a blob; **`cancel()` and unmount each stop every track**; `NotAllowedError` → `denied`; missing `MediaRecorder` → `unsupported`; **recording auto-stops at `MAX_DURATION_SECONDS`**; **a blob over `MAX_BYTES` cannot be sent**; the preview object URL is revoked and the `AudioContext` closed on reset and unmount.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the hook** as a thin lifecycle owner (§10 — no persistence, no provider logic), state as a discriminated union (§31). `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`; level metering via `AudioContext` + `AnalyserNode` sampled with `requestAnimationFrame`. **Every exit path must call `stream.getTracks().forEach(t => t.stop())`** and close the `AudioContext` — on stop, cancel, unmount, and in the error branch. A leaked track leaves the browser's recording indicator lit, which users reasonably read as spyware; it is the most common defect in this kind of component.
- [ ] **Step 4: Build the composer and wire it into the pane.** Mic button when the text box is empty (WhatsApp's own behaviour). Tap to start / tap to stop, plus hold-to-record with slide-left-to-cancel on touch (`pointermove` past −60px). While recording: pulsing dot, `mm:ss` timer, a 32-bar level meter — an honest meter, not a fake waveform, since a real waveform needs the finished blob decoded. Preview: scrubber, discard, send. `NotAllowedError` shows a specific explanation.
- [ ] **Step 5: Hide the mic where `canRecordForMode` is false**, and label the surviving Attach ▸ Audio item as a normal file attachment, not a voice note.
- [ ] **Step 6: Verify live.** Record and send from the QR account; confirm the recipient's handset shows a **voice-note waveform, not a paperclip**. This is the only check that proves the ffmpeg transcode fired.
- [ ] **Step 7: Gates, then commit.**

**Deploy:** copy `messaging-api/` and `_shared/whatsappVoiceSend.ts`, `_shared/evolutionApi.ts`, `_shared/whatsappTransport.ts`; verify SHA256; `docker compose restart functions`.

---

## Phase 6 — Export

Frontend + one dependency. Depends on Phase 3's cursor. Delivers §5.7.

### Task 6.1: Transcript codecs

**Files:** create `domain/conversationTranscript.ts` + test

```ts
export function toMarkdown(conversation, messages, opts?: { mediaIndex?: Map<string,string>; truncated?: boolean }): string;
export function toCsvRows(conversation, messages): Array<Record<string, string>>;
export function safeFileName(participantName: string, phone: string): string;
```

- [ ] **Step 1: Write the failing tests** — a snapshot for a mixed conversation (text + image + voice + revoked + a day boundary); CSV column order and quoting; `safeFileName` against collisions, Arabic and unicode names, an empty name, and `../../etc/passwd`; **a truncated export carries a visible notice in the output**, not just in a log.
- [ ] **Step 2–3: implement.** Markdown: front matter (participant, phone, account, exported_at, message_count, truncated), `## 2026-08-24` day separators, `**HH:mm** — Name: text`, media as `![img](media/<file>)` or `[voice note 0:07](media/<file>)` when included and `_[image]_` when not, `~~deleted~~` for revoked rows. CSV: `timestamp,direction,from_name,from_phone,message_type,message_text,media_file,provider_message_id,status`, serialized with the installed `papaparse` exactly as `ContactExportMenu.tsx:47` does. Timestamps via the installed `date-fns`.
- [ ] **Step 4: Gates, then commit.**

### Task 6.2: Archive and orchestration

**Files:** create `domain/chatArchive.ts`, `application/useConversationExport.ts`, `src/features/whatsapp-inbox/infrastructure/downloadBlob.ts` (+ tests); modify `package.json`, `bun.lock`, `package-lock.json`

- [ ] **Step 1: `bun add fflate`** — ~8KB and tree-shakeable, versus jszip's ~95KB and a stream shim. Confirm **both** lockfiles changed; CI runs `--frozen-lockfile`.
- [ ] **Step 2: Write the failing tests** — the pagination loop stops on `has_more: false`; the page ceiling emits a **visible** truncation notice rather than looping forever; a media fetch rejection still produces a zip and records the file in `media/_missing.txt`; `unzipSync` reads the archive back; duplicate participant names get distinct filenames; **progress is reported per chat**, not only at the end; cancel aborts in-flight fetches.
- [ ] **Step 3: Implement.** `downloadBlob` is **feature-owned** and used by the export dialog — that is its production caller. **Do not migrate `ContactExportMenu.tsx`, `History.tsx` or `BulkScheduler.tsx`**; a repo-wide consolidation is scope creep this task did not ask for (§35), and Zero Dead Modules is already satisfied. Revoke the object URL on the next tick — a synchronous revoke after `.click()` races in Safari.
- [ ] **Step 4: Implement the orchestration.** Loop `getMessagesPage` with the Phase 3 cursor until `has_more` is false — this is what makes the export history rather than the on-screen rows. With media enabled, batch `whatsapp_get_media` at the server's 10-row limit and fetch signed URLs with concurrency 4; a failed photo must never abort a 3,000-message transcript. Honour an `AbortController`. Expose per-chat progress, not just an aggregate: `{ totalChats, chats: [{ conversationId, participantName, state: "pending" | "fetching" | "done" | "failed", messagesFetched, truncated }] }`. The spec requires visible progress per chat, and an aggregate counter cannot render it.
- [ ] **Step 5: Gates, then commit.**

### Task 6.3: Multi-select and the dialog

**Files:** create `ui/WhatsAppExportDialog.tsx` + test; modify (**the wiring**) `ui/WhatsAppInboxScreen.tsx`, `src/components/messaging/ConversationList.tsx`

- [ ] **Step 1: Write the failing tests** — one chat offers CSV and Markdown; two or more offer ZIP only (CSV disabled with an explanation); include-media is **off by default**; a size warning past a 25MB estimate; **progress is rendered per chat**; cancel aborts.
- [ ] **Step 2–3: implement.** `ConversationList` gains **optional** `selectionMode`, `selectedIds`, `onToggleSelect` — additive, so FB, IG and BrandIntelligence pass nothing and render byte-identically. Forking a 97-line component for three optional props would be the wrong trade. Select-all applies to the **currently filtered** list only. Wire the dialog and an Export button into `WhatsAppInboxScreen`.
- [ ] **Step 4: Gates, then commit.**

**Deploy:** none, assuming Phase 3 is deployed.

---

## Sequencing

```
1 (layout, screen + pane + bubble)
        │
        ├─► 2 (media; adds provider_message_id + direction + revoked_at to the response)
        │        ├─► 4 (actions — needs those fields)
        │        └─► 5 (voice — needs Phase 2 storage)
        └─► 3 (paging) ──► 6 (export — needs the cursor)
```

Phase 1 ships alone and the "small box" complaint disappears the same day. Phases 4 and 5 both extend `_shared/evolutionApi.ts`; run them back-to-back, not in parallel, to avoid conflicting in a file ten other functions import.

## Manual verification

- [ ] Chat fills the viewport at 1080p and 1440p, one scrollbar; single-pane below `lg`.
- [ ] The header condenses past 72px of pane scroll and restores below 24px, without focus loss.
- [ ] The connection chip expands and survives a reload; zero-account state is not collapsible.
- [ ] The 707-message thread opens at the newest messages instantly, no visible animation.
- [ ] Scrolling to the top loads older messages; the reading position does not jump.
- [ ] **After loading several history pages, a newly received message still appears.**
- [ ] Leaving the pane scrolled up for 30s shows a pill, not a yank.
- [ ] Images render inline; a zero-URL image materializes on view; a permanently missing one shows "unavailable", not a broken image or a dead download link.
- [ ] A recorded voice note arrives on a real handset **as a voice note**.
- [ ] Copy, pin, delete-for-me and delete-for-everyone behave; delete-for-everyone is present-but-disabled with a reason on cloud accounts, received messages, and synthetic ids.
- [ ] A second workspace member sees the revocation but not the pin or hide.
- [ ] Single-chat CSV and Markdown; multi-chat ZIP; media checkbox; visible progress; cancel aborts; a truncated export says so.
- [ ] `/messaging/facebook`, `/messaging/instagram` and `/brand-intelligence` are unchanged.

## Follow-ups (not in this plan)

- **Eager media materialization at ingest** — fixes `evolutionMessage.ts:162` at the source. Recommended immediately after Phase 2.
- Backfill of the ~527 historical media rows.
- Cloud API voice notes, if Meta's `audio.voice: true` contract is verified.
- Inbound revoke handling — filtered out at `evolutionMessage.ts:40-47` today.
- A retention job and a `file_size_limit` on the `media` bucket.
- Message reactions, replies/quoting, forwarding, starring, archiving.
- Extending the layout treatment to Facebook and Instagram.
