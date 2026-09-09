# Supabase connector: full-table reads with per-table column scoping

Date: 2026-09-09
Status: revision 2, after Codex adversarial review round 1 (REJECT)
Branch: `feat/supabase-connector-full-table-reads`

Revision 2 corrects a factual error in revision 1 (§4.1) and resolves eleven
blocking objections. Changes from revision 1 are marked **[R2]**.

---

## 1. Problem

The Supabase connector returns at most **25 rows** per tool call, from a single
flat column list shared by every allowed table. A customer whose catalogue,
price list, or unit inventory exceeds 25 rows gets a silently truncated answer,
and the agent has no way to ask for the rest.

Three separate limits produce this, and only the first is intentional:

| Limit | Value | Location | Behaviour |
|---|---|---|---|
| `ROW_LIMIT` | 25 | `ai-agent-adapters/supabase.ts:81`, applied `:177` | PostgREST `limit=25`. Row 26 is never fetched. |
| `ADAPTER_OUTPUT_LIMIT` | 8000 | `ai-agent-reply/connectorExecution.ts:29`, applied `:155` | Raw `String.slice` on serialized JSON. **Cuts mid-JSON, no marker.** The model can receive invalid JSON with no signal anything was dropped. |
| `MAX_VALUE_CHARS` | 160 | `supabase.ts:86`, applied `:97-100` | Per-cell string truncation, marked `…[truncated]`. Correct as-is. |

There is **no pagination of any kind**: no `offset`, no `Range`, no
`Prefer: count=`, no `Content-Range` parsing anywhere in the Supabase path.

## 2. Goal

A customer connects any self-hosted Supabase, picks a table and the columns the
agent may read, and the agent can read **every row that connector's credential
is permitted to see** — bounded by an operator-set ceiling, delivered in pages,
with an accurate total.

**[R2] The promise is scoped to the credential, deliberately.** Revision 1 said
"read the table in full", which over-promised: the connector authenticates with
an anon-role key, so rows hidden by the customer's row-level security are not
readable and never will be through this path. §4.1 explains what is and is not
reachable, and how a customer widens it.

## 3. Requirements and assumptions

**In scope**

- R1. Configurable row ceiling per connector, replacing the hardcoded 25.
- R2. Read every credential-visible row of a table, in pages, without losing
  rows silently and without duplicating them.
- R3. Per-table column selection (today one flat list serves every table).
- R4. Accurate total row count, independent of how many rows were returned.
- R5. Works identically on self-hosted and on Supabase Cloud.
- R6. No regression for existing connectors: unconfigured means today's behaviour.

**Out of scope** (named so review does not drag them in)

- The Custom MCP Server card.
- **[R2]** The three defects in the investigation record, *including the card's
  RPC copy*. Revision 1's plan fixed the copy; that was scope creep and is removed.
- Write operations. The adapter is unconditionally read-only (`dispatcher.ts:52-80`).
- **[R2]** Adding a second credential for a least-privilege Postgres role. Now
  known to be technically possible (§4.1) but it is a security-review-bearing
  feature of its own, not a rider on a pagination change.

**Assumptions**

- A1. "Read the entire table" means *reachable in full across calls*, not
  *delivered in one LLM message*. A 50 000-row table cannot enter a chat completion.
- A2. Existing connectors keep `max_rows = 25` unless an operator raises it.

## 4. Constraints discovered before designing

### 4.1 [R2] CORRECTION — Kong does forward a client-supplied bearer token

Revision 1 asserted that a customer-minted JWT could never reach PostgREST,
because Kong's `rest-v1` route carries a `request-transformer` that *replaces*
the `Authorization` header. **That inference was wrong.** It read the plugin
without resolving what it replaces the header *with*.

The substituted expression comes from `kong-entrypoint.sh`:

