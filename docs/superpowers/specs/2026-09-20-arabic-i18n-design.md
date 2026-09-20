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

## Waves

Each wave is one Antigravity dispatch, reviewed and committed separately.

- **Wave 0 — foundation.** Add `"ar"` to `SUPPORTED_LANGUAGES`; create the locales
  directory and the empty-declaration wiring for all namespaces above; write
  `check-i18n-coverage.mjs` and the `check:i18n` script; add a language switcher
  (header dropdown next to `ThemeToggle`, plus a control in Settings) — without one
  Arabic is reachable only by `?lang=ar`; migrate `DashboardLayout` to the `nav`
  namespace as the worked example; extend `src/i18n/__tests__/i18n.test.ts` for `ar`
  and `dir === "rtl"`.
- **Wave 1 — core posting.** Dashboard, CreatePost, Calendar, ScheduledPosts, History.
- **Wave 2 — accounts and assets.** Profiles, Profile, ConnectionHealth, MediaLibrary,
  Templates, Settings.
- **Wave 3 — analytics and growth.** Analytics + `analytics/*`, AdManager, AdAnalytics,
  BrandIntelligence(+Post), LeadsCRM.
- **Wave 4 — automation.** `automation/*`, HumanAgentMode, `comments/*`.
- **Wave 5 — messaging.** `messaging/*`, WhatsAppShop and `components/whatsapp/**`.
- **Wave 6 — the tail.** Credits, UploadLimits, SmartScheduling, WhatsNew,
  BlogPostDetail, Contact, Payment*, Subscription*.

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
