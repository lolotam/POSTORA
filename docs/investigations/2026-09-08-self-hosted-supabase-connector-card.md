# Connecting the AI-agent connector cards to a self-hosted Supabase — findings

Date: 2026-09-08.

**Question asked.** On `/automation/agents?tab=tools`, can the **Supabase (PostgreSQL)**
card or the **Custom MCP Server** card be pointed at a *self-hosted* Supabase stack
instead of a Supabase Cloud project — and can table/column scoping work there with the
same logic as the cloud card?

**Target used for live evidence.** The self-hosted Supabase behind
`https://supabase.danat-future.com` (Dokploy compose stack `danatfuture-supabase-ozoxsa`
on `49.12.59.137`, reached via `ssh-danatfuture-mcp`). This is a *different* server and a
different product from Postora's own stack; it was used purely as a representative
self-hosted target.

Code evidence is from `F:\Postora_new` at commit `5b3a98e9`.

---

> **CORRECTION, 2026-09-09.** Two claims below were wrong and are corrected here
> rather than silently edited.
>
> **1. Kong does NOT discard a client-supplied bearer token.** §A3 inferred that
> from the `request-transformer` plugin's `replace` action without resolving what
> it substitutes. `volumes/api/kong-entrypoint.sh` builds the expression, and its
> first branch preserves any `Authorization` header that does not begin with
> `Bearer sb_`:
>
> ```lua
> (headers.authorization ~= nil
>    and headers.authorization:sub(1, 10) ~= 'Bearer sb_'
>    and headers.authorization)
>  or (headers.apikey == '<secret>'      and 'Bearer <service_role>')
>  or (headers.apikey == '<publishable>' and 'Bearer <anon>')
>  or headers.apikey
> ```
>
> A customer therefore CAN mint a JWT for a dedicated least-privilege Postgres
> role and have PostgREST honour its `role` claim, sending the anon key as
> `apikey` to satisfy Kong's key-auth and ACL. Postora's connector still refuses
> anything but an anon-role key, so this is a capability of the stack, not of the
> card — but the stack is not the constraint this document claimed.
>
> **2. The row and output caps in §A6 are no longer fixed.** They became
> operator-configurable on the branch `feat/supabase-connector-full-table-reads`:
> `max_rows` defaults to 25 and goes to 1000, `page_size` defaults to 200, and the
> adapter pages internally and reports `has_more`, `next_offset` and a stop
> reason. Reading more than one page requires an `order_by` column, because offset
> paging without a stable order duplicates and skips rows.

## Verdicts

| Question | Verdict | Where proven |
|---|---|---|
| Does anything restrict the connector to `*.supabase.co`? | **No.** Any public HTTPS host is accepted. | `aiTools.ts:26`, `toolWrites.ts:76-95`, `tools.ts:605-624` |
| Is the table allow-list enforced, or only a UI/prompt hint? | **Enforced server-side**, before the URL is built. | `ai-agent-adapters/supabase.ts:124-141`, `:152-173` |
| Is the column list enforced? | **Yes for output**; it overrides the model. Two gaps below. | `ai-agent-adapters/supabase.ts:169-178` |
| Can the card use a service-role key to bypass RLS? | **No — refused by design.** | `ai-agent-adapters/supabase.ts:51-73` |
| Does each user need to configure their own database? | **Only if RLS is on.** Grants are automatic; RLS is the sole gate. | §B5 |
| Are database functions ever needed? | **No.** RPC is refused, so a function on the target is unreachable. | §A6, §B5 |
| Will it read *this* target out of the box? | **No.** All 72 tables have RLS on; anon sees ~12. | Live probe, §B4 |
| Is the Custom MCP Server card usable for this? | **No.** It is not MCP; it is a single webhook POST. | `ai-agent-reply/tools.ts:626-678` |

---

# Part A — What the Postora code actually does

## A1. The Supabase connector's five fields

`supabase/functions/_shared/connectorRegistry.ts:139-195`
(byte-identical browser mirror at `src/lib/connectorRegistry.ts:136-192`; `diff` shows
only comments and `SERVER_CONNECTOR_TYPES` / `connectorUsageGuide` differ):