```lua
$((headers.authorization ~= nil
    and headers.authorization:sub(1, 10) ~= 'Bearer sb_'
    and headers.authorization)
  or (headers.apikey == '<secret key>'      and 'Bearer <service_role JWT>')
  or (headers.apikey == '<publishable key>' and 'Bearer <anon JWT>')
  or headers.apikey)
```

The **first branch preserves the client's own `Authorization` header** whenever
one is present and does not begin with `Bearer sb_`. Verified by reading
`volumes/api/kong-entrypoint.sh` on a live self-hosted stack, 2026-09-09.

Two consequences:

1. A customer *can* mint a JWT for a dedicated least-privilege Postgres role and
   have PostgREST honour its `role` claim, sending the anon key as `apikey` to
   satisfy Kong's `key-auth` and ACL. This is a real future capability. It is
   **out of scope here** (§3) because it changes the credential contract and
   deserves its own review.
2. Nothing in this change depends on the corrected fact. The connector keeps
   sending the anon key in both headers (`supabase.ts:205-211`) and
   `validateSupabaseAnonKey` keeps refusing service-role keys (`:51-73`).

**What this feature therefore delivers:** every row visible to the anon role
under the customer's own policies. For a table with no restrictive policy that
is the whole table. For an RLS-protected table it is whatever the policies
permit, which may be zero rows — the same as today, just no longer capped at 25.
The connector's usage guide and the card's help text say so.

### 4.2 Model-driven pagination is not viable on its own

- `maxIterations` defaults to **5** (`ai-agent-reply/index.ts:1049`).
- The model budget is **elapsed**, not a fresh allowance:
  `modelBudgetRemaining` subtracts `now - startedAt` from
  `WORKER_BUDGET_MS 60000 − FLOOR_RESERVE_MS 12000 − SAFETY_MARGIN_MS 5000`
  (`logic.ts:445-459`). **[R2]** Revision 1 treated 43 s as a per-call
  allowance; it is the whole request's remaining time.
- Exhausting the iterations while the model still wants tool calls exits with an
  empty reply and returns `skipped: "no_reply_generated"` (`index.ts:1200-1221`)
  — the customer receives nothing.
- `messages` is never trimmed, so every page accumulates in the prompt forever.

Hence an adapter-side loop: one model round trip, N upstream requests.

### 4.3 [R2] The timeout fix must not be global

Revision 1 proposed lowering the shared per-hop `timeoutMs` from 10 s to 5 s in
`dependencies.ts:9`. **Rejected:** `createAdapterDependencies()` is shared, and
WooCommerce uses the same helper for category resolution and its main request
(`woocommerce.ts:189, 225-247`). A WooCommerce call taking 5.5 s works today and
would start failing.

Revised: the shared default is untouched. The Supabase adapter derives a
**per-hop timeout from its own remaining budget** by shallow-copying the
dependencies locally. Composio is unaffected either way — it routes separately
(`connectorExecution.ts:283-289`) with its own `COMPOSIO_EXECUTE_TIMEOUT_MS`.

`ADAPTER_CALL_TIMEOUT_MS` still rises 6 s → 12 s, but the caller now passes the
**remaining** request budget so a late tool call cannot overrun the worker
(§5.2).

### 4.4 `redactSensitive` mangles customer data

`dispatcher.ts:131` passes the customer's rows through `redactConnectorOutput` →
`redactSensitive` (`_shared/logging.ts:33-55`), which blanks any value whose key
matches `/token/i`, `/secret/i`, `/api[-_]?key/i`, `/^key$/i`, `/cookie/i`, and
any 64+ hex-character string. A customer column named `key` or `product_key`
returns `[REDACTED]`. Rare at 25 rows; common on a full-table read.

**[R2]** Revision 1 replaced the whole function and lost `credentialRepresentations()`
— which handles nested values, URL encoding and WooCommerce Basic credentials
(`redaction.ts:5-38`) — and changed every adapter. §5.6 is now far narrower.

### 4.5 `ConnectorParameterSchema` admits only string and object types

