# Arabic (Egyptian) localisation of the Postora dashboard

Date: 2026-09-20
Status: approved, implementation delegated to Antigravity (`gemini-3.8-flash-high`, effort high)

## Goal

Every page behind `DashboardLayout` — and the components those pages render — renders
in Egyptian colloquial Arabic (مصري) when the user selects Arabic, with correct RTL
direction and the Cairo typeface.

Out of scope: admin pages (`AdminLayout`), the public/marketing surface (Landing,
Pricing, Auth, Privacy, Terms, Docs), and edge functions.

## What already exists — verify, do not rebuild

| Concern | Where | State |
|---|---|---|
| i18next bootstrap | `src/i18n/index.ts` | initialised before first render from `src/main.tsx` |
| Cairo webfont | `src/index.css:1` | imported with weights 400–800 |
| Cairo applied to Arabic | `src/index.css:156-169` | `html[lang="ar"]` and `[dir="rtl"]` |
| RTL input/code handling | `src/index.css:172-186` | text-align, `dir=ltr` islands, `.rtl-flip` |
| `dir`/`lang` on `<html>` | `applyDocumentLanguage()` | re-applied on `languageChanged` |
| Migrated page | `src/pages/ApiKeys.tsx` | the one worked example, namespace `apikeys` |

Coverage today: **2 of 712 `.tsx` files** call `useTranslation`. There is no `ar`
bundle and no way for a user to reach Arabic — `SUPPORTED_LANGUAGES` is `["en"]`.

## The i18n contract (non-negotiable — it is why `src/i18n/index.ts` reads as it does)

1. **English is never a resource bundle.** Every call site is
   `t("key.path", "English copy")`. The English default lives at the call site so it
   cannot drift from a parallel `en` JSON file.
2. A new namespace must be added **both** to `ns` **and** to `resources.en` as `{}`.
   Omitting the empty declaration makes i18next warn about an unloaded namespace;
   omitting it from `ns` makes the lookup silently fall through a stub.
3. `ar` is the only real bundle. It is keyed identically to the call-site keys.
4. Translation only. **Physical-property RTL layout** (`ml-`/`mr-`/`left-`/`right-`/
   `text-left`) is a separate audit and must not be attempted inside these waves —
   it would balloon every slice.

## Namespace scheme

One namespace per feature area, plus two shared ones. Fixed up front so parallel
waves cannot collide.

```
common     shared verbs, statuses, toasts, confirm/cancel, date and empty states
nav        DashboardLayout sidebar, header, user menu, footer
dashboard  Dashboard
post       CreatePost + src/components/post/**
calendar   Calendar, ScheduledPosts, SmartScheduling + src/components/calendar/**
history    History + src/components/history/**
profiles   Profiles, Profile, ConnectionHealth
media      MediaLibrary + src/components/media/**
templates  Templates + src/components/templates/**
analytics  Analytics, analytics/*, AdAnalytics + src/components/analytics/**
ads        AdManager + src/components/ads/**
brand      BrandIntelligence, BrandIntelligencePost
leads      LeadsCRM + src/components/leads/**
automation automation/*, HumanAgentMode + src/components/automation|ai/**
comments   comments/* + src/components/comments/**
messaging  messaging/* + src/components/messaging/**
whatsapp   WhatsAppShop + src/components/whatsapp/**
billing    Credits, UploadLimits, Payment*, Subscription*
content    WhatsNew, BlogPostDetail, Contact
apikeys    ApiKeys  (already exists — extend, do not rename)
```

Bundles live at `src/i18n/locales/ar/<namespace>.json`, imported statically by
`src/i18n/index.ts`. Static imports, not a lazy backend: the bundle is small next to
the app chunk and a missing async load is a silent English fallback.

## The gate: `scripts/check-i18n-coverage.mjs`

The only verification a translation task has that a model cannot fake. It must:

