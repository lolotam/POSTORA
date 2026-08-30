# Spec — per-account connectors, scoped knowledge, and real credentials

Status: revision 2, 2026-08-30. Branch `feat/per-account-connectors`.

Revision 1 was reviewed by GLM 5.3 (read-only, adversarial) and returned sixteen findings,
two of them blocking. This rewrite adopts every one that survived verification against the
code and the production server, including the finding that a citation in §6.1 was wrong.

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
is enough to re-run the effect if the selected id transiently drops out of the list.

**What is proven, and what is not.** The writer and the blank payload are proven (§1.1).
The *trigger* that emptied the form is not. Two candidates:

- **Cross-tab cache invalidation — provable from code alone**, see §1.3. A Knowledge-tab
  save invalidates the whole platform prefix, the Settings query refetches, `config`'s
  identity changes, and the reset effect runs over the user's unsaved edits.
- **`accountId` flipping under a focus refetch** — plausible but *unreproduced*. React
  Query's structural sharing keeps `data` reference-stable when a refetch returns identical
  content, so this needs the selected id to transiently leave the list, which I have not
  demonstrated.

The fix in §8 therefore defends the **class** — any path that resets the form without the
user asking — rather than one confirmed trigger. Tests in §8.1 simulate both. Saying which
is which matters: a fix aimed at an unproven trigger is how you ship a patch that leaves the
bug live.

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
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'all_accounts'
    CHECK (scope IN ('account', 'all_accounts')),
  ADD CONSTRAINT ai_agent_tools_scope_matches_account
    CHECK ((scope = 'account') = (social_account_id IS NOT NULL));
