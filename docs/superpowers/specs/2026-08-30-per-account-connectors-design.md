# Spec — per-account connectors, scoped knowledge, and real credentials

Status: revision 1, 2026-08-30. Branch `feat/per-account-connectors`.

Supersedes nothing. Continues the work of `docs/plans/per-account-agent-configuration.md`,
which gave each connected account its own agent config and knowledge scope. That plan's
PR D and PR E remain open and are **not** in this spec.

---

## 0. Why this exists

Two complaints, one shared cause.

The user configured an agent for a second Facebook page and the persona did not save.
Separately, every connected account sees the same connector cards, and every connector —
Shopify, WooCommerce, Supabase — collapses into one URL and one shared secret posted to an
n8n webhook the user has to build themselves. Nothing actually connects to anything.

Both are the same omission at different layers: **the agent was made per-account, but the
things the agent uses were not.**

---

## 1. Evidence

Every claim below was verified against production on 2026-08-30, not inferred from code.

### 1.1 The blank save is proven, not suspected

`ai_agent_configs.persona_instructions` has **no column default**. An INSERT that omits it
stores `NULL`. The row for the Facebook page `الطملاوي للكتاكيت والأدوية البيطرية` holds
`''` — an explicitly transmitted empty string — in both `persona_instructions` and
`business_profile_text`:

```
الطملاوي… | persona=[] | biz=[] | model=gpt-4o-mini | cap=50
```

`AiKnowledgeManager` sends only `business_profile_text`, so a row it created would have a
`NULL` persona. Both fields being `''` means the whole `defaultConfig` object was submitted.
**The Settings form wrote it.** The row was created 12:07 and updated 12:11 — two blank
saves, four minutes apart.

The same query shows why no reply ever arrived: that config is `is_enabled=false`,
`default_mode='human_then_ai'`. The agent is off. It is off because the blank save turned
it off.

### 1.2 The existing guard cannot catch this

`AiAgentManager` already carries the fix from the 2026-08-28 outage:

```ts
const configLoaded = config !== undefined && !error && loadedAccountId === accountId;
```

That proves the form matches the *account*. It does not prove the form reflects *user
intent*. When the `config === null` branch runs it calls `setForm(defaultConfig)` **and**
`setLoadedAccountId(accountId)` together, so a reset-to-defaults immediately re-satisfies
`configLoaded`. A blank form and a legitimately-empty config are indistinguishable to
every guard now in the file.

`accountId` is derived, not stored:

```ts
const accountId = selectedAccountId && accounts.some((a) => a.id === selectedAccountId)
  ? selectedAccountId
  : accounts[0]?.id ?? null;
```

so it can change without any user action — `useSocialAccounts` refetching on window focus
is enough to re-run the effect if the selected id transiently drops out of the list. The
user pasted the same 1402-character persona into four platforms in eleven minutes, which
means repeated window switching, which means repeated focus refetches.

### 1.3 `AiKnowledgeManager` is a second writer with weaker guards

`src/components/messaging/AiKnowledgeManager.tsx:77` calls the same mutation:

```ts
await upsertConfig.mutateAsync({ business_profile_text: profile });
```

Its guard is `configLoaded = config !== undefined` — no `error` check, no account check.
Its Save button is `disabled={!configLoaded || …}` with no emptiness check, so for an
account whose config is `null` the button is **enabled with an empty textarea**. Clicking
it inserts a config row and then calls `ingest_profile_text` with empty text, whose `!text`
branch deletes the source.

`useAiAgentConfig.upsertConfig.onSuccess` invalidates the prefix
`["ai-agent-config", userId, platform]` — **every account on the platform**. So a write
from the Knowledge tab forces the Settings tab's query to refetch, which changes `config`'s
identity, which re-runs the reset effect and discards whatever the user had typed there.
The two tabs are coupled through the cache and neither knows it.

### 1.4 Connectors are user-global

`ai_agent_tools` (from `20260712000000_ai_agent_foundation.sql`) has `user_id` and
`UNIQUE (user_id, name)`. There is no `social_account_id` and no `platform`. Every
connected account on every platform sees one identical list. This is exactly the complaint.

### 1.5 `connector_type` is decoration

`ai_upsert_tool` hardcodes `tool_type: "n8n_webhook"` regardless of type, and execution in
`supabase/functions/ai-agent-reply/tools.ts:409-417` is:

```ts
if (tool.secret) headers["X-Webhook-Secret"] = tool.secret;
const url = await assertPublicHttpsUrl(tool.url);
const response = await fetch(url, { … });
```