1. Walk `src/**/*.{ts,tsx}` excluding `__tests__`.
2. Resolve each file's namespace from its `useTranslation("<ns>")` call.
3. Extract every `t("key.path", "English default")` — including multi-line calls.
4. Compare the key set against `src/i18n/locales/ar/<ns>.json`.
5. Exit non-zero listing **missing** keys (used in code, absent from `ar`) and
   **orphan** keys (present in `ar`, used nowhere).

Wired as `npm run check:i18n`, and run at the end of every wave.

## Waves — as executed

Planned as seven; executed as seventeen. Two things forced the split. Feature
areas turned out to be far larger than page counts suggested (Create Post alone
is 27k lines across 89 files), and a delegated run degrades by silently skipping
files rather than reporting it ran out of room, so each dispatch was held to
roughly 5-8k lines. Sub-waves were cut along terminology boundaries, never by
line count: all eleven platform settings panels stayed in one dispatch so they
could not each invent their own Arabic for "audience" and "visibility".

| Wave | Namespace | Files | Keys | Implementer |
|---|---|---|---|---|
| 0 foundation | `nav` | 5 | 51 | Antigravity |
| 1a dashboard/calendar/history | `dashboard` `calendar` `history` | 28 | 310 | Antigravity |
| 1b-i compose | `post` | 18 | 202 | Antigravity |
| 1b-ii platform settings | `postsettings` | 15 | 527 | Antigravity |
| 1b-iii media | `postmedia` | 24 | 371 | Antigravity |
| 1b-iv previews | `postpreview` | 26 | 382 | Antigravity |
| 2a accounts + settings | `accounts` | 19 | 437 | Cursor Grok |
| 2b media library + templates | `assets` | 24 | 402 | Cursor Grok |
| 3 analytics/ads/brand/leads | `analytics` | 38 | 428 | Cursor Grok |
| 4 automation + comments | `automation` | 20 | 343 | Cursor Grok |
| 5a WhatsApp tooling | `whatsapp` | 22 | 470 | Cursor Grok |
| 5b inbox + conversations | `inbox` | 28 | 387 | Cursor Grok |
| 5c AI agent + knowledge | `agent` | 18 | 336 | Cursor Grok |
| 5d Threads mentions | `threads` | 22 | 142 | Cursor Grok |
| 6 billing + content tail | `billing` | 10 | 177 | Cursor Grok |
| shared | `common` | — | 29 | all waves |
| pre-existing | `apikeys` | — | 53 | earlier work |

Gemini 3.8 Flash High hit its individual quota (RESOURCE_EXHAUSTED 429) partway
through Wave 2a; the remaining nine dispatches ran on Cursor Grok 4.6 Fast. The
briefs are model-agnostic and needed no rewriting, but two harness facts did:
cursor-agent re-emits `.claude/settings.json` hook commands as PowerShell and
bash-evals them on Windows, killing every write path until the settings file is
parked for the run, and its `.cmd` shim truncates arguments past ~8KB, so a
brief must arrive on stdin.

## Per-wave gates

```
npm run check:i18n
npm run typecheck
npm run lint
npx vitest run <the touched test dirs>
npm run build
```

## Translation register

Egyptian colloquial Arabic (مصري), as chosen. Practical rules for the implementer:

- Product nouns stay Latin: Postora, Facebook, Instagram, WhatsApp, TikTok, Threads,
  Pinterest, n8n, API, webhook, token.
- Address the user in second person singular the way an Egyptian product would
  ("اختار", "اكتب", "ارفع") — not the MSA imperative forms.
- Keep interpolation placeholders byte-identical: `{{count}}` stays `{{count}}`.
- Never translate a key path, a route, an env var, or a database column name.

## Risks

- A flash-tier model tends to invent an `en` bundle. The contract section above is
  restated verbatim in every brief for that reason.
- `agy` has exited 0 having written nothing (headless permission denial). Every wave
  is verified by reading the worktree, never the process exit.
- Waves run in a dedicated git worktree so they cannot collide with other CLIs
  driving `F:\Postora_new`.