```

**The default is `'all_accounts'`, and that is the whole point.** `'account'` looks like the
right default and is the 2026-08-28 defect wearing a new hat. Between the PR-3 migration and
the PR-4 deploy, the *deployed* `ai_upsert_tool` still inserts rows with neither scope nor
account. Under a `'account'` default those rows land as `scope='account',
social_account_id=NULL` — a connector no account can ever resolve, saved successfully, with
no error anywhere. That is the 52-account outage in its silent-corruption form.

Defaulting to `'all_accounts'` makes the old writer's rows mean exactly what they already
meant, so the window is harmless. PR-4's code writes `scope` explicitly; a later migration
flips the default once no old writer exists.

The `CHECK` pairing scope with account presence is not optional either. Without it the two
columns are free to disagree, and every reader has to decide what
`scope='account', social_account_id=NULL` means. Note the ordering consequence: the CHECK
must land **in the same transaction as the corrected default**, never before it, or the same
window becomes a hard 500 on every new-connector save instead of a silent one — the `SET NOT
NULL` failure exactly.

`scope` mirrors the `visibility` column PR #61 added to `ai_knowledge_sources`, but the
reasoning transfers only partly and the spec previously overstated it. In the knowledge case
NULL arose from an ordinary user action — removing the last link — so non-monotonicity was
*emergent*. Here `social_account_id` can only become NULL by an explicit write, and the FK's
`ON DELETE CASCADE` deletes a connector with its account rather than orphaning it. The
honest arguments for the enum are narrower: it makes sharing an **explicit, auditable state**
rather than an inference from a NULL, and it gives the write path something to branch on.
Those are sufficient; the borrowed one was not.

Existing rows are already `scope='all_accounts'`, `social_account_id=NULL` by the default, so
no backfill statement is needed. Every *new* connector is `scope='account'` and must name one.

**Known expressiveness gap, deliberately not solved now.** `all_accounts` spans every
platform, so a merchant with one product catalogue shared across seven Facebook pages but not
their Instagram cannot say that. The `platform` column added here would support a third value
(`'platform'`) later. Recorded as an option, not designed.

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
It becomes `UNIQUE (user_id, social_account_id, name) NULLS NOT DISTINCT`.

**`NULLS NOT DISTINCT` is load-bearing, not decoration.** Postgres treats NULLs as distinct
in a unique index by default, and `scope='all_accounts'` rows carry a NULL
`social_account_id`. Verified on the production server (PostgreSQL 17.6):

```
CREATE UNIQUE INDEX t_u ON t (user_id, social_account_id, name);
INSERT … (user, NULL, 'woo');  -- ×3
→ duplicate_legacy_rows_allowed=3
```

Three identical legacy rows accepted. With `NULLS NOT DISTINCT` the second insert is
rejected. Without it, PR-6 dropping `user_id,name` would leave legacy connectors with **no
uniqueness at all**. `NULLS NOT DISTINCT` requires PG15+; this server is 17.6.

**No `ON CONFLICT` against this index.** Even with `NULLS NOT DISTINCT`, `ON CONFLICT`
inference over a nullable column is a trap worth refusing outright. `ai_upsert_tool` adopts
the read-then-update-or-insert shape `writeAccountScopedConfig` already uses for configs —
read the account's tools as a **list**, update the matching row or insert. That function
exists because `maybeSingle()` turns the second row into an error the moment a platform has
two; the same reasoning applies here the moment an account has two connectors.

**The composite FK does not constrain legacy rows.** Foreign keys are `MATCH SIMPLE`: a row
with a NULL `social_account_id` satisfies the constraint vacuously. So "structural on
purpose" holds for `scope='account'` rows and *not* for `scope='all_accounts'` ones. Those
are the two pre-existing production rows and no new ones are created, but the limit is real
and is why `scope` is checked in the dispatcher too, not only in the schema.

The old constraint is the `ON CONFLICT` target of the deployed `ai_upsert_tool`. Dropping
it in the same migration that adds the columns breaks every connector save in the window
before the new code deploys — precisely the `SET NOT NULL` mistake of 2026-08-28, which
blocked first-time agent saves for 52 accounts across 20 logins.

Therefore:

- **PR-1 migration** adds columns and the new unique index. Does **not** drop the old one.
- **PR-1 code** stops using `onConflict: "user_id,name"`.
- **PR-6 migration** drops `ai_agent_tools_user_id_name_key`, after PR-1's code is serving.

Both unique constraints coexist in between. That is legal for a simpler reason than the one
first given here: `UNIQUE (user_id, name)` is strictly *stronger* than the new index, so
anything the old constraint admits the new one admits too. No in-flight save can violate
either.

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

#### The `secret` column must be dual-read before it is migrated

The live reader of `secret` is `executeCustomTool`, which sets `X-Webhook-Secret`
(`ai-agent-reply/tools.ts:409`). If PR-6 moves the value into Vault before a deployed reader
knows to look there, the header simply stops being sent. **That is a silent auth failure on
every n8n webhook call** — no exception, no log line, just a vendor rejecting requests.

So the sequence is: PR-4 writes new secrets to Vault **and keeps writing the column**; the
reader in `ai-agent-reply` dual-reads (column first, else Vault); PR-6 migrates the stored
values; a later cleanup removes the column path. The column is not dropped in this spec.

This also means **`ai-agent-reply` is a deliverable**, which the first PR table never said.
See §9.

#### Vault has no delete function — the lifecycle must supply one

The installed API is `create_secret`, `update_secret`, and the `decrypted_secrets` view.
**There is no `vault.delete_secret`.** Nothing reclaims a secret on its own, which produces
two leaks the schema will not catch:

1. **Connector delete.** `ai_delete_tool` must `DELETE FROM vault.secrets WHERE id = …`
   under the service role, in the same transaction as the row, and must run *before* the row
   is gone — once the row is deleted the secret id is unrecoverable and the secret is
   orphaned forever.
2. **Cascade delete.** `social_accounts … ON DELETE CASCADE` and the user-delete cascade
   both remove `ai_agent_tools` rows *without* going through `ai_delete_tool`. A statement
   trigger `AFTER DELETE ON ai_agent_tools` that deletes the corresponding
   `vault.secrets` row is the only thing that covers this path. Disconnecting an account
   would otherwise leave that store's live credentials encrypted-at-rest but undeleted, with
   no row pointing at them.

A trigger, not application code, because the cascade never calls application code.

3. **Restore from backup.** A dump of the `public` schema does not carry the `vault` schema.
   After such a restore every `credentials_secret_id` dangles, and **nothing fails at rest** —
   the breakage appears only at the next vendor call. The deploy runbook must state that
   `vault` is backed up with `public` or not at all.

**Partial update.** `update_secret` replaces the whole secret. A form that submits only
`consumer_secret` must therefore decrypt, merge, and re-encrypt — never write the single
submitted field, which would silently drop `consumer_key`. This merge is the one place a
credential is decrypted outside a vendor call, and it happens server-side inside the same
request.

**Ordering, because the two writes are not one transaction.** `vault.create_secret` /
`update_secret` and the `ai_agent_tools` write are separate statements. The rule is **vault
first, row second**. A failure between them then leaves an *orphan* secret — wasteful and
swept later — rather than a row pointing at a secret that no longer matches, which would
send the wrong credentials to a vendor. Orphan is tolerable; dangling never is.

`configured_secret_fields` is a **cache of the blob's keys and must be derived from it on
every write**, never accepted from the client and never set independently. A drifted cache
tells the UI a field is configured when it is not.

Concurrent saves are last-write-wins on the whole blob. Acceptable for a settings form; said
out loud so nobody assumes field-level merging across requests.

**The blob is the right grain.** One vault row per connector means one decrypt per vendor
call. Per-field secrets would multiply rows and bookkeeping for no gain, and the read-modify-
write above is a bounded cost paid only when a human edits a form.

**Never in a log or an error.** No adapter may include a credential in a thrown message, a
`console.log`, an `ai_agent_logs` row, or a response body. Vendor errors are re-wrapped
before they propagate: a WooCommerce 401 body can echo the request, and a 200-with-error
body can too.

Two leak surfaces this design creates and must therefore close:

- **`last_test_error`** stores a vendor error body and `ai_list_tools` returns it to the UI.
- **Adapter output reaches the customer.** `result.output` is pushed into the model's message
  list verbatim (`ai-agent-reply/index.ts:942-946`), so anything an adapter returns can be
  spoken into a DM.

Every vendor body therefore passes the existing `redactSensitive`
(`supabase/functions/_shared/logging.ts:33`) before it touches `last_test_error`, a log, or a
tool result. Reusing the tested redactor rather than writing a new one is the point.

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
**zero imports** — no Deno globals, no `https://` specifiers, no `Deno.env`. The frontend
imports it directly.