One URL, one secret, one POST. `CONNECTOR_DIRECTORY` is 1591 lines of brand logos,
categories, MCP flags and suggested prompts, and **not one entry defines a credential
field**. Choosing "Shopify" rather than "Supabase" changes a label and nothing else.

### 1.6 Four connector types are silently downgraded

`src/hooks/useAiAgentTools.ts` offers twelve types. The server allow-list in
`messaging-api/index.ts` and the DB CHECK in `20260825120000` both list eight:

```
supabase, mysql_postgres, woocommerce, shopify, salla, zid, formula, custom_rest
```

`myfatoorah`, `stripe`, `higgsfield` and `mcp_custom` are absent. The server does not
reject them — it substitutes `custom_rest` and returns 200. The user picks Stripe, sees a
success toast, and has a `custom_rest` row. Production contains a tool named
`woocommerce_store` stored as `custom_rest`.

### 1.7 Infrastructure available

`supabase_vault 0.3.1` and `pgcrypto 1.3` are **installed** on the self-hosted stack.
`vault.create_secret(text, name, description) → uuid`, `vault.update_secret(uuid, …)`, and
the `vault.decrypted_secrets` view all exist. `pgsodium 3.1.8` is available but not
installed; the design does not need it.

---

## 2. Goal

For one Postora login owning many accounts on a platform:

1. A save writes what the user typed, or refuses and says why. Never silently writes blanks.
2. Connectors belong to **one connected account**, selected with the same dropdown the
   agent settings use.
3. The Knowledge tab lists only the sources that account can actually retrieve.
4. A business-profile source is named for its account, not its UUID.
5. A connector collects the **vendor's real credential fields**, stores the secret ones
   encrypted, calls the vendor's API **directly**, and can be tested before it is trusted.

---

## 3. Decisions taken

| Decision | Choice | Consequence |
|---|---|---|
| Execution | **Direct from Postora** | One adapter per vendor. No n8n dependency. Postora owns the request, the errors and the rate limits. |
| Credential storage | **Vault-encrypted JSONB** | Secrets never leave the server, never appear in a DB dump in plaintext, and never appear in an API response. |
| Staging | **One spec, several PRs** | Complete picture up front; PR order below is load-bearing. |

---

## 4. Data model

### 4.1 `ai_agent_tools` gains scope

```sql
ALTER TABLE public.ai_agent_tools
  ADD COLUMN social_account_id UUID REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  ADD COLUMN platform TEXT,
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'account'
    CHECK (scope IN ('account', 'all_accounts'));
```

`scope` is deliberate and mirrors the `visibility` column PR #61 added to
`ai_knowledge_sources`. The lesson recorded there applies unchanged: **a NULL that means
"applies to everything" is non-monotonic** — detaching a connector's last account would
silently grant it to every account. An explicit enum cannot do that.

Existing rows backfill to `scope='all_accounts'`, `social_account_id=NULL`. They keep
working. Every *new* connector is `scope='account'` and must name one.

The composite foreign key that keeps a connector from pointing at an account on another
platform reuses the unique index `20260828190000` already added:

```sql
ALTER TABLE public.ai_agent_tools
  ADD CONSTRAINT ai_agent_tools_account_same_owner_platform
  FOREIGN KEY (social_account_id, user_id, platform)
  REFERENCES public.social_accounts (id, user_id, platform);
```

This is structural on purpose. Edge Functions run under the service role and RLS is not
checking them.

> **Note for whoever drops things later.** This is now the *second* FK holding
> `social_accounts (id, user_id, platform)`. Any future migration that drops that unique
> index must drop **both** dependants first. A migration that forgets fails only on replay,
> which is the failure that hid on 2026-08-28.

### 4.2 Uniqueness must move — and it is an expand/contract

`UNIQUE (user_id, name)` prevents two accounts from each having a `woocommerce_store`.
It becomes `UNIQUE (user_id, social_account_id, name)`.

The old constraint is the `ON CONFLICT` target of the deployed `ai_upsert_tool`. Dropping
it in the same migration that adds the columns breaks every connector save in the window
before the new code deploys — precisely the `SET NOT NULL` mistake of 2026-08-28, which
blocked first-time agent saves for 52 accounts across 20 logins.

Therefore:

- **PR-1 migration** adds columns and the new unique index. Does **not** drop the old one.
- **PR-1 code** stops using `onConflict: "user_id,name"`.
- **PR-6 migration** drops `ai_agent_tools_user_id_name_key`, after PR-1's code is serving.

Both unique constraints coexist in between. That is legal: a per-account name is also
unique per user while only one account exists, so no in-flight save can violate either.