```ts
supabase: {
  type: "supabase",
  label: "Supabase",
  auth_strategy: "manual_credentials",
  category: "databases",
  credentials: [
    { key: "project_url",      label: "Project URL",                kind: "url",    required: true },
    { key: "anon_key",         label: "Anon key",                   kind: "secret", required: true },
    { key: "schema",           label: "Schema",                     kind: "text",   required: true },
    { key: "table_allow_list", label: "Table allow-list",           kind: "text",   required: true },
    { key: "select_columns",   label: "Columns to read (optional)", kind: "text",   required: false },
  ],
```

Per-call model-facing parameters are `table`, `select`, `filters`, with
`additionalProperties: false` (`connectorRegistry.ts:118-136`).

There is **no row-limit field and no write-mode field**. The row limit is a hardcoded
constant (§A5); `read_only_mode` is a generic row column, not a Supabase setting.

## A2. Host validation — no domain allow-list exists anywhere

Three layers, none of which inspects the domain.

**Layer 1 — browser form** (`src/lib/aiTools.ts:26-28`), called from
`DatabaseConnectorsManager.tsx:1260-1262`:

```ts
export function validateAiToolUrl(url: string): string | null {
  return /^https:\/\/.+/.test(url) ? null : "URL must start with https://";
}
```

**Layer 2 — save time** (`supabase/functions/messaging-api/toolWrites.ts:76-95`):

```ts
const privateIpLiteral = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
if (
  host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
  !host.includes(".") || privateIpLiteral.test(host) || host.includes(":")
) {
  throw new ToolWriteError("Tool URL must point to a public host");
}
```

**Layer 3 — execution time** (`supabase/functions/ai-agent-reply/tools.ts:605-624`),
wired in at `ai-agent-adapters/http.ts:44` and re-run on every redirect hop at `http.ts:58`,
with cross-origin redirects refused at `http.ts:59-61`:

```ts
const records = await Promise.allSettled([
  Deno.resolveDns(host, "A"),
  Deno.resolveDns(host, "AAAA"),
]);
const addresses = records.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
if (!addresses.length) throw new Error("Connector URL host does not resolve");
if (addresses.some(isPrivateIp)) throw new Error("Connector URL resolves to a private address");
```

**Confirmation of absence.** Grepped `supabase\.co|ssrf|allowlist|allowedHosts|ALLOWED_HOSTS`
across the repo. Every `.supabase.co` hit is a test fixture, a docs link, or the unrelated
`send-expiry-reminders` string replace. There is no `endsWith(".supabase.co")` and no host
allow-list array.

The codebase in fact *forbids* assuming the hosted domain — `src/lib/__tests__/noSupabaseCoHardcode.test.ts:6,30`
uses `"self-hosted-curemed.supabase.co"` as its fixture — and the picker's error copy names
self-hosting outright (`src/lib/supabaseIntrospection.ts:87`):

> "Could not reach the project. Check the URL — and if it is self-hosted, its CORS settings."

**Conclusion: `https://supabase.danat-future.com` is accepted at every layer.**

### A2a. Save-time / execution-time field split

Save-time validation runs on the row's `url` column (`toolWrites.ts:135-137`) while the
adapter reads `settings.project_url` (`ai-agent-adapters/supabase.ts:153`). The UI keeps
them in sync (`DatabaseConnectorsManager.tsx:1240-1245`), so a direct API caller could set
them differently. No bypass results, because layer 3 re-validates the URL that is actually
fetched.

## A3. The only Supabase-specific credential check is on key *shape*

`supabase/functions/ai-agent-adapters/supabase.ts:51-73`:

```ts
export function validateSupabaseAnonKey(key: string): void {
  if (key.startsWith("sb_secret_")) {
    throw new SupabaseValidationError("supabase_service_role_refused", ...);
  }
  if (key.startsWith("sb_publishable_")) return;

  const payload = decodeJwtPayload(key);
  if (payload?.role === "service_role") {
    throw new SupabaseValidationError("supabase_service_role_refused", ...);
  }
  if (payload?.role !== "anon") {
    throw new SupabaseValidationError("supabase_anon_key_required", ...);
  }
}
```

**This is the single most consequential finding for self-hosted use.** The card cannot be
given a service-role key, and cannot be given a JWT minted for a custom Postgres role: the
`role` claim must literally be `anon`. Postgres therefore always executes as `anon`, and
RLS on the target project is the whole security boundary.

The adapter sends the same key twice (`ai-agent-adapters/supabase.ts:205-211`):

```ts
headers: {
  Accept: "application/json",
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
  "Accept-Profile": schema,
},
```