`connectorRegistry.ts:44-53`. New numeric model-facing parameters are declared
`"string"` and parsed in the adapter, the pattern WooCommerce's `limit` uses.

### 4.6 A new capability would leak into WooCommerce

Both adapters declare `capabilities = [...CAPABILITIES]` (`supabase.ts:259`,
`woocommerce.ts:290`). **[R2]** Dispatch also requires a `permissions` entry
(`dispatcher.ts:96-107`), so revision 1 overstated this as automatic. The
conclusion stands: counting is a **parameter**, not a capability.

### 4.7 [R2] PostgREST may return fewer rows than requested

`db-max-rows` caps a response server-side, so a short page does **not** mean the
table is exhausted. Revision 1's loop treated it as exhaustion and would have
returned 100 of 900 rows reporting `has_more: false`. Exhaustion is decided from
`Content-Range`, never from page length (§5.1).

### 4.8 [R2] Offset paging without an ORDER BY is not stable

Postgres does not guarantee row order between queries. Paging by offset without
a deterministic order can duplicate and skip rows. The design therefore
**refuses to page at all unless an ordering column is configured** (§5.3),
rather than silently returning a corrupted set.

## 5. Design

### 5.1 Adapter-side page loop

One tool call fetches up to `max_rows` by looping PostgREST internally.

```
resolve max_rows, page_size, offset, columns, filters, order_by
if more than one page is needed AND order_by is unset → single page only
loop while collected < max_rows:
    remaining = deadline - now;  if remaining < MIN_HOP_MS → stop "time_budget"
    GET ?select=…&order=<order_by>&limit=<pageLimit>&offset=<cursor>
      first request only: Prefer: count=exact → parse Content-Range total
    append rows while the character budget allows → else stop "char_budget"
    if page returned 0 rows → stop, exhausted
    if total is known and cursor >= total → stop, exhausted
return { rows, row_count, total, has_more, next_offset, truncated_by }
```

**[R2] Exhaustion** is `rows_seen >= total` (from `Content-Range`) or a
zero-length page. A short-but-non-empty page continues from the actual number
of rows received.

**[R2] No-progress guard.** If a page yields zero usable rows but the cursor
does not advance, the loop stops with `truncated_by: "no_progress"` rather than
spinning or reporting a `next_offset` that would repeat forever.

**[R2] Upstream failure mid-loop** returns the rows already collected with
`truncated_by: "upstream_error"` and `has_more: true`. Revision 1 mislabelled
this `byte_budget`. A failure on the *first* page is still a hard failure.

### 5.2 [R2] Budgets, corrected

| Constant | Now | New | Scope |
|---|---|---|---|
| `ADAPTER_CALL_TIMEOUT_MS` | 6 000 | 12 000 | Caller ceiling, **clamped to the request's remaining model budget**. |
| shared `timeoutMs` (`dependencies.ts:9`) | 10 000 | **unchanged** | WooCommerce keeps its headroom. |
| `SUPABASE_LOOP_BUDGET_MS` | — | 8 000 | New, Supabase only. |
| `SUPABASE_MIN_HOP_MS` | — | 1 500 | A hop is not started without at least this much left. |

Per-hop timeout inside the loop is `min(remaining, 5000)`, applied by
shallow-copying `dependencies` — never by mutating the shared factory. Since
`8000 + 1500 < 12000`, the loop cannot overrun its caller.

The caller clamp resolves §4.2's elapsed-budget problem: `executeRoutedCustomTool`
receives the remaining budget and uses `Math.min(ADAPTER_CALL_TIMEOUT_MS, remaining)`.

### 5.3 New connector settings

All in `ai_agent_tools.settings` (JSONB) — no migration (§7).

| Key | Default | Ceiling | Meaning |
|---|---|---|---|
| `max_rows` | 25 | 1000 | Rows one tool call may return in total. |
| `page_size` | 200 | 1000 | Rows per upstream request. |
| `column_map` | — | — | JSON, per-table column lists (§5.4). |
| `order_by` | — | — | **[R2]** Column to order by. Required for multi-page reads (§4.8). Unique/primary-key column recommended. |