### 4.3 Credentials

```sql
ALTER TABLE public.ai_agent_tools
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN credentials_secret_id UUID,
  ADD COLUMN configured_secret_fields TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN last_test_at TIMESTAMPTZ,
  ADD COLUMN last_test_ok BOOLEAN,
  ADD COLUMN last_test_error TEXT;
```

The split is the point:

- **`settings`** — non-secret connection facts. Store domain, API version, Supabase project
  URL, schema name, table allow-list. Readable by the UI, returned by `ai_list_tools`.
- **`credentials_secret_id`** — one Vault secret per connector holding a JSON object of
  **only** the secret fields. Written with `vault.create_secret`, read at call time through
  `vault.decrypted_secrets` under the service role.
- **`configured_secret_fields`** — the field *names* that have values. This is what lets the
  UI render "Consumer secret ✓ set" without decrypting anything, and it is why
  `ai_list_tools` never needs to touch Vault at all.

The existing `secret TEXT` column stays for `custom_rest`'s webhook secret and is migrated
into Vault in PR-6. It is not dropped in this spec.

**`ai_list_tools` must never return a decrypted value.** It returns `settings`,
`configured_secret_fields`, and the existing `has_secret`. This is the same rule
`ARCHITECTURE.md` §13 already states; it is restated because the temptation to round-trip a
credential into an edit form is strong and wrong. An edit form shows which fields are set
and lets the user replace them.

---

## 5. The connector registry

### 5.1 One definition, two consumers, one test

The registry declares, per connector: id, category, auth kind, the field list, and the
capabilities it supports.

```ts
export interface ConnectorField {
  name: string;              // "consumer_secret"
  label: string;             // "Consumer secret"
  kind: "text" | "url" | "secret" | "select";
  required: boolean;
  secret: boolean;           // true → Vault, false → settings
  placeholder?: string;
  help?: string;
}
```

The frontend renders the form from this list. The backend validates against the same list.
They **must** be the same object.

> This is the failure recorded in the MCP↔n8n-api seam: field names written by hand on both
> sides, nothing checking they agree, and `upload_media` never worked as a result. A
> contract test asserting the frontend's field set equals the backend's, per connector, is a
> required deliverable of PR-2 — not an optional extra.

The registry lives at `supabase/functions/_shared/connectors/registry.ts` as pure data with
no Deno APIs, and the frontend imports it through a path alias. If the alias proves
impractical under Vite, the fallback is a generated file plus the contract test; the test is
what makes either arrangement safe.

### 5.2 Adapters

```ts
export interface ConnectorAdapter {
  id: ConnectorType;
  testConnection(ctx: ConnectorContext): Promise<TestResult>;
  capabilities: Partial<Record<Capability, CapabilityFn>>;
}
```

`Capability` is the existing permission triple: `search_products`, `check_stock`,
`lookup_orders`. A capability the adapter does not implement is not offered in the UI —
today the permission checkboxes are three fixed booleans regardless of what the vendor can
do.

### 5.3 Security rules that apply to every adapter

1. **`assertPublicHttpsUrl` still runs** on every user-supplied host, at save and at call.
   WooCommerce store URLs and Supabase project URLs are user-supplied, so SSRF defence does
   not weaken just because the request is now typed.
2. **`read_only_mode` starts meaning something.** It currently does nothing. Under direct
   adapters it gates the capability set to read-shaped calls, enforced in the dispatcher,
   not in each adapter.
3. **A vendor error is never a Postora 5xx.** Cloudflare masks origin 5xx and the real body
   is lost; the connector returns a structured failure the agent can speak.
4. **A 200 carrying an error body is a failure.** Six functions already treat OpenRouter's
   200-with-error as success. Adapters check the payload, not the status line.

---

## 6. Connector catalogue

Auth shapes below are cited. Anything not cited is not in this spec.

### 6.1 Existing types, corrected