Relevant to self-hosting: a custom JWT placed here would also have to be registered as a
Kong `keyauth_credentials` key, since Kong's key-auth on `/rest/v1` only knows the
consumers in `volumes/api/kong.yml`. Not needed if you stay on the anon key.

## A4. Table allow-list — genuinely enforced server-side

`supabase/functions/ai-agent-adapters/supabase.ts:112-141` and `:152-173`:

```ts
function validateResource(table: string, select: string, allowList: string[]): void {
  if (/(^|\/)rpc\//i.test(table)) {
    throw new SupabaseValidationError("supabase_rpc_refused", "Supabase RPC paths are not allowed.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new SupabaseValidationError("supabase_resource_invalid", "The Supabase resource is invalid.");
  }
  if (!allowList.includes(table)) {
    throw new SupabaseValidationError(
      "supabase_resource_refused",
      `Table "${table}" is not allowed for this connector. Allowed tables: ${allowList.join(", ")}.`,
    );
  }
```

Runs **before** the URL is built and before any fetch. `settings` is read from the DB row
under service role (`ai-agent-adapters/handler.ts:162-167`), never from the model. An empty
allow-list disables the connector entirely (`supabase_configuration_invalid`).

The file states its own status at `:142-143`:

> "Defence in depth only: the table allow-list is not the security boundary. The target
> project's RLS is the boundary that PostgREST query syntax cannot bypass."

## A5. Column list — enforced, with two gaps

`supabase/functions/ai-agent-adapters/supabase.ts:169-178`:

```ts
const configuredColumns = requiredString(invocation.tool.settings, "select_columns");
const select = configuredColumns
  ? configuredColumns.split(/[,\n]/).map((c) => c.trim()).filter(Boolean).join(",")
  : requiredString(parameters, "select") ?? "*";
validateResource(table, select, allowList);

const url = new URL(`${projectUrl.replace(/\/+$/, "")}/rest/v1/${encodeURIComponent(table)}`);
url.searchParams.set("select", select);
```

When set, the operator's list **overrides** the model's `select` rather than defaulting it
(comment at `:166-168`). Two gaps:

- **Gap A — empty list.** `select` falls through to the model's value or `"*"`. Only the
  parenthesis ban (`:144-149`, `supabase_embedding_refused`) applies. Any column of an
  allowed table is selectable.
- **Gap B — `filters` are never checked against `select_columns`** (`:179-190`). Only
  identifier shape and value type are validated:

  ```ts
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) throw new SupabaseValidationError("supabase_filter_invalid", ...);
  if (!["string", "number", "boolean"].includes(typeof value)) throw new SupabaseValidationError("supabase_filter_invalid", ...);
  url.searchParams.set(column, `eq.${String(value)}`);
  ```

  With columns restricted to `type_name, price`, the model can still send
  `filters: {email: "x@y.z"}` → `?email=eq.x@y.z`, an equality oracle over any column of an
  allowed table. Per `:142-143` this is stated design intent (RLS is the boundary), not an
  oversight — but it is why §C's view approach is stronger than the field alone.

### A5a. One column list serves every allowed table

`select_columns` is a single string applied to whichever `table` the model picked. Allowing
two tables that do not share column names makes the call against the second one fail with
PostgREST `42703`. **Use one connector card per table** when the column list is set.

## A6. Read/write, row limit, RPC

**Read-only unconditionally** — `ai-agent-adapters/dispatcher.ts:52-80`, before adapter
selection:

```ts
if (invocation.tool.read_only_mode !== false && requestedMethod !== "GET") {
  ... connectorFailure(vendor, "read_only_violation", ...)
}
if (requestedMethod !== "GET") {
  ... connectorFailure(vendor, "connector_write_unsupported", ...)
}
```

The second branch fires **even when `read_only_mode` is off**, so the UI toggle is moot for
Supabase. INSERT/UPDATE/DELETE are impossible. `ai-agent-reply/connectorExecution.ts:111-117`
never sends a `method`, so the agent path is always GET. Test-connection reports
`read_only: true` (`supabase.ts:239-246`).

**Row limit — hardcoded** (`supabase.ts:81-86`, applied `:177`):

| Cap | Value | Source |
|---|---|---|
| Rows per call | 25 | `ROW_LIMIT`, `supabase.ts:81` |
| Chars per cell | 160 | `MAX_VALUE_CHARS`, `supabase.ts:86` |
| Chars per payload | 8000 | `ADAPTER_OUTPUT_LIMIT`, `connectorExecution.ts:29` |
| Rows on test-connection | 1 | `supabase.ts:177` |