**This is verified, not assumed.** `tsconfig.app.json` sets `moduleResolution: "bundler"`
and `allowImportingTsExtensions: true`, so Deno's mandatory `./x.ts` extensions resolve
under Vite unchanged. `include: ["src"]` does not block a file reached by import, and there
is a working precedent: `src/lib/__tests__/backupCodes.test.ts:6` already imports
`../../../supabase/functions/_shared/backup-codes`. No alias and no build step are needed.

**The pattern to avoid is the one this repo currently uses.** Four files —
`src/hooks/ai-config/embeddingDimensions.ts`, `src/lib/higgsfieldJobPayload.ts`,
`src/lib/higgsfieldModelSpecs.ts`, `src/lib/openinary.ts` — each duplicate a `_shared`
twin and point at it in a comment. **Not one has a test asserting the two agree.** That is
precisely the seam that let the MCP↔n8n-api field names drift until `upload_media` had never
worked. The registry is imported, not mirrored.

The contract test remains, because "imported today" is not "imported forever". It asserts,
per connector id: the field-name set the UI renders equals the field-name set the server
validates; every `secret: true` field is absent from `settings`; and every id in the DB
CHECK constraint exists in the registry. That last assertion is what would have caught the
four silently-downgraded types in §1.6.

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
| **Shopify** | shop domain, API version, **either** (client ID + client secret) **or** an existing admin-app access token | `X-Shopify-Access-Token`. Shopify says "You can no longer create **new** admin-created custom apps. **Existing apps are unaffected and continue to work**" — no date given ([docs](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin)) |
| **Salla** | client ID, client secret, access token, refresh token, expiry | OAuth 2.0 `Bearer`. **Access token expires in 14 days**, refresh within 1 month; parallel refreshes fail the whole grant ([docs](https://docs.salla.dev/421118m0)) |
| **Zid** | client ID, client secret, authorization token, **X-Manager-Token** | OAuth 2.0 authorization-code. Needs **two** headers, not one. Manager token lasts 1 year ([docs](https://docs.zid.sa/authorization)) |
| **Supabase** | project URL, **anon key only**, schema, table allow-list | `apikey` + `Authorization: Bearer` against PostgREST |
| **PostgreSQL / MySQL** | gateway URL, auth header, table/resource | https REST gateway — Prisma, Hasura, Directus or PostgREST. **Not** a raw driver |
| **Stripe** | restricted API key (`rk_live_…`/`rk_test_…`) | `Bearer`. Restricted keys carry per-resource Read/Write/None ([docs](https://docs.stripe.com/keys/restricted-api-keys)) |
| **custom_rest** | URL, header name, secret | Unchanged. The escape hatch. |
| **formula** | — | Local computation, no credentials. |

**Salla and Zid both expire, so refresh is a requirement, not a nice-to-have.** A connector
whose token silently dies is worse than no connector: the agent fails mid-conversation with
a customer. `refresh-tokens` already runs a bounded sweep for social accounts and is the
natural home, with the per-account worst-case budgeting `sweepBudget.ts` already enforces.

**Salla's refresh is harsher than "the grant fails", and this changes the design.** Reusing a
refresh token invalidates every token and the merchant must **reinstall the app**. So two
overlapping refreshes — a cron run racing another cron run, or racing a user clicking Test
Connection — do not merely fail: they brick the connection in a way only the merchant can
repair. `sweepBudget.ts` bounds *work*, not *concurrency per connector*.

**Per-connector serialization is therefore a hard requirement**, via `FOR UPDATE SKIP LOCKED`
or an advisory lock keyed on the connector id. The existing `pending_agent_replies` work
already established that `SKIP LOCKED` alone is not a lease; the same care applies here.

**Open question PR-8 must answer before it starts: whose OAuth client is this?** The field
list above implies the *merchant* supplies client ID and secret. In the normal Salla and Zid
flows those belong to a **Postora-registered partner app**, and the merchant only authorizes
it. If that is the intended shape, PR-8 is an app-registration and redirect-URI project, not
a field-schema change, and it is much larger than the table suggests. This is not decided
here.

**The `mysql_postgres` entry was wrong in revision 1 and is corrected above.** It described
host/port/user/password and a "direct driver connection". The existing directory entry is an
**https REST gateway** — "through Prisma, Hasura, Directus, or PostgREST", `defaultUrl:
https://api.yourdomain.com/sql/products`. A raw TCP driver would also have contradicted §5.3
rule 1 (`assertPublicHttpsUrl` on every user-supplied host) and probably cannot open a socket
from the functions container at all. Redefining a shipped connector as a side effect of a
field-schema change was the actual error.

**Supabase: service-role keys are refused in v1.** Revision 1 accepted one alongside a table
allow-list. That allow-list is security theatre, and the reason is specific to PostgREST:

- `/rest/v1/rpc/<fn>` reaches any exposed function, bypassing table names entirely.
- **Resource embedding** — `?select=*,orders(*)` — reads tables that were never on the list.
- Functions can be invoked from inside `select=`.
- A view can shadow an allow-listed table name.

An allow-list checked against a table *name* does not survive any of these. And the
consequence is worse than reading an extra table: adapter output is pushed verbatim into the
model's message list (`ai-agent-reply/index.ts:942-946`), so another tenant's rows would be
**spoken to a customer in a DM**.

So: **anon key only**. The target project's own RLS is the boundary, which is the one
enforcement point that cannot be talked around. This is the same lesson as the `ai-knowledge`
bucket that had drifted public — a credential that bypasses the policy engine makes every
policy behind it decorative.

If service-role support is ever added, the allow-list cannot be the mechanism. The adapter
must build the **entire URL** from `settings`, with the agent choosing only which
allow-listed table and which search terms, so `/rpc/` and embedded relations are structurally
unreachable rather than filtered — and PR-5's tests must assert that property directly.

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
| **Courier tracking** | carrier, account number, API key | Per-carrier | **"Where is my order" is the top post-purchase DM intent in this market.** One read-only connector covering SMSA, Aramex and DHL by-reference lookup |
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

Revision 1 proposed tracking "the reason the form holds its values" — a state machine. That
is over-modelled for a problem with three one-line fixes, and the client is the layer that
already failed once. The server guard is the actual safety net; the client fixes stop the
form being wrong in the first place.

1. **Server-side, and first: a blanking write must be deliberate.** `ai_upsert_config`
   rejects a payload whose `persona_instructions` **or** `business_profile_text` is empty
   while the stored value is not, unless the client marks the clear explicitly. This one
   change closes every variant, including ones nobody has thought of, and it closes them for
   the Knowledge tab too — which revision 1 missed by naming only the persona field, despite
   its own §1.3 identifying that tab as the second writer.

2. **Reset only on a real account change.** The defaults-reset should fire when
   `loadedAccountId !== accountId`, not on every `config` identity transition. The same
   account re-reading `null` after an invalidation is not a reason to wipe a dirty form —
   and that re-read is the provable trigger from §1.2.

3. **Stop `accountId` flapping at the source.** `useSocialAccounts` keeps previous data
   across refetches, so `accounts` never transiently empties and the derived `accountId`
   (`AiAgentManager.tsx:67-69`) never round-trips through `null`. This removes the
   unproven-but-plausible trigger rather than defending against it downstream.

4. **Both writers get the same guard.** `AiKnowledgeManager` adopts
   `!error && loadedAccountId === accountId` and disables Save on an empty profile over a
   non-empty stored one. Being the quieter surface is not a reason to have the weaker check —
   it is the reason the weaker check went unnoticed.

5. **Narrow the invalidation key.** `useAiAgentConfig.ts:102` invalidates the whole platform
   prefix; both tabs already share the exact key
   `["ai-agent-config", user, platform, accountId]`, so the prefix form is a relic of the
   pre-scoping shape. Revision 1 said "refetch siblings only when they are not dirty" — that
   is **not implementable where it was specified**: the hook cannot see component dirty
   state. With an exact key there are no siblings needing a refetch after an account-scoped
   write, so the problem dissolves instead of needing a mechanism.

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

The Facebook page `الطملاوي…` has `is_enabled=false` and an empty persona.

**The text is not lost, and revision 1 was wrong to say it did not exist anywhere.** The user
pasted the same persona into four platforms in eleven minutes, and three of those saves
landed. `CareerFlow` (facebook), `careerflowkw` (instagram) and `postora.cloud` (threads) all
hold **1402 characters of persona and 2249 of business profile** — byte-identical lengths, so
almost certainly the same text. It is recoverable from the user's own UI in seconds by
opening a sibling account's Settings tab and copying.

What *is* unrecoverable is the row's own prior content, and the avenue that sounds most
promising is genuinely closed: `persistDelivery` (`ai-agent-reply/index.ts:648-657`) writes
only `user` and `assistant` turns, so the system prompt carrying the persona is never stored.

The correction matters beyond this incident. "Unrecoverable" was asserted from the affected
row alone, without looking at the rows beside it — the same narrow-query mistake that made
`NULL` vs `''` decisive in §1.1, arrived at from the other direction.

The user does **not** have to wait for PR-1 to fix it. Three of the four saves that morning
landed correctly, so the workflow works; re-enter the persona, enable the agent, and confirm
the row. What PR-1 buys is that the next one cannot silently fail the same way. A repair
check afterwards:

```sql
SELECT a.platform_username, length(c.persona_instructions), c.is_enabled
FROM ai_agent_configs c JOIN social_accounts a ON a.id = c.social_account_id
WHERE c.user_id = :uid AND c.platform = 'facebook';
```

---

## 9. PR order

Order is load-bearing. A migration always lands **before** the code that depends on it, and
the frontend auto-deploys on `main` while Edge Functions are copied separately.

| PR | Contents | Gate |
|---|---|---|
| **PR-1** | Blank-save fix, `AiKnowledgeManager` guard, invalidation key narrowed | Regression tests fail without the fix |
| **PR-2** | Connector registry + field schemas + **four-way contract test**. No behaviour change | Contract test passes for all types |
| **PR-3** | Migration: scope (`DEFAULT 'all_accounts'`) + scope/account CHECK + credential columns + `NULLS NOT DISTINCT` index + **DB CHECK rebuilt for the four missing types**. **No drops** | Rehearsed with `ROLLBACK` against production |
| **PR-4** | `ai_upsert_tool` / `ai_list_tools` write scoped rows and Vault credentials; account dropdown on the Tools tab; unknown type → **400, not a downgrade**; `ai_delete_tool` deletes the Vault secret; cascade trigger | Deployed before PR-6 |
| **PR-5** | **`ai-agent-reply` loads tools scoped to the account** + dual-read of `secret` | Account A's connector must not appear in account B's conversation |
| **PR-6** | Adapters + `test_connection` + `read_only_mode` enforcement + redaction, WooCommerce and Supabase first | Live test against a real store |
| **PR-7** | Contract migration: drop `ai_agent_tools_user_id_name_key`, migrate `secret` into Vault | Forward-only; say so in the runbook |
| **PR-8** | Knowledge list filtering + account-named source titles | Predicate matches the retrieval RPCs |
| **PR-9** | OAuth flows (Salla, Zid, Shopify) + refresh with **per-connector serialization** | Expiry simulated, not assumed |

### 9.1 Work the first revision's table silently assumed

Four items belonged to no PR at all. Three of them mean the feature does not work.

1. **`ai-agent-reply` loads tools by `user_id` alone** (`index.ts:837-841`):
   ```ts
   .from("ai_agent_tools").select(…).eq("user_id", request.user_id).eq("is_enabled", true)
   ```
   No account, no platform. **Scoping the table changes nothing until this query changes** —
   account A's connectors keep running in account B's conversations. Now PR-5, and the gate
   is stated as a behaviour, not a diff.

2. **The DB `CHECK` cannot be altered, only dropped and recreated.** Adding `myfatoorah`,
   `stripe`, `higgsfield` and `mcp_custom` is a `DROP CONSTRAINT` / `ADD CONSTRAINT`
   migration, and it must land **before** PR-4 starts accepting those types — otherwise the
   400 that replaces the silent downgrade becomes a constraint violation instead. Now PR-3.

3. **`DatabaseConnectorsManager` keys its configured-state map by `connector_type`**
   (`:620-626`). Once one account can have two WooCommerce connectors, the card shows one
   arbitrary tool's state. The directory's whole "Connected" model needs rework in PR-4.

4. **The component is mounted twice.** Inside the agent tabs (`AiAgentManager.tsx:348`, no
   props) *and* at `Settings.tsx:174` with **no platform and no account at all**. "Add the
   account dropdown to the Tools tab" says nothing about what the Settings surface should
   show. PR-4 must decide: either it becomes a read-only overview of every account's
   connectors, or it is removed. Leaving an account-less write surface against an
   account-scoped table is how the legacy rows in §4.1 keep being created.

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

## 11. Resolved: adapters get their own function

Adapters run in a dedicated `ai-connector-call`, **and it does not buy the reply loop more
wall-clock.** That caveat is the honest part: an in-conversation tool call still blocks the
reply, whose `WORKER_BUDGET_MS = 60_000` kill (`ai-agent-reply/logic.ts:263-267`) is
unchanged by moving code elsewhere. Anyone selling the split as "more budget" is wrong.

The reply-side protection is the pattern already in the file: `CUSTOM_TOOL_TIMEOUT_MS =
10_000` (`tools.ts:350`), with failure **returned as tool output rather than thrown**, so the
model degrades gracefully instead of the worker dying.

The split earns its keep for four other reasons:

1. **`test_connection` needs an executor anyway.** It is called from the Tools UI through
   `messaging-api`. One shared function beats duplicating every adapter in two places.
2. **Deploys are by-hand file copies.** Isolating frequently-changing adapter code means
   connector work never redeploys `ai-agent-reply` — the most failure-sensitive function
   here, where the 60s kill leaves no log row and regressions are near-invisible.
3. **Credential custody.** Confining `vault.decrypted_secrets` reads to one function keeps
   them out of the reply worker entirely, so a prompt-injected model response can never reach
   credential-handling code.
4. **It can log its own early exit**, which is the actual complaint behind the original
   question.