| Connector | Real fields | Auth |
|---|---|---|
| **WooCommerce** | store URL, consumer key, consumer secret | HTTP Basic — key as username, secret as password ([docs](https://developer.woocommerce.com/docs/apis/rest-api/authentication/)) |
| **Shopify** | shop domain, client ID, client secret, API version | Client-credentials grant → `X-Shopify-Access-Token`. Admin-created custom apps were **deprecated 1 January**; the old copy-a-token flow is gone ([docs](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin)) |
| **Salla** | client ID, client secret, access token, refresh token, expiry | OAuth 2.0 `Bearer`. **Access token expires in 14 days**, refresh within 1 month; parallel refreshes fail the whole grant ([docs](https://docs.salla.dev/421118m0)) |
| **Zid** | client ID, client secret, authorization token, **X-Manager-Token** | OAuth 2.0 authorization-code. Needs **two** headers, not one. Manager token lasts 1 year ([docs](https://docs.zid.sa/authorization)) |
| **Supabase** | project URL, anon key, optional service-role key, schema, table allow-list | `apikey` + `Authorization: Bearer` against PostgREST |
| **MySQL/Postgres** | host, port, database, user, password, SSL mode, table allow-list | Direct driver connection |
| **Stripe** | restricted API key (`rk_live_…`/`rk_test_…`) | `Bearer`. Restricted keys carry per-resource Read/Write/None ([docs](https://docs.stripe.com/keys/restricted-api-keys)) |
| **custom_rest** | URL, header name, secret | Unchanged. The escape hatch. |
| **formula** | — | Local computation, no credentials. |

**Salla and Zid both expire, so refresh is a requirement, not a nice-to-have.** A connector
whose token silently dies is worse than no connector: the agent fails mid-conversation with
a customer. `refresh-tokens` already runs a bounded sweep for social accounts and is the
natural home, with the per-account worst-case budgeting `sweepBudget.ts` already enforces.

**Supabase carries a specific hazard.** A service-role key gives the agent the entire
database — RLS is not evaluated for it. The anon key is the default and is RLS-enforced. A
service-role key is accepted **only** with a non-empty table allow-list, and the UI says why.
This is the same trap as the `ai-knowledge` bucket that had drifted public: a credential that
bypasses the policy engine makes every policy behind it decorative.

### 6.2 Types the UI offers but the server rejects

`myfatoorah`, `stripe`, `higgsfield` and `mcp_custom` are added to both the DB CHECK and the
server allow-list. Independently, **an unrecognised `connector_type` becomes a 400, not a
silent downgrade to `custom_rest`.** Substituting a different type than the user chose and
returning 200 is the worst of both outcomes.

### 6.3 New connectors

Chosen for a social-media DM agent — catalogue lookups, bookings and order status are what
customers actually ask about in a DM.

| Connector | Fields | Auth | Why |
|---|---|---|---|
| **Airtable** | personal access token, base ID, table | `Bearer` PAT. User API keys were **fully deprecated 1 Feb 2024** — PAT or OAuth only ([docs](https://airtable.com/developers/web/guides/personal-access-tokens.md)) | The small-business catalogue that isn't a store |
| **Google Sheets** | service-account JSON *or* OAuth, spreadsheet ID, range | Service account for bot access; OAuth for end-user sheets ([docs](https://developers.google.com/workspace/sheets/api/scopes)) | The most common price list in existence |
| **Notion** | internal integration token, database ID | Static token for internal connections ([docs](https://developers.notion.com/guides/get-started/authorization)) | FAQ and policy source |
| **Cal.com / Calendly** | API key, event type | `Bearer` | Booking is the top DM intent after price |
| **MyFatoorah** | API token, environment | `Bearer` | Already in the UI list, Kuwait-relevant, currently downgraded |
| **Generic MCP** | server URL, auth header | Per-server | One connector that reaches every MCP server without Postora writing an adapter |

Google Sheets service-account JSON is a **multi-line secret containing a private key**. It
goes to Vault like any other, and the field renders as a textarea with no echo-back.

---

## 7. Knowledge tab scoping

### 7.1 Filter the list to the account

`ai_knowledge_sources` already has `visibility` (`shared` / `restricted`) and
`ai_knowledge_source_accounts` already links sources to accounts. The retrieval RPCs already
respect both. **The list view does not** — `useAiKnowledge` fetches every source the user
owns.

The list becomes: sources where `visibility='shared'` **or** an explicit link to the selected
account exists — the same predicate the retrieval RPCs use. The UI shows which is which, so
"shared with all accounts" is visible rather than implied.

Using the same predicate as retrieval is the requirement. A list that shows a document the
agent cannot retrieve — or hides one it can — is worse than no filter, because it makes the
user confident about the wrong thing.

### 7.2 Name the source for its account

Today: `Business profile (threads · c5c42a4d-f8d6-401e-858c-a73cfdee0002)`.
Wanted: `Business profile (threads · postora.cloud)`.

The account id was chosen for uniqueness after a collision where two accounts shared one
`Business profile (<platform>)` source and the second save replaced the first's chunks. The
fix keeps the guarantee and drops the UUID from the *display*: the source row keeps its
account link as the identity, and the title is rendered from
`social_accounts.platform_username` at read time, falling back to the id when the username is
absent.

Rendering rather than storing matters — a username can change, and a stored title would then
be a lie. Existing titles are backfilled once for readability, and the renderer is what keeps
them right afterwards.

---

## 8. The blank-save fix

Three changes; the first is the one that matters.

1. **A reset to defaults is not a load.** Track the *reason* the form holds its current
   values, not just which account they came from. `configLoaded` becomes true only when the
   values were populated from a settled read for the currently selected account — a reset
   caused by `accountId` changing under the user does not re-satisfy it.

2. **Both writers get the same guard.** `AiKnowledgeManager` adopts
   `!error && loadedAccountId === accountId` and refuses to submit an empty profile over a
   non-empty stored one without confirmation. Being the quieter surface is not a reason to
   have the weaker check — it is the reason the weaker check went unnoticed.

3. **Stop the two tabs fighting over one cache entry.** `upsertConfig.onSuccess` invalidates
   the whole platform prefix, so a Knowledge-tab save discards unsaved Settings-tab edits.
   Invalidate the written account's key, and refetch siblings only when they are not dirty.

### 8.1 Tests, written to fail first

- Typing a persona, then forcing `accountId` to change identity without user action, leaves
  Save **disabled** — it currently stays enabled with a blank form. This is the regression
  test for the actual outage.
- Saving from the Knowledge tab does not clear unsaved Settings-tab edits.
- The Knowledge tab's Save is disabled when the profile is empty and the stored profile is not.
- An `ai_upsert_config` payload whose `persona_instructions` is `''` while the stored value is
  non-empty is rejected server-side unless the client marks it deliberate. Server-side because
  the client is the layer that failed.

### 8.2 Data repair

The Facebook page `الطملاوي…` has `is_enabled=false` and an empty persona. **No migration
will restore it — the text was never transmitted and does not exist anywhere.** The user
re-enters it after the fix ships. Stated plainly because a spec that implies recovery is
worse than one that admits the loss.

---

## 9. PR order

Order is load-bearing. A migration always lands **before** the code that depends on it, and
the frontend auto-deploys on `main` while Edge Functions are copied separately.

| PR | Contents | Gate |
|---|---|---|
| **PR-1** | Blank-save fix, `AiKnowledgeManager` guard, cache-invalidation split | Regression tests fail without the fix |
| **PR-2** | Connector registry + field schemas + **frontend/backend contract test**. No behaviour change | Contract test passes for all types |
| **PR-3** | Migration: scope + credential columns, new unique index. **No drops** | Rehearsed with `ROLLBACK` against production |
| **PR-4** | `ai_upsert_tool`/`ai_list_tools` write scoped rows and Vault credentials; account dropdown on the Tools tab; unknown type → 400 | Deployed before PR-6 |
| **PR-5** | Adapters + `test_connection` + `read_only_mode` enforcement, WooCommerce and Supabase first | Live test against a real store |
| **PR-6** | Contract migration: drop `ai_agent_tools_user_id_name_key`, migrate `secret` into Vault | Forward-only; say so in the runbook |
| **PR-7** | Knowledge list filtering + account-named source titles | Predicate matches the retrieval RPCs |
| **PR-8** | OAuth flows (Salla, Zid, Shopify) + token refresh in the bounded sweep | Expiry simulated, not assumed |

**PR-6 is forward-only.** Once two accounts share a connector name, `UNIQUE (user_id, name)`
cannot be restored. The runbook must say so, as it does for the agent-config contract.

Every migration is rehearsed with `COMMIT` swapped for `ROLLBACK` **against production**, not
a clean scratch database — Postora migrations self-commit, so an outer `BEGIN`/`ROLLBACK`
applies them for real, and a virgin database hides exactly the replay defects that bit on
2026-08-28.

---

## 10. Explicitly out of scope

- PR D (QR reconnect transferring config and knowledge links) and PR E
  (`social_account_id` on `ai_agent_logs`) from the per-account agent plan.
- `whatsapp_auto_replies` / `messenger_auto_replies` per account.
- Writing to vendors. Every capability in this spec reads. `read_only_mode` defaults to true
  and write capabilities are a later spec with its own confirmation design.
- Replacing `custom_rest`'s n8n webhook path. It stays as the escape hatch.

---

## 11. Open question for the debate

Whether PR-5's adapters should run in `ai-agent-reply` or in a separate function. The
worker has a **60-second ceiling** that kills a request with no log row, and a three-model
chain already competes for it. Adding a vendor round-trip inside the same budget may need
the adapter to move behind its own function with its own budget.