**RPC refused twice over** (`supabase.ts:125-130`) — the explicit `/rpc/` check plus the
identifier regex, which rejects any `/`.

## A7. Custom MCP Server (`mcp_custom`) — not MCP

**Fields** (`connectorRegistry.ts:558-584`): `server_url` and `auth_header`. That is the
complete list. No transport field, no tool allow-list, no scoping equivalent, no host
allow-list.

**No adapter.** `mcp_custom` has no `capabilities`, so `shouldUseAdapter`
(`connectorRegistry.ts:719-723`) is false and `executeRoutedCustomTool`
(`connectorExecution.ts:291-293`) falls through to the legacy webhook path
(`ai-agent-reply/tools.ts:626-678`):

```ts
const response = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({
    tool: tool.name,
    input,
    conversation_id: context.conversationId,
    platform: context.platform,
    customer_name: context.customerName,
  }),
  signal: controller.signal,
  redirect: "manual",
});
```

No JSON-RPC, no `tools/list`, no SSE handshake — despite the card's
`defaultUrl: "https://mcp.yourdomain.com/sse"` (`DatabaseConnectorsManager.tsx:451`). One
POST with a single free-text `input`, 10 s timeout, 2000-char output cap
(`tools.ts:580-581`). `settings` is never read on this path, so **scoping is entirely the
remote server's problem** — Postora sends no tool filter and no resource scope.

No test-connection button either: the card renders *"Generic MCP — no adapter yet"*
(`DatabaseConnectorsManager.tsx:652,668-670`), and `dispatcher.ts:82-92` would answer
`connector_adapter_unavailable`, since `ADAPTERS` holds only WooCommerce and Supabase
(`dispatcher.ts:14-17`).

## A8. Where credentials live

Table `public.ai_agent_tools`
(`supabase/migrations/20260831130000_connector_scope_and_sharing.sql:104-110`):

| Store | Encrypted | Holds |
|---|---|---|
| `settings` JSONB | No | Supabase `project_url`, `schema`, `table_allow_list`, `select_columns`; MCP `server_url` |
| `credentials_secret_id` → Vault | Yes | Supabase `anon_key`, MCP `auth_header` |
| legacy `secret` column | No | `custom_rest` webhook secret only |

Vault writes go through a SQL wrapper doing decrypt-merge-re-encrypt inside the database
process (`20260831140000_connector_secret_reclaim.sql:121-132`), so plaintext never reaches
the edge function. Read-back is `public.get_connector_credential`, `SECURITY DEFINER`
(`20260831150000_connector_credential_read.sql:13-42`):

```sql
REVOKE EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_connector_credential(uuid, uuid) TO service_role;
```

`configured_secret_fields` is derived server-side so the UI can show "✓ set" without
decrypting. This is why a saved connector's key is blank on edit, and why the schema picker
cannot introspect until the key is re-entered (`SupabaseSchemaPicker.tsx:16-21`).

---

# Part B — Live evidence from the self-hosted target

## B1. Stack inventory

| Item | Value |
|---|---|
| Host | `49.12.59.137`, hostname `danat-future` |
| Stack dir | `/etc/dokploy/compose/danatfuture-supabase-ozoxsa/`, env at `code/.env` |
| Postgres | 17.6, container `danatfuture-supabase-ozoxsa-db-1` |
| Gateway | Kong 3.9.1 → `supabase.danat-future.com`, PostgREST v14.12 |
| Pooler | Supavisor 2.9.5, port 6543, tenant `6c9e561c-2341-4f12-85d6-761cbff39ed3` |
| Published host ports | 80, 443, 54329 only. **5432 and 6543 are not published.** |
| Host firewall | `ufw` inactive |
| `PGRST_DB_SCHEMAS` | `public,storage,graphql_public` |
| Public tables | 72, **all 72 with RLS enabled**, 239 policies |

Login roles present: `authenticator`, `danat-future`, `danat_future`, `pgbouncer`,
`postgres`, `supabase_admin`, `supabase_auth_admin`, `supabase_etl_admin`,
`supabase_functions_admin`, `supabase_read_only_user`, `supabase_replication_admin`,
`supabase_storage_admin`.