`max_rows` unset ⇒ 25 (R6). Values are clamped, not rejected, so a typo degrades
rather than breaks — **except** `column_map`, which fails closed (§5.4).

### 5.4 [R2] Per-table column selection, failing closed

Resolution order, first match wins:

1. `column_map[table]`
2. `select_columns` (existing flat list; applies to every table)
3. the model's `select`
4. `*`

**Fail-closed rules, new in revision 2.** Revision 1 let a malformed or empty
map fall through to `*`, so deleting the last column from a table's list would
have silently exposed every column:

- `column_map` present but not parseable ⇒ the call is refused with
  `supabase_column_map_invalid`. It is never ignored.
- `column_map` names the requested table with an **empty** list ⇒ refused with
  `supabase_columns_empty`. An empty restriction is a restriction.
- `column_map` parses but does not name the requested table ⇒ fall through to
  rule 2. Not naming a table is different from naming it with nothing.

Clearing a restriction is an explicit act: the operator removes the table's key
from the map, or clears the whole field. **[R2]** Because blank values are
dropped before save (`DatabaseConnectorsManager.tsx:1269-1274`,
`toolWrites.ts:171-174`), clearing a field today does not clear the stored
setting. The UI therefore sends the sentinel `"{}"` for a cleared map and `"0"`
for a cleared `max_rows`, both of which resolve to the default.

### 5.5 Filters restricted to the resolved column list

`filters` keys are validated against the resolved columns and refused with
`supabase_filter_refused` otherwise. Today only identifier *shape* is checked
(`supabase.ts:179-190`), so a model can filter on an excluded column — an
equality oracle. When the resolved list is `*` there is nothing to enforce.

### 5.6 [R2] Redaction, narrowed

Revision 1 rewrote `redactConnectorOutput` for all adapters and dropped
`credentialRepresentations()`. Rejected. Revision 2:

- `credentialRepresentations()` and credential-value replacement are **kept, on
  every outcome**, unchanged — nested values, URL-encoded forms, WooCommerce
  Basic included.
- The generic key-name and hex-string pass is skipped for **one** payload only:
  the `data.rows` of a **successful Supabase** read. Every other adapter, every
  error, every log and every test-connection result is untouched.
- Credential replacement runs **before** cell truncation, so a long credential
  cannot be cut into an unmatchable prefix that then survives.

What newly reaches the model: the contents of columns the operator explicitly
selected, in a table the operator explicitly allow-listed, on a connector whose
credential the operator supplied. What still cannot: this connector's own
credentials, in any form.

### 5.7 Truncation becomes explicit and row-aligned

The adapter owns a **character** budget — **[R2]** `String.length` counts UTF-16
code units, not bytes, so the constant is named `SUPABASE_CHAR_BUDGET` and set
to 60 000 — enforced by accumulating each row's own serialized length rather
than re-serializing the whole array per row (**[R2]**, revision 1 was O(n²)).

`connectorExecution.ts` stops blind-slicing; it appends an explicit marker when
its backstop cap trips, so the model is never handed invalid JSON silently.

`truncated_by` ∈ `null | "max_rows" | "char_budget" | "time_budget" |
"upstream_error" | "no_progress" | "unordered"`.

### 5.8 New model-facing parameters

`offset` (continue from a prior `next_offset`) and `mode` (`"rows"` default, or
`"count"`). **[R2]** `count` mode issues one **HEAD** request with
`Prefer: count=exact` — no rows are read at all. HEAD is issued inside the
adapter and does not relax the dispatcher's public GET-only gate.

### 5.9 UI

`SupabaseSchemaPicker` gains per-table column checkboxes writing `column_map`;
`DatabaseConnectorsManager` renders `max_rows`, `page_size` and `order_by`
automatically from the registry. **[R2]** The picker's new prop must be wired at
the parent call site (`DatabaseConnectorsManager.tsx:2158-2164`), which revision
1 omitted.