Role attributes (relevant to both §C and the SSH route):

| Role | superuser | bypassrls | memberships |
|---|---|---|---|
| `supabase_admin` | yes | yes | — |
| `postgres` | **no** | yes | — |
| `supabase_read_only_user` | no | yes | `pg_read_all_data`, `pg_monitor` |
| `authenticator` | no | no | — |

## B2. CORS permits the card's browser introspection

```
OPTIONS https://supabase.danat-future.com/rest/v1/
  Origin: https://postora.cloud
  Access-Control-Request-Headers: apikey,authorization,accept-profile

HTTP/2 200
access-control-allow-origin: *
access-control-allow-headers: apikey,authorization,accept-profile
access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS,TRACE,CONNECT
```

Exactly the three headers `fetchSupabaseIntrospection` sends
(`src/lib/supabaseIntrospection.ts:76-83`).

## B3. Introspection works *better* than on Supabase Cloud

`GET /rest/v1/` with the **anon** key returned HTTP 200 and a full OpenAPI document:

| Measure | Value |
|---|---|
| Tables listed to the anon key | 54 |
| Definitions carrying columns | 54 |
| Columns on `contracts` | 22 |

On Supabase Cloud this endpoint is gated to `service_role`, which is the case
`TableListUnavailableError` exists for (`supabaseIntrospection.ts:91-98`) and which forces
the picker into per-table sampling (`SupabaseSchemaPicker.tsx:68-84`). Self-hosted
PostgREST v14.12 has no such gate, so **the full table + column picker works**.

`Accept-Profile` schema switching also behaves as the card expects:

| Schema | Status |
|---|---|
| `public` | 200 |
| `storage` | 200 |
| `auth` (not exposed) | 406 |

406 is precisely what `supabaseIntrospection.ts:101-103` translates to
*"Schema … is not exposed by this project."*

## B4. But the anon key reads almost nothing — the blocking finding

| Table | Rows returned to the anon key |
|---|---|
| `contracts` | 0 (RLS) |
| `tenants` | 0 (RLS) |
| `buildings` | 0 (RLS) |
| `units` | error `42501` — see below, the policy itself cannot be evaluated |
| `whatsapp_contacts` | error `42501` — no `SELECT` grant to `anon` |
| `landing_page_settings` | 2 |

Grant/policy counts:

| Measure | Value |
|---|---|
| Tables with `SELECT` granted to `anon` | 54 |
| Tables with `SELECT` granted to `authenticated` | 70 |
| Policies on `public` | 239 |
| Policies naming `anon` or `public` | 15 |

The 12 tables carrying an anon-facing `SELECT` policy are all public-website tables. Note
that a policy here is necessary but not sufficient — see §B4a, where three of these are
listed yet unreadable:
`building_categories`, `commercial_brand_contracts`, `commercial_brands`, `companies`,
`contact_inquiries`, `contract_units`, `landing_carousel_slides`, `landing_media`,
`landing_page_sections`, `landing_page_settings`, `properties`, `units`.

54 exposed vs 72 in the schema: 18 tables have no anon grant, so the picker will not show
them at all.

### B4a. A policy that reads another table needs a grant on that table too

`units` and `properties` are both base tables, both appear in the anon-policy list, and both
carry an anon `SELECT` grant — yet both fail:

```json
{"code":"42501",
 "hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.contract_units TO anon;",
 "message":"permission denied for table contract_units"}
```

The cause is the policy expression, not the target table:

```sql
-- policy units_select_tenant, roles={public}
USING (EXISTS (
  SELECT 1 FROM contract_units cu
    JOIN contracts c ON c.id = cu.contract_id
    JOIN profiles  p ON p.tenant_id = c.tenant_id
  WHERE p.id = auth.uid() AND cu.unit_id = units.id))
```

RLS policy expressions execute as the *calling* role. `anon` holds no `SELECT` on
`contract_units`, so evaluating the policy raises `42501` before any row is considered.
A table can therefore be granted, policied, and still completely unreadable.

This is the strongest argument for §C. A view owned by a `BYPASSRLS` role never evaluates
these policies at all, so it sidesteps the whole grant chain rather than requiring you to
widen grants on three more tables to make one table readable.

**Because §A3 refuses every non-anon credential, no configuration of the card reaches
`contracts` or `tenants`.**

---

## B5. Does this generalise to any self-hosted stack, or is Danat special?

The Postora side is fully generic. Nothing per-target is needed:

| Generic across every self-hosted Supabase | Why |
|---|---|
| The URL is accepted | No allow-list exists (§A2) |
| The transport works | `/rest/v1` + `apikey`/`Bearer`/`Accept-Profile` is standard on every Supabase deployment, cloud or self-hosted |
| Table + column scoping | Enforced inside Postora's edge function, independent of the target (§A4, §A5) |
| Read-only, 25 rows, no RPC | Postora-side constants (§A6) |

**Database functions are never needed.** RPC is refused twice over (§A6), so a
`SECURITY DEFINER` function on the target is unreachable and pointless here.

**CORS is not a hard requirement.** The agent's calls run server-to-server from
`ai-agent-adapters` (`safeVendorFetch`), where CORS does not apply. Only the browser-side
schema picker needs it (`supabaseIntrospection.ts` fetches from the browser by design,
`:61-66`). A stack with restrictive CORS still works; the operator just types table and
column names instead of ticking boxes.

**The one variable is RLS, and only RLS.** The Supabase bootstrap sets default privileges on
the public schema, confirmed on this target:

```
pg_default_acl, schema public, object type r (table):
  {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
   authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
```

So on a stock self-hosted Supabase, **a new table in `public` is granted to `anon`
automatically**. Grants are not the gate. That leaves three outcomes:

| Target's state | What the connector reads | Config needed |
|---|---|---|
| RLS **off** (the Postgres default for a raw `CREATE TABLE`) | Everything in the table | **None.** Works immediately. |
| RLS on, no anon-facing policy | 0 rows | Part C |
| RLS on, policy joins other tables | `42501` (§B4a) | Part C |

Danat sits at the strict end: **0 of 72 public tables have RLS off**. A project built with
raw SQL migrations and no RLS would connect and read with no database work at all; a project
built through Studio, which enables RLS on table creation, lands in rows two and three.

**The framing that settles it:** the connector can only ever see what the target's anon key
could already see from any browser. It grants itself no privilege. So "must I configure
anything?" reduces to "can my anon key already read this table?" — and if the answer is no,
making it yes is a decision about public exposure of that data, not a Postora setting.

---

# Part C — The mechanism that satisfies "only some tables, only some columns"

Do not loosen policies on the real tables. Give the agent a schema of views that select
exactly the permitted columns. A view runs with its owner's privileges (PG15+ default,
`security_invoker` off), and `postgres` here carries `BYPASSRLS`, so the base tables' RLS
does not apply inside the view. **The view definition becomes the policy.**

This closes Gap B from §A5: a column absent from the view cannot be filtered on, whereas
`select_columns` alone only restricts what comes back.

```sql
-- as postgres, so postgres owns the views
-- docker exec -i danatfuture-supabase-ozoxsa-db-1 psql -U postgres -d postgres

create schema if not exists agent;

-- column names below are the real ones on this target, checked against
-- information_schema; note `contracts` has `code` and `state`, not
-- `contract_number`/`status`, and `units` has `code`/`name`, not `unit_number`
create or replace view agent.contracts as
  select id, code, start_date, end_date, state
  from public.contracts
  where archived_at is null;        -- optional row filter

create or replace view agent.units as
  select id, code, name, building_id, status, floor, area
  from public.units;

grant usage on schema agent to anon;
grant select on all tables in schema agent to anon;
alter default privileges in schema agent grant select on tables to anon;

notify pgrst, 'reload schema';
```

Then expose the schema. `PGRST_DB_SCHEMAS` is interpolated from `code/.env`
(`docker-compose.yml:25` and `:171`):

```bash
cd /etc/dokploy/compose/danatfuture-supabase-ozoxsa/code
sed -i 's/^PGRST_DB_SCHEMAS=.*/PGRST_DB_SCHEMAS=public,storage,graphql_public,agent/' .env
docker compose -p danatfuture-supabase-ozoxsa up -d --force-recreate --no-deps rest
```

The `-p` flag matters: omitting it has previously left services behind a stray temporary
container. Check whether Dokploy also holds an environment for this compose before trusting
either source — on Postora's stack Dokploy's copy was empty and a deploy from the UI would
have wiped the on-disk file.

Card values:

| Field | Value |
|---|---|
| Project URL | `https://supabase.danat-future.com` |
| Anon key | `grep '^ANON_KEY=' …/code/.env` |
| Schema | `agent` |
| Table allow-list | `contracts` |
| Columns to read | `id, code, start_date, end_date, state` |