## 6. Data flow

```
model → { capability, parameters: { table, select, filters, offset, mode } }
      → connectorExecution.ts   min(12s, remaining model budget)
      → ai-agent-adapters handler → dispatcher (read-only + capability gates)
      → supabase.ts  buildUrl + PAGE LOOP  (8s budget, hop = min(remaining, 5s))
      → PostgREST  N× GET (+ count=exact on the first) | 1× HEAD for count mode
      ← { rows, row_count, total, has_more, next_offset, truncated_by }
      → dispatcher redaction → one tool message
```

## 7. Migrations

**None required**, confirmed by review. `settings` is JSONB
(`20260831130000_connector_scope_and_sharing.sql:105`); `toolWrites.ts:189-195`
routes non-secret registry fields into it and `:384-385` merges them. No new
connector type, capability, permission default, constraint or RLS policy.

**[R2] Deployment dependency:** `messaging-api` must be redeployed with the
updated registry, not just `ai-agent-adapters`. Its copy validates incoming
credential keys and rejects unknown ones (`toolWrites.ts:182-186`), so an
un-updated `messaging-api` would refuse to save the new fields.

## 8. Testing

Tests use the existing conventions in `adapters.test.ts`: `executeConnector`
(not the adapter directly, so redaction is exercised), the `dependencies(fetchImpl,
…)` seam, `supabaseTool()`, `request()`, `jsonResponse()`, and the failure shape
`result.error.code`. **[R2]** Revision 1 invented a `safeVendorFetch` seam that
does not exist and asserted `result.code`; both are corrected.

| Area | Must be proven |
|---|---|
| Paging | >25 rows across pages; a **short non-empty** page continues; exhaustion from `Content-Range`; `has_more`/`next_offset` correct; exact-multiple boundary does not claim a phantom extra page. |
| Ordering | Multi-page without `order_by` returns one page with `truncated_by: "unordered"`. |
| Stops | `max_rows`, `char_budget` on a whole-row boundary, `time_budget`, `upstream_error` mid-loop keeps page one, `no_progress`. |
| Counting | `mode: "count"` issues exactly one **HEAD** and returns a total with no rows. |
| Regression | Unconfigured connector still emits `limit=25` in one request; `test_connection` still reads one row. |
| Columns | `column_map` beats the flat list; unparseable map is **refused**; empty list for the requested table is **refused**; filters outside the resolved list refused. |
| Redaction | Through `executeConnector`: a column named `token` survives; the connector's own anon key never appears; a WooCommerce result is unchanged. |
| Registry | The vitest deep-`toEqual` mirror test passes with the new fields. |
| UI | Picker writes `column_map` for two different tables; parent passes the prop. |

Gates: `deno check --node-modules-dir=none` on changed edge modules, `deno test`
across `supabase/functions/`, then `bun install`, `bun run test`, `bunx tsc --noEmit`.
Deno before bun — the Deno gate destroys `node_modules`.

Guards: `clean-code-guard` on production code, `test-guard` on tests.

## 9. Deployment

The PR touches the frontend (auto-deploys on merge) and two edge functions.
Order: deploy `ai-agent-adapters`, `ai-agent-reply` and `messaging-api` from the branch via
`ssh-contabo-mcp`, verify against a live connector, then merge.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Larger payloads blow the model's context | Character budget is authoritative and reported; `max_rows` defaults to 25. |
| A late tool call overruns the worker | Caller budget is clamped to the request's remaining time (§5.2). |
| §5.6 loosens a control | Narrowed to one payload of one adapter; credential redaction fully retained; isolated in its own commit for independent revert. |
| Offset paging corrupts a result set | Refuses to page without `order_by` (§4.8). |
| Registry mirror drift | The existing deep-equality vitest test. |