One card per view, per §A5a.

> **Security constraint that governs what may go in these views.** The target's anon key
> ships in its public website bundle. Anything granted to `anon` is readable by anyone who
> opens devtools on that site. Unit availability and brand listings are acceptable. Contract
> values, tenant names, payment records and phone numbers are not, however tight the
> connector's allow-list is. For genuinely private data the options are aggregate views
> carrying no identifying columns, or a separate service holding a privileged credential
> behind a narrow endpoint of its own.

---

# Part D — Defects found while investigating

Not fixed here; recorded for triage.

### D1. `mcp_custom` and `mysql_postgres` never send their configured auth header

`auth_header` is `kind: "secret"`, so `toolWrites.ts:191-195` routes it into the Vault blob.
The plaintext `secret` column is written only from the legacy field or from `custom_rest`
(`toolWrites.ts:399-406`):

```ts
if (input.legacySecret !== null) {
  values.secret = input.legacySecret;
} else if (input.clearLegacySecret) {
  values.secret = null;
}
if (input.connectorType === "custom_rest" && typeof input.secretPatch.secret === "string") {
  values.secret = input.secretPatch.secret;
}
```

The frontend payload never sets a legacy `secret` (`DatabaseConnectorsManager.tsx:1277-1301`).
`executeCustomTool` reads `tool.secret` (`tools.ts:639`), which stays null for `mcp_custom`.
Grepping `auth_header` across `supabase/functions/` finds it **only** in the two registry
definitions (`connectorRegistry.ts:210`, `:572`), never in execution code.

Effect: a required field is encrypted, stored, shown as "✓ set", and never transmitted.

### D2. Supabase card copy advertises RPC, which the adapter refuses

`DatabaseConnectorsManager.tsx:396` (`shortDesc`) reads *"Direct REST / RPC connection to
your Supabase PostgreSQL tables."* and `:397` (`description`) ends *"…and custom RPC
functions."* RPC is rejected at `ai-agent-adapters/supabase.ts:125-130`.

### D3. `mcp_custom` is presented as MCP but is a webhook

Label "Generic MCP" and `defaultUrl` ending `/sse` (`DatabaseConnectorsManager.tsx:451`)
imply a protocol the code does not speak (§A7). Either rename the card or implement a real
client.

---

# Part E — Unrelated host findings on the target server

Out of scope for the connector question, recorded because they were observed.

- **`danat-sqltest`** (supabase/postgres 15.1.1.78) publishes `0.0.0.0:54329` while `ufw` is
  inactive. Unless a provider-level firewall covers it, that is an internet-facing Postgres.
  Verify externally, then stop the container or rebind to `127.0.0.1:54329`.
- **`danat-mig-check`** has been up 6 days with no apparent consumer. Both look like
  migration-rehearsal leftovers.

---

# Appendix — commands used for the live evidence

```bash
# stack + ports + domains
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
ss -lntp | grep -E ':(5432|6543|8000|54329|443|80) '
docker inspect danatfuture-supabase-ozoxsa-kong-1 | grep -oE 'Host\(`[^`]+`\)' | sort -u

# schema + RLS
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U postgres -At -c \
  "select count(*) filter (where rowsecurity), count(*) from pg_tables where schemaname='public';"
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U postgres -At -c \
  "select rolname, rolsuper, rolbypassrls from pg_roles where rolcanlogin;"
docker exec danatfuture-supabase-ozoxsa-db-1 psql -U postgres -At -c \
  "select distinct tablename from pg_policies where schemaname='public'
     and cmd in ('SELECT','ALL') and ('anon'=any(roles) or 'public'=any(roles));"

# CORS preflight
curl -s -D - -o /dev/null -X OPTIONS 'https://supabase.danat-future.com/rest/v1/' \
  -H 'Origin: https://postora.cloud' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: apikey,authorization,accept-profile'

# introspection + row reads (ANON_KEY sourced from code/.env, never echoed)
curl -s 'https://supabase.danat-future.com/rest/v1/' \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'Accept-Profile: public'
curl -s 'https://supabase.danat-future.com/rest/v1/contracts?select=*&limit=2' \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
```

Host access via `ssh-danatfuture-mcp`. Code read at `F:\Postora_new`, commit `5b3a98e9`.
