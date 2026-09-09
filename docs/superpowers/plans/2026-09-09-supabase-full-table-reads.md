# Supabase Full-Table Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an AI agent read every credential-visible row of a customer's chosen Supabase table — configurable ceiling, internal pagination, accurate totals, per-table column scoping — instead of a hardcoded 25 rows.

**Architecture:** The adapter gains an internal page loop issuing N PostgREST requests inside one tool call, bounded by a row ceiling, a character budget and a time budget, returning an envelope that states exactly why it stopped. Pagination is adapter-side because the agent loop allows 5 iterations and the model budget is elapsed, not per-call. Counting is a request parameter, not a capability, so WooCommerce is untouched.

**Tech Stack:** Deno edge functions (`supabase/functions/**`, `deno test`), React 18 + TypeScript + vitest (`src/**`), PostgREST, Supabase JSONB settings.

**Spec:** `docs/superpowers/specs/2026-09-09-supabase-full-table-reads-design.md` (revision 2)

**Revision 2 of this plan** rewrites every test against the seams that actually exist. Revision 1 invented a `safeVendorFetch` dependency and asserted `result.code`; neither exists.

## Global Constraints

- **Read ARCHITECTURE.md before touching `src/**` or `supabase/functions/**`.**
- **Test conventions, verified at `adapters.test.ts:1-88`.** Use these exactly:
  - Drive through `executeConnector(invocation, dependencies)` from `./dispatcher.ts`, **never** the adapter object directly — redaction lives at `dispatcher.ts:131` and is bypassed otherwise.
  - The HTTP seam is `dependencies(fetchImpl, checkedUrls?, logged?)`, which sets `fetch`. There is **no** `safeVendorFetch` in `AdapterDependencies` (`types.ts:43-48`).
  - Fixtures: `supabaseTool(overrides)`, `request(overrides)`, `jsonResponse(body, status?, headers?)`, `makeJwt({ role: "anon" })`.
  - Failure shape is `result.error.code`, **not** `result.code` (`types.ts:51-58`).
  - `request()` must carry a `capability`; `{}` is refused before any fetch.
- **The registry is mirrored in two files that must stay structurally identical:** `supabase/functions/_shared/connectorRegistry.ts` and `src/lib/connectorRegistry.ts`. A vitest deep-`toEqual` at `src/lib/__tests__/connectorRegistry.test.ts:148-152` compares every field including `help` strings.
- **`ConnectorParameterSchema` admits only `type: "string" | "object"`** (`connectorRegistry.ts:44-53`).
- **Do not add to `CONNECTOR_CAPABILITY_NAMES`.**
- **Do not change `dependencies.ts`'s shared `timeoutMs`.** WooCommerce shares it (`woocommerce.ts:189, 225-247`). Supabase derives its per-hop timeout by shallow-copying dependencies locally.
- **No migration.** All new settings are non-secret registry fields and land in `ai_agent_tools.settings` (JSONB) automatically.
- **Do not touch** `validateSupabaseAnonKey` (`supabase.ts:51-73`) or the non-GET refusal (`dispatcher.ts:52-80`).
- **Defaults preserve today's behaviour:** `max_rows` unset ⇒ 25 rows and `limit=25` on the wire, in exactly one request.
- **Gate order is Deno first, then bun.** The Deno gate destroys `node_modules`.
- **Commit scoped files only.** Never `git add -A`.
- **Clamps:** `max_rows` 1..1000, `page_size` 1..1000, `offset` ≥ 0. Clamp, never reject — **except `column_map`, which fails closed** (Task 2).

---

### Task 1: Settings resolution helpers

Pure functions. No network. `ROW_LIMIT` stays in place — it is still referenced at `supabase.ts:177` and is not removed until Task 5.

**Files:**
- Modify: `supabase/functions/ai-agent-adapters/supabase.ts` (add beside `tableAllowList` at `:112-122`)
- Test: `supabase/functions/ai-agent-adapters/adapters.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const DEFAULT_MAX_ROWS = 25;` `export const MAX_ROWS_CEILING = 1000;` `export const DEFAULT_PAGE_SIZE = 200;`
  - `export function resolveMaxRows(settings: Record<string, unknown>): number`
  - `export function resolvePageSize(settings: Record<string, unknown>): number`
  - `export function resolveOffset(parameters: Record<string, unknown>): number`
  - `export function resolveOrderBy(settings: Record<string, unknown>): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `supabase/functions/ai-agent-adapters/adapters.test.ts`:

```ts
import {
  resolveMaxRows,
  resolvePageSize,
  resolveOffset,
  resolveOrderBy,
  DEFAULT_MAX_ROWS,
} from "./supabase.ts";

Deno.test("max_rows defaults to the 25 this connector shipped with", () => {
  assertEquals(resolveMaxRows({}), DEFAULT_MAX_ROWS);
  assertEquals(resolveMaxRows({ max_rows: "" }), DEFAULT_MAX_ROWS);
});

Deno.test("max_rows clamps instead of rejecting, so a typo degrades", () => {
  assertEquals(resolveMaxRows({ max_rows: "500" }), 500);
  assertEquals(resolveMaxRows({ max_rows: "99999" }), 1000);
  assertEquals(resolveMaxRows({ max_rows: "-4" }), 1);
  assertEquals(resolveMaxRows({ max_rows: "abc" }), DEFAULT_MAX_ROWS);
  assertEquals(resolveMaxRows({ max_rows: "12.9" }), 12);
  // "0" is the UI's cleared-field sentinel and must mean "default", not 1.
  assertEquals(resolveMaxRows({ max_rows: "0" }), DEFAULT_MAX_ROWS);
});

Deno.test("page_size defaults to 200 and is capped at 1000", () => {
  assertEquals(resolvePageSize({}), 200);
  assertEquals(resolvePageSize({ page_size: "50" }), 50);
  assertEquals(resolvePageSize({ page_size: "5000" }), 1000);
});

Deno.test("offset comes from the model and floors at zero", () => {
  assertEquals(resolveOffset({}), 0);
  assertEquals(resolveOffset({ offset: "40" }), 40);
  assertEquals(resolveOffset({ offset: "-1" }), 0);
  assertEquals(resolveOffset({ offset: "nonsense" }), 0);
});

Deno.test("order_by is null unless a single valid identifier is configured", () => {
  assertEquals(resolveOrderBy({}), null);
  assertEquals(resolveOrderBy({ order_by: "  " }), null);
  assertEquals(resolveOrderBy({ order_by: "id" }), "id");
  assertEquals(resolveOrderBy({ order_by: " created_at " }), "created_at");
  // Anything that is not a bare identifier is dropped rather than injected
  // into the query string.
  assertEquals(resolveOrderBy({ order_by: "id desc, name" }), null);
  assertEquals(resolveOrderBy({ order_by: "id;drop" }), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd F:/Postora-supabase-fulltable
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: FAIL — `resolveMaxRows` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `supabase/functions/ai-agent-adapters/supabase.ts`, leaving `ROW_LIMIT` where it is:

```ts
export const DEFAULT_MAX_ROWS = 25;
export const MAX_ROWS_CEILING = 1000;
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Clamps rather than rejects: an operator typo must degrade a read, never break
 * the connector mid-conversation. Zero and blank mean "unset" because the card
 * drops empty fields before saving, so clearing one has to round-trip to the
 * default rather than to the minimum.
 */
function clampInteger(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const text = String(raw).trim();
  if (!text) return fallback;
  const parsed = Math.trunc(Number(text));
  if (!Number.isFinite(parsed) || parsed === 0) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

export function resolveMaxRows(settings: Record<string, unknown>): number {
  return clampInteger(settings.max_rows, DEFAULT_MAX_ROWS, 1, MAX_ROWS_CEILING);
}

export function resolvePageSize(settings: Record<string, unknown>): number {
  return clampInteger(settings.page_size, DEFAULT_PAGE_SIZE, 1, MAX_ROWS_CEILING);
}

export function resolveOffset(parameters: Record<string, unknown>): number {
  const raw = parameters.offset;
  if (typeof raw !== "string" && typeof raw !== "number") return 0;
  const parsed = Math.trunc(Number(String(raw).trim()));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Offset paging without a deterministic ORDER BY can duplicate and skip rows,
 * because Postgres does not promise row order between queries. Only a bare
 * identifier is accepted; anything else would be pasted into the query string.
 */
export function resolveOrderBy(settings: Record<string, unknown>): string | null {
  const raw = settings.order_by;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return null;
  return trimmed;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
deno check --node-modules-dir=none supabase/functions/ai-agent-adapters/supabase.ts
```

Expected: PASS, with every pre-existing test still green — nothing on the wire changed.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-adapters/adapters.test.ts
git commit -m "feat(connectors): resolve Supabase row ceilings and ordering from settings"
```

---

### Task 2: Per-table column map, failing closed

**Files:**
- Modify: `supabase/functions/ai-agent-adapters/supabase.ts`
- Test: `supabase/functions/ai-agent-adapters/adapters.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `export function resolveColumns(settings, table, modelSelect): string` — **throws `SupabaseValidationError`** on an invalid or empty-for-this-table map. New codes: `supabase_column_map_invalid`, `supabase_columns_empty`.

- [ ] **Step 1: Write the failing tests**

```ts
import { resolveColumns } from "./supabase.ts";
import { SupabaseValidationError } from "./supabase.ts";
import { assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";

Deno.test("column_map wins over the flat select_columns list", () => {
  const settings = {
    column_map: '{"products":["id","price"],"orders":["id","total"]}',
    select_columns: "name",
  };
  assertEquals(resolveColumns(settings, "products", null), "id,price");
  assertEquals(resolveColumns(settings, "orders", null), "id,total");
});

Deno.test("a table the map does not name falls back to the flat list", () => {
  const settings = { column_map: '{"products":["id"]}', select_columns: "name, price" };
  assertEquals(resolveColumns(settings, "invoices", null), "name,price");
});

Deno.test("with nothing configured the model's select is used, else star", () => {
  assertEquals(resolveColumns({}, "products", "id,name"), "id,name");
  assertEquals(resolveColumns({}, "products", null), "*");
});

Deno.test("an unparseable column_map is refused, never ignored", () => {
  // Falling through to "*" would silently widen access on a typo.
  const error = assertThrows(
    () => resolveColumns({ column_map: "{not json", select_columns: "price" }, "products", null),
    SupabaseValidationError,
  ) as SupabaseValidationError;
  assertEquals(error.code, "supabase_column_map_invalid");
});

Deno.test("a table mapped to an empty list is refused, not widened", () => {
  // Deleting the last column from a table's list is a restriction, not an
  // instruction to return every column.
  const error = assertThrows(
    () => resolveColumns({ column_map: '{"products":[]}' }, "products", null),
    SupabaseValidationError,
  ) as SupabaseValidationError;
  assertEquals(error.code, "supabase_columns_empty");
});

Deno.test("an empty map object means unrestricted, the cleared-field sentinel", () => {
  assertEquals(resolveColumns({ column_map: "{}" }, "products", null), "*");
  assertEquals(resolveColumns({ column_map: "{}", select_columns: "price" }, "products", null), "price");
});

Deno.test("column_map accepts a comma string per table as well as an array", () => {
  assertEquals(resolveColumns({ column_map: '{"products":"id, price"}' }, "products", null), "id,price");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: FAIL — `resolveColumns` is not exported.

- [ ] **Step 3: Write the implementation**

```ts
function splitColumns(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string")
      .map((v) => v.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\n]/).map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Per-table columns beat the flat list, which beats the model, which beats star.
 *
 * The flat select_columns is one string applied to whichever table the model
 * picked, so allowing two tables with different columns made the second fail
 * with PostgREST 42703. column_map fixes that.
 *
 * It fails CLOSED. A map that will not parse, or that names this table with an
 * empty list, refuses the call instead of falling through to star — otherwise a
 * typo, or deleting the last column from a table, silently returns every column.
 */
export function resolveColumns(
  settings: Record<string, unknown>,
  table: string,
  modelSelect: string | null,
): string {
  const raw = settings.column_map;
  if (typeof raw === "string" && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SupabaseValidationError(
        "supabase_column_map_invalid",
        "This connector's per-table column list is not valid JSON.",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SupabaseValidationError(
        "supabase_column_map_invalid",
        "This connector's per-table column list is not valid JSON.",
      );
    }
    const entry = (parsed as Record<string, unknown>)[table];
    if (entry !== undefined) {
      const columns = splitColumns(entry);
      if (columns.length === 0) {
        throw new SupabaseValidationError(
          "supabase_columns_empty",
          `No columns are allowed on "${table}" for this connector.`,
        );
      }
      return columns.join(",");
    }
  }
  const flat = splitColumns(settings.select_columns);
  if (flat.length) return flat.join(",");
  const fromModel = splitColumns(modelSelect);
  if (fromModel.length) return fromModel.join(",");
  return "*";
}
```

Ensure `SupabaseValidationError` is exported and carries a public `code`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-adapters/adapters.test.ts
git commit -m "feat(connectors): per-table Supabase column lists that fail closed"
```

---

### Task 3: Filters restricted to the resolved columns

**Files:**
- Modify: `supabase/functions/ai-agent-adapters/supabase.ts:179-190`
- Test: `supabase/functions/ai-agent-adapters/adapters.test.ts`

**Interfaces:**
- Consumes: `resolveColumns` (Task 2).
- Produces: failure code `supabase_filter_refused`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("a filter on a column outside the configured list is refused", async () => {
  let fetched = false;
  const result = await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          select_columns: "id, name, price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { email: "a@b.c" } } }),
    },
    dependencies(() => {
      fetched = true;
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_filter_refused");
  assertEquals(fetched, false, "must refuse before any vendor request");
});

Deno.test("a filter on a configured column is still allowed", async () => {
  let requested = "";
  const result = await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          select_columns: "id, name, price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { name: "widget" } } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertEquals(result.ok, true);
  assertStringIncludes(requested, "name=eq.widget");
});

Deno.test("with no column list configured any shape-valid filter still works", async () => {
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { sku: "A1" } } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "sku=eq.A1");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: FAIL — the first test gets `ok: true` and `fetched === true`.

- [ ] **Step 3: Write the implementation**

Replace the filter loop at `supabase.ts:179-190`:

```ts
  const filters = parameters.filters;
  if (filters !== null && typeof filters === "object" && !Array.isArray(filters)) {
    // `select` restricts what comes back; without this the model could still
    // filter on an excluded column and read it one equality test at a time.
    // `*` means nothing was configured, so there is nothing to enforce.
    const allowedColumns = select === "*"
      ? null
      : new Set(select.split(",").map((column) => column.trim()));
    for (const [column, value] of Object.entries(filters)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
        throw new SupabaseValidationError("supabase_filter_invalid", "A Supabase filter is invalid.");
      }
      if (allowedColumns && !allowedColumns.has(column)) {
        throw new SupabaseValidationError(
          "supabase_filter_refused",
          `Filtering on "${column}" is not allowed for this connector.`,
        );
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new SupabaseValidationError("supabase_filter_invalid", "A Supabase filter is invalid.");
      }
      url.searchParams.set(column, `eq.${String(value)}`);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-adapters/adapters.test.ts
git commit -m "fix(connectors): refuse Supabase filters on columns outside the configured list"
```

---

### Task 4: Budget plumbing

Separated from the loop so the deadline arithmetic can be reviewed on its own. No behaviour change yet.

**Files:**
- Modify: `supabase/functions/ai-agent-reply/connectorExecution.ts:22` and the `executeRoutedCustomTool` signature
- Modify: `supabase/functions/ai-agent-reply/index.ts` (the tool-call site around `:1148-1161`)
- Modify: `supabase/functions/ai-agent-adapters/supabase.ts` (constants only)
- Test: `supabase/functions/ai-agent-reply/connectorRouting.test.ts`

**Interfaces:**
- Consumes: `modelBudgetRemaining` (`ai-agent-reply/logic.ts:457`).
- Produces:
  - `export const ADAPTER_CALL_TIMEOUT_MS = 12_000;`
  - `export function adapterCallBudget(remainingMs: number): number`
  - `export const SUPABASE_LOOP_BUDGET_MS = 8_000;` and `export const SUPABASE_MIN_HOP_MS = 1_500;` from `supabase.ts`
- **`dependencies.ts` is not modified.**

- [ ] **Step 1: Write the failing tests**

```ts
import {
  ADAPTER_CALL_TIMEOUT_MS,
  adapterCallBudget,
} from "./connectorExecution.ts";
import {
  SUPABASE_LOOP_BUDGET_MS,
  SUPABASE_MIN_HOP_MS,
} from "../ai-agent-adapters/supabase.ts";

Deno.test("the caller's ceiling leaves room for the adapter's own loop", () => {
  // An inverted budget aborts the callee mid-loop and throws away rows already
  // fetched, surfacing as "request timed out" with no partial result.
  assertEquals(ADAPTER_CALL_TIMEOUT_MS > SUPABASE_LOOP_BUDGET_MS + SUPABASE_MIN_HOP_MS, true);
});

Deno.test("the call budget never exceeds the request's remaining time", () => {
  // The model budget is elapsed, not a fresh per-call allowance, so a tool call
  // late in a conversation must shrink rather than overrun the worker.
  assertEquals(adapterCallBudget(40_000), ADAPTER_CALL_TIMEOUT_MS);
  assertEquals(adapterCallBudget(7_000), 7_000);
  assertEquals(adapterCallBudget(0), 0);
  assertEquals(adapterCallBudget(-5_000), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-reply/connectorRouting.test.ts
```

Expected: FAIL — `adapterCallBudget` is not exported.

- [ ] **Step 3: Write the implementation**

In `connectorExecution.ts`:

```ts
// 12s, not 6s. The Supabase adapter now issues several PostgREST requests
// inside one call, and a caller ceiling below the callee's own deadline aborts
// the loop mid-flight and discards rows already fetched.
export const ADAPTER_CALL_TIMEOUT_MS = 12_000;

/**
 * The agent's model budget is ELAPSED time (logic.ts:457 subtracts
 * now - startedAt), not a fresh allowance per call. A tool call late in a
 * conversation therefore has to shrink to what is left rather than assume the
 * full ceiling, or it overruns the worker and the customer gets nothing.
 */
export function adapterCallBudget(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.min(ADAPTER_CALL_TIMEOUT_MS, Math.trunc(remainingMs));
}
```

Thread an optional `remainingBudgetMs` through `executeRoutedCustomTool` into the
existing `dependencies.timeoutMs ?? ADAPTER_CALL_TIMEOUT_MS` expression at
`connectorExecution.ts:200-203`, defaulting to `ADAPTER_CALL_TIMEOUT_MS` when the
caller passes nothing so existing call sites keep working. At the `index.ts`
tool-call site, pass `modelBudgetRemaining(startedAt, Date.now())`.

In `supabase.ts`, beside the row constants:

```ts
// Wall-clock ceiling for the whole page loop, inside the caller's 12s budget.
export const SUPABASE_LOOP_BUDGET_MS = 8_000;
// A hop is never started without at least this much budget left, so the loop
// cannot overrun its caller by starting a request it has no time to finish.
export const SUPABASE_MIN_HOP_MS = 1_500;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/
deno check --node-modules-dir=none supabase/functions/ai-agent-reply/connectorExecution.ts
```

Expected: PASS, WooCommerce tests unchanged — `dependencies.ts` was not touched.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-reply/connectorExecution.ts supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-reply/connectorRouting.test.ts
git commit -m "fix(connectors): clamp the adapter call budget to the request's remaining time"
```

---

### Task 5: The page loop and the result envelope

**Files:**
- Modify: `supabase/functions/ai-agent-adapters/supabase.ts` (`buildUrl` `:152-192`, `callSupabase` `:194-250`; `ROW_LIMIT` is removed here, not earlier)
- Test: `supabase/functions/ai-agent-adapters/adapters.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:

```ts
export const SUPABASE_CHAR_BUDGET = 60_000; // UTF-16 code units, not bytes

export interface SupabaseReadEnvelope {
  rows: unknown[];
  row_count: number;
  total: number | null;
  has_more: boolean;
  next_offset: number | null;
  truncated_by:
    | null | "max_rows" | "char_budget" | "time_budget"
    | "upstream_error" | "no_progress" | "unordered";
}
```

- [ ] **Step 1: Write the failing tests**

Add a paging fetch stub next to the existing helpers:

```ts
/** Serves successive pages and records the URL and headers of each request. */
function pagingFetch(
  pages: unknown[][],
  opts: { total?: number; failAfter?: number } = {},
): { impl: typeof fetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let call = 0;
  const impl = ((url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
    headers.push(h);
    const index = call++;
    if (opts.failAfter !== undefined && index >= opts.failAfter) {
      return Promise.resolve(new Response("upstream exploded", { status: 500 }));
    }
    const body = pages[index] ?? [];
    const extra: Record<string, string> = {};
    if (opts.total !== undefined) {
      const start = pages.slice(0, index).reduce((n, p) => n + p.length, 0);
      extra["Content-Range"] = `${start}-${start + body.length - 1}/${opts.total}`;
    }
    return Promise.resolve(jsonResponse(body, 200, extra));
  }) as unknown as typeof fetch;
  return { impl, urls, headers };
}

function pagedTool(settings: Record<string, unknown> = {}) {
  return supabaseTool({
    settings: {
      project_url: "https://project.example.com",
      schema: "public",
      table_allow_list: ["products"],
      order_by: "id",
      ...settings,
    },
  });
}

function rows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: from + i, name: `row-${from + i}` }));
}

function envelopeOf(result: ConnectorResult) {
  return (result as { data: SupabaseReadEnvelope }).data;
}
```

Then the behaviour tests:

```ts
Deno.test("the loop pages past 25 rows and reports an accurate count", async () => {
  const f = pagingFetch([rows(0, 200), rows(200, 60)], { total: 260 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, true);
  const data = envelopeOf(result);
  assertEquals(data.row_count, 260);
  assertEquals(data.total, 260);
  assertEquals(data.has_more, false);
  assertEquals(data.truncated_by, null);
  assertEquals(f.urls.length, 2);
  assertStringIncludes(f.urls[0], "offset=0");
  assertStringIncludes(f.urls[1], "offset=200");
  assertStringIncludes(f.urls[0], "order=id");
});

Deno.test("a short page is the server's row cap, not the end of the table", async () => {
  // PostgREST's db-max-rows can cap a response. Treating a short page as
  // exhaustion returned 100 of 900 rows claiming has_more: false.
  const f = pagingFetch([rows(0, 100), rows(100, 100), rows(200, 100)], { total: 300 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  const data = envelopeOf(result);
  assertEquals(data.row_count, 300);
  assertEquals(data.has_more, false);
  assertEquals(f.urls.length, 3);
  assertStringIncludes(f.urls[1], "offset=100");
});

Deno.test("an empty page ends the loop even when no total was returned", async () => {
  const f = pagingFetch([rows(0, 200), []]);
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.row_count, 200);
  assertEquals(data.total, null);
  assertEquals(data.has_more, false);
});

Deno.test("only the first request pays for an exact count", async () => {
  const f = pagingFetch([rows(0, 200), rows(200, 10)], { total: 210 });
  await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(f.headers[0]["prefer"], "count=exact");
  assertEquals(f.headers[1]["prefer"], undefined);
});

Deno.test("stopping on max_rows reports has_more and where to resume", async () => {
  const f = pagingFetch([rows(0, 50)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.row_count, 50);
  assertEquals(data.total, 900);
  assertEquals(data.has_more, true);
  assertEquals(data.next_offset, 50);
  assertEquals(data.truncated_by, "max_rows");
});

Deno.test("an exact multiple of max_rows does not invent a phantom next page", async () => {
  const f = pagingFetch([rows(0, 50)], { total: 50 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.has_more, false);
  assertEquals(data.next_offset, null);
  assertEquals(data.truncated_by, null);
});

Deno.test("the model's offset resumes where the previous call stopped", async () => {
  const f = pagingFetch([rows(50, 1)], { total: 900 });
  await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", offset: "50" } }),
    },
    dependencies(f.impl),
  );
  assertStringIncludes(f.urls[0], "offset=50");
});

Deno.test("without order_by the loop refuses to page and says why", async () => {
  // Offset paging with no deterministic ORDER BY duplicates and skips rows.
  const f = pagingFetch([rows(0, 200), rows(200, 200)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          max_rows: "500",
          page_size: "200",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(f.urls.length, 1);
  assertEquals(data.row_count, 200);
  assertEquals(data.truncated_by, "unordered");
  assertEquals(data.has_more, true);
});

Deno.test("the character budget stops on a whole row and says so", async () => {
  const fat = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(400) }));
  const f = pagingFetch([fat, fat, fat, fat], { total: 5000 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "1000", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.truncated_by, "char_budget");
  assertEquals(data.has_more, true);
  assertEquals(data.next_offset, data.row_count);
  // The old failure was a String.slice through the middle of an object.
  for (const row of data.rows) {
    assertEquals(typeof (row as { id: number }).id, "number");
    assertEquals(typeof (row as { blob: string }).blob, "string");
  }
  assertEquals(JSON.stringify(data.rows).length <= SUPABASE_CHAR_BUDGET, true);
});

Deno.test("an upstream failure mid-loop keeps the rows already fetched", async () => {
  const f = pagingFetch([rows(0, 200)], { total: 900, failAfter: 1 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, true);
  const data = envelopeOf(result);
  assertEquals(data.row_count, 200);
  assertEquals(data.truncated_by, "upstream_error");
  assertEquals(data.has_more, true);
});

Deno.test("an upstream failure on the first page is still a hard failure", async () => {
  const f = pagingFetch([], { failAfter: 0 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_http_error");
});

Deno.test("a first row larger than the whole budget stops instead of looping", async () => {
  // Otherwise the cursor never advances and next_offset repeats forever.
  const huge = [{ id: 1, blob: "x".repeat(SUPABASE_CHAR_BUDGET * 2) }];
  const f = pagingFetch([huge, huge, huge], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "1" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.truncated_by, "no_progress");
  assertEquals(data.row_count, 0);
});

Deno.test("count mode issues exactly one HEAD request and reads no rows", async () => {
  const methods: string[] = [];
  const f = ((url: string | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Promise.resolve(new Response(null, {
      status: 200,
      headers: { "Content-Range": "*/4213" },
    }));
  }) as unknown as typeof fetch;
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", mode: "count" } }),
    },
    dependencies(f),
  ));
  assertEquals(methods, ["HEAD"]);
  assertEquals(data.total, 4213);
  assertEquals(data.row_count, 0);
  assertEquals(data.rows.length, 0);
});

Deno.test("an unconfigured connector still emits limit=25 in one request", async () => {
  const f = pagingFetch([rows(0, 25)], { total: 25 });
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(f.urls.length, 1);
  assertStringIncludes(f.urls[0], "limit=25");
});
```

Rewrite the two pre-existing assertions that the envelope invalidates:
`adapters.test.ts:580-596` (`limit=25`) becomes the "unconfigured" test above, and
`:598-625` plus the bare-array assertion at `:640-642` read `data.rows` instead of
treating `data` as an array. Keep their intent — the oversized-cell test still
proves `trimValue` survives.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: FAIL — the adapter returns a bare array, so `data.row_count` is `undefined`.

- [ ] **Step 3: Write the implementation**

Split `buildUrl` so it returns the base URL without `limit`/`offset`, then add:

```ts
/** PostgREST answers `0-24/4213`, or `*​/4213` for a count-only probe. */
function parseTotal(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const total = contentRange.split("/")[1];
  if (!total || total === "*") return null;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readPages(
  base: URL,
  headers: Record<string, string>,
  dependencies: AdapterDependencies,
  limits: { maxRows: number; pageSize: number; startOffset: number; orderBy: string | null },
): Promise<SupabaseReadEnvelope> {
  const deadline = Date.now() + SUPABASE_LOOP_BUDGET_MS;
  const collected: unknown[] = [];
  let chars = 2; // the enclosing [] of the serialized array
  let total: number | null = null;
  let cursor = limits.startOffset;
  let stop: SupabaseReadEnvelope["truncated_by"] = null;
  let exhausted = false;

  while (collected.length < limits.maxRows) {
    const remaining = deadline - Date.now();
    if (remaining < SUPABASE_MIN_HOP_MS) { stop = "time_budget"; break; }

    const pageLimit = Math.min(limits.pageSize, limits.maxRows - collected.length);
    const url = new URL(base.toString());
    if (limits.orderBy) url.searchParams.set("order", limits.orderBy);
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(cursor));

    const pageHeaders = { ...headers };
    // Only the first request pays for the count; PostgREST recomputes per call.
    if (collected.length === 0) pageHeaders.Prefer = "count=exact";

    // A hop can never outlive the loop, so the loop cannot overrun its caller.
    const hopDependencies = {
      ...dependencies,
      timeoutMs: Math.min(dependencies.timeoutMs, remaining),
    };

    const response = await safeFetch(url, { method: "GET", headers: pageHeaders }, hopDependencies);
    if (!response.ok) {
      // Rows already fetched are worth more than a whole-request failure.
      if (collected.length === 0) throw new SupabaseHttpError(response.status);
      stop = "upstream_error";
      break;
    }
    if (total === null) total = parseTotal(response.headers.get("content-range"));

    const payload = await readJson(response);
    if (!Array.isArray(payload)) {
      if (collected.length === 0) {
        throw new SupabaseValidationError("supabase_response_invalid", "Supabase returned an invalid response.");
      }
      stop = "upstream_error";
      break;
    }

    // Accumulate each row's own length instead of re-serializing the whole
    // array per row, which was quadratic. `length` counts UTF-16 code units.
    let budgetHit = false;
    let acceptedFromPage = 0;
    for (const row of payload) {
      const trimmed = (trimRows([row]) as unknown[])[0];
      const cost = JSON.stringify(trimmed).length + (collected.length ? 1 : 0);
      if (chars + cost > SUPABASE_CHAR_BUDGET) { budgetHit = true; break; }
      collected.push(trimmed);
      chars += cost;
      acceptedFromPage += 1;
    }
    cursor += acceptedFromPage;

    if (budgetHit) {
      // Not one row fitted and nothing has ever fitted: stop rather than ask
      // for the same offset forever.
      stop = collected.length === 0 ? "no_progress" : "char_budget";
      break;
    }
    if (payload.length === 0) { exhausted = true; break; }
    if (total !== null && cursor >= total) { exhausted = true; break; }
    // A SHORT page is PostgREST's own row cap, not the end of the table.
  }

  if (!stop && !exhausted && collected.length >= limits.maxRows) {
    const known = total !== null && cursor >= total;
    if (known) exhausted = true; else stop = "max_rows";
  }

  const hasMore = !exhausted && stop !== null;
  return {
    rows: collected,
    row_count: collected.length,
    total,
    has_more: hasMore,
    next_offset: hasMore ? cursor : null,
    truncated_by: stop,
  };
}
```

In `callSupabase`, before the loop: if `maxRows > pageSize` (more than one page
possible) and `orderBy === null`, run a single page and return
`truncated_by: "unordered"` with `has_more: true`. Then handle `mode === "count"`
with one HEAD request. Finally delete `ROW_LIMIT`, whose only reference was
`:177`. `test_connection` keeps its own single `limit=1` path.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/
deno check --node-modules-dir=none supabase/functions/ai-agent-adapters/supabase.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-adapters/types.ts supabase/functions/ai-agent-adapters/adapters.test.ts
git commit -m "feat(connectors): page Supabase reads inside one call with an explicit stop reason"
```

---

### Task 6: Serialization stops blind-slicing

**Files:**
- Modify: `supabase/functions/ai-agent-reply/connectorExecution.ts:29` and `:146-158`
- Test: `supabase/functions/ai-agent-reply/connectorRouting.test.ts`

**Interfaces:**
- Consumes: `SupabaseReadEnvelope` (Task 5).
- Produces: `ADAPTER_OUTPUT_LIMIT` raised to `80_000`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("a paged envelope reaches the model whole, with its stop reason", async () => {
  const envelope = {
    rows: Array.from({ length: 260 }, (_, i) => ({ id: i, name: `row-${i}`, note: "y".repeat(60) })),
    row_count: 260, total: 900, has_more: true, next_offset: 260, truncated_by: "max_rows",
  };
  // Comfortably over the old 8000-char cap, so this fails on the old slice.
  assertEquals(JSON.stringify(envelope).length > 8_000, true);
  const result = await executeRoutedCustomTool(
    toolContext,
    supabaseCustomTool(),
    { capability: "search_products", parameters: { table: "products" } },
    stubAdapterReturning({ ok: true, vendor: "supabase", action: "execute", capability: "search_products", data: envelope }),
  );
  const parsed = JSON.parse(result.output.slice(result.output.indexOf("{")));
  assertEquals(parsed.row_count, 260);
  assertEquals(parsed.rows.length, 260);
  assertEquals(parsed.has_more, true);
  assertEquals(parsed.truncated_by, "max_rows");
});

Deno.test("an oversized payload is still capped, and the cap is announced", async () => {
  const envelope = {
    rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: "x".repeat(200) })),
    row_count: 5000, total: 5000, has_more: false, next_offset: null, truncated_by: null,
  };
  const result = await executeRoutedCustomTool(
    toolContext,
    supabaseCustomTool(),
    { capability: "search_products", parameters: { table: "products" } },
    stubAdapterReturning({ ok: true, vendor: "supabase", action: "execute", capability: "search_products", data: envelope }),
  );
  assertEquals(result.output.length <= ADAPTER_OUTPUT_LIMIT + 200, true);
  assertStringIncludes(result.output, "output truncated");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-reply/connectorRouting.test.ts
```

Expected: FAIL — `JSON.parse` throws on the mid-object cut.

- [ ] **Step 3: Write the implementation**

```ts
// 80k, not 8k. The Supabase adapter enforces its own 60k character budget on a
// row boundary and reports `truncated_by`, so this is a backstop for a
// misbehaving adapter rather than the thing that shapes a normal response.
export const ADAPTER_OUTPUT_LIMIT = 80_000;
```

and at `:146-158`:

```ts
  // A blind slice can cut mid-object and hand the model invalid JSON with no
  // signal that anything was dropped. Say it instead.
  const capped = serializedPayload.length > ADAPTER_OUTPUT_LIMIT
    ? `${serializedPayload.slice(0, ADAPTER_OUTPUT_LIMIT)} …[output truncated: ${serializedPayload.length} characters]`
    : serializedPayload;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-reply/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-reply/connectorExecution.ts supabase/functions/ai-agent-reply/connectorRouting.test.ts
git commit -m "fix(connectors): announce output truncation instead of cutting mid-JSON"
```

---

### Task 7: Redaction stops blanking customer columns

Narrow by design. `credentialRepresentations()` and credential-value replacement are **kept on every outcome**; only the generic key-name and hex pass is skipped, and only for a successful Supabase read's rows.

**Files:**
- Modify: `supabase/functions/ai-agent-adapters/redaction.ts`
- Test: `supabase/functions/ai-agent-adapters/adapters.test.ts`

**Interfaces:**
- Consumes: `SupabaseReadEnvelope` (Task 5).
- Produces: no new exports. `redactConnectorOutput` gains one narrow branch.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("a customer column named token survives a successful Supabase read", async () => {
  const f = pagingFetch([[{ id: 1, token: "ABC-123", api_key: "plain", key: "k1" }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { token: string }).token, "ABC-123");
  assertEquals((data.rows[0] as { api_key: string }).api_key, "plain");
  assertEquals((data.rows[0] as { key: string }).key, "k1");
});

Deno.test("a 64-character hex column is customer data, not a leaked secret", async () => {
  const digest = "a".repeat(64);
  const f = pagingFetch([[{ id: 1, sha256: digest }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { sha256: string }).sha256, digest);
});

Deno.test("the connector's own anon key is still stripped if a row echoes it", async () => {
  const f = pagingFetch([[{ id: 1, note: `key is ${SUPABASE_ANON_KEY}` }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { note: string }).note.includes(SUPABASE_ANON_KEY), false);
});

Deno.test("WooCommerce results keep the generic key-name redaction", async () => {
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(jsonResponse([{ id: 1, token: "should-be-hidden" }]))),
  );
  assertEquals(serialized(result).includes("should-be-hidden"), false);
});

Deno.test("a Supabase failure keeps the generic key-name redaction", async () => {
  const result = await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "not_allowed" } }),
    },
    dependencies(() => Promise.resolve(jsonResponse([]))),
  );
  assertEquals(result.ok, false);
  assertEquals(serialized(result).includes(SUPABASE_ANON_KEY), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/adapters.test.ts
```

Expected: FAIL — `token`, `api_key`, `key` and the hex digest come back `[REDACTED]`.

- [ ] **Step 3: Write the implementation**

In `redaction.ts`, keep every existing helper and add one branch:

```ts
/**
 * The generic key-name pass exists to stop OUR secrets leaking through a vendor
 * response. A customer's Supabase columns are the payload the connector exists
 * to deliver, and a column called `key`, `token` or `api_key` is ordinary
 * business data — blanking it made a full-table read useless.
 *
 * So exactly one payload skips that pass: the rows of a SUCCESSFUL Supabase
 * read, on a table the operator allow-listed, with columns the operator chose.
 * Credential-value replacement still runs on it, and every other adapter,
 * every error and every log keep the pass unchanged.
 */
export function redactConnectorOutput(
  outcome: ConnectorResult,
  credentials: Record<string, unknown>,
): ConnectorResult {
  if (
    outcome.ok && outcome.action === "execute" && outcome.vendor === "supabase" &&
    outcome.data && typeof outcome.data === "object" && "rows" in outcome.data
  ) {
    const { data, ...rest } = outcome;
    const envelope = data as Record<string, unknown>;
    return {
      ...(redactSensitive(rest) as Record<string, unknown>),
      data: {
        ...(redactSensitive({ ...envelope, rows: [] }) as Record<string, unknown>),
        rows: stripCredentialValues(envelope.rows, credentials),
      },
    } as ConnectorResult;
  }
  return <the existing implementation, unchanged>;
}
```

`stripCredentialValues` reuses the existing `credentialRepresentations(credentials)`
helper (`redaction.ts:5-38`) so nested and URL-encoded forms are still caught, and
runs **before** `trimValue` has a chance to cut a credential into an unmatchable
prefix — i.e. call it on the raw row inside `readPages` if `trimValue` would
otherwise run first, or reorder so redaction precedes truncation.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-adapters/
```

Expected: PASS, including the existing redaction tests at `adapters.test.ts:250` and `:272`.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ai-agent-adapters/redaction.ts supabase/functions/ai-agent-adapters/supabase.ts supabase/functions/ai-agent-adapters/adapters.test.ts
git commit -m "fix(connectors): redact Supabase rows by credential value, not by column name"
```

---

### Task 8: Registry — new settings and parameters, in both mirrors

**Files:**
- Modify: `supabase/functions/_shared/connectorRegistry.ts:118-136` and `:139-195`
- Modify: `src/lib/connectorRegistry.ts:103-121` and `:136-192` — **identical edits**
- Test: `supabase/functions/ai-agent-reply/connectorRouting.test.ts`, `src/lib/__tests__/connectorRegistry.test.ts`

**Interfaces:**
- Consumes: setting keys `max_rows`, `page_size`, `column_map`, `order_by`; parameters `offset`, `mode`.
- Produces: the contract the card's form renders from.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("the model is offered offset and mode on a supabase connector", () => {
  const [definition] = customToolDefinitions([supabaseConnectorTool({ table_allow_list: "products" })]);
  const properties = definition.function.parameters.properties.parameters.properties;
  assertEquals(properties.offset.type, "string");
  assertEquals(properties.mode.type, "string");
  assertStringIncludes(properties.mode.description, "count");
  assertStringIncludes(properties.offset.description, "next_offset");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-reply/connectorRouting.test.ts
```

Expected: FAIL — `properties.offset` is `undefined`.

- [ ] **Step 3: Write the implementation, in BOTH registry files**

Add to `SUPABASE_PARAMETERS.properties`:

```ts
    offset: {
      type: "string",
      description:
        "Row offset to start from. When a result says has_more, call again with offset set to its next_offset value to read the following page.",
    },
    mode: {
      type: "string",
      description:
        "Use \"count\" to return only how many rows match, without reading them. Defaults to \"rows\".",
    },
```

Add to the `supabase` entry's `credentials`, after `select_columns`:

```ts
      {
        key: "column_map",
        label: "Columns per table (optional)",
        kind: "text",
        required: false,
        help:
          "JSON mapping each table to the columns the agent may read, e.g. {\"products\":[\"id\",\"price\"]}. Overrides the single list above for the tables it names. A table mapped to an empty list is refused, not widened.",
      },
      {
        key: "order_by",
        label: "Order by column",
        kind: "text",
        required: false,
        help:
          "A single column, ideally the primary key. Required to read more than one page: without a stable order, paging can repeat or skip rows.",
      },
      {
        key: "max_rows",
        label: "Maximum rows per answer",
        kind: "text",
        required: false,
        help:
          "How many rows one lookup may return. Defaults to 25, up to 1000. Only rows this connector's key is allowed to see are returned.",
      },
      {
        key: "page_size",
        label: "Rows per request (optional)",
        kind: "text",
        required: false,
        help: "How many rows to fetch per database request while paging. Defaults to 200.",
      },
```

Copy all four blocks and both parameters verbatim into `src/lib/connectorRegistry.ts`.

- [ ] **Step 4: Run both suites**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/
bun run test -- src/lib/__tests__/connectorRegistry.test.ts
```

Expected: PASS. The deep-`toEqual` at `connectorRegistry.test.ts:148-152` is what catches a drifted mirror.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/connectorRegistry.ts src/lib/connectorRegistry.ts supabase/functions/ai-agent-reply/connectorRouting.test.ts
git commit -m "feat(connectors): expose row ceilings, per-table columns, ordering, offset and count mode"
```

---

### Task 9: Picker writes per-table columns, and the parent wires it

**Files:**
- Modify: `src/components/automation/SupabaseSchemaPicker.tsx`
- Modify: `src/components/automation/DatabaseConnectorsManager.tsx:2158-2164` (the picker's call site)
- Test: `src/components/automation/__tests__/SupabaseSchemaPicker.test.tsx`

**Interfaces:**
- Consumes: the `column_map` setting key (Task 8).
- Produces: `onPatch({ column_map })`; the parent passes `columnMap={form.credentials.column_map ?? ""}`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("builds a per-table map when columns are picked for two different tables", async () => {
  const onPatch = vi.fn();
  renderPicker({ tableAllowList: "products, orders", columnMap: "", onPatch });
  fireEvent.click(screen.getByRole("button", { name: /load/i }));
  await screen.findByLabelText("products.price");
  fireEvent.click(screen.getByLabelText("products.price"));
  fireEvent.click(screen.getByLabelText("orders.total"));
  expect(onPatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ column_map: '{"products":["price"],"orders":["total"]}' }),
  );
});

it("clearing the last column sends the empty-map sentinel, not a blank", () => {
  // A blank value is dropped before save, so the old restriction would persist.
  const onPatch = vi.fn();
  renderPicker({ tableAllowList: "products", columnMap: '{"products":["price"]}', onPatch });
  fireEvent.click(screen.getByRole("button", { name: /clear columns/i }));
  expect(onPatch).toHaveBeenLastCalledWith(expect.objectContaining({ column_map: "{}" }));
});
```

Use `fireEvent`, never `userEvent` — `userEvent` is unusable in this repo because of its clipboard dependency.

- [ ] **Step 2: Run to verify they fail**

```bash
bun run test -- src/components/automation/__tests__/SupabaseSchemaPicker.test.tsx
```

Expected: FAIL — the component has no `columnMap` prop.

- [ ] **Step 3: Write the implementation**

Add a `columnMap: string` prop, group the column checkboxes under their table with `"<table>.<column>"` labels, and emit the rebuilt JSON on every toggle. Add a "Clear columns" control emitting the `"{}"` sentinel. Keep `select_columns` emission when the map is empty, preserving the picker's documented contract at `SupabaseSchemaPicker.tsx:14-21`. Then pass `columnMap` at the parent call site.

- [ ] **Step 4: Run the suite**

```bash
bun run test -- src/components/automation/
```

Expected: PASS. The four new registry fields render automatically from `credentials`, so `DatabaseConnectorsManager` needs no other change.

- [ ] **Step 5: Commit**

```bash
git add src/components/automation/SupabaseSchemaPicker.tsx src/components/automation/DatabaseConnectorsManager.tsx src/components/automation/__tests__/SupabaseSchemaPicker.test.tsx
git commit -m "feat(connectors): pick columns per table in the Supabase card"
```

---

### Task 10: Usage guide, investigation record, and the full gate

**Files:**
- Modify: `supabase/functions/_shared/connectorRegistry.ts` and `src/lib/connectorRegistry.ts` (the supabase `usageGuide` only)
- Modify: `docs/investigations/2026-09-08-self-hosted-supabase-connector-card.md` (§A6 caps are now configurable; §4.1's Kong claim was wrong)
- Test: `supabase/functions/ai-agent-reply/toolGuides.test.ts`

**Interfaces:** consumes everything above; produces the final green gate.

**Note:** the card's RPC copy is deliberately *not* touched — spec §3 puts it out of scope.

- [ ] **Step 1: Write the failing test**

```ts
Deno.test("the usage guide tells the model how to continue a large read", () => {
  const guide = connectorUsageGuide("supabase");
  assertStringIncludes(guide, "next_offset");
  assertStringIncludes(guide, "count");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/ai-agent-reply/toolGuides.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Extend the supabase `usageGuide` in both registry files: when a result carries
`has_more: true`, call again with `offset` set to `next_offset`; to answer "how
many", pass `mode: "count"` rather than reading rows. Correct the investigation
record: the connector's caps are now configurable, and its claim that Kong
discards a client bearer token was wrong — `kong-entrypoint.sh` preserves any
`Authorization` header not beginning with `Bearer sb_`.

- [ ] **Step 4: Run the whole gate**

```bash
cd F:/Postora-supabase-fulltable
deno check --node-modules-dir=none supabase/functions/ai-agent-adapters/*.ts
deno test --allow-env --allow-net --node-modules-dir=none supabase/functions/
bun install
bun run test
bunx tsc --noEmit
```

Expected: all green. Deno before bun — the Deno gate destroys `node_modules`.

- [ ] **Step 5: Commit named files only**

```bash
git add supabase/functions/_shared/connectorRegistry.ts src/lib/connectorRegistry.ts supabase/functions/ai-agent-reply/toolGuides.test.ts docs/investigations/2026-09-08-self-hosted-supabase-connector-card.md
git commit -m "docs(connectors): explain paging and counting, and correct the Kong claim"
```

---

## Self-review

**Spec coverage.** R1 → T1, T5. R2 → T5 (short-page, exhaustion, no-progress, upstream_error, unordered), T6. R3 → T2, T8, T9. R4 → T5 count mode. R5 → no host-specific code; §4.1's correction is documentation-only. R6 → T1 defaults plus T5's "unconfigured still emits limit=25". §4.3 → T4. §4.4/§5.6 → T7. §5.5 → T3. §5.7 → T5, T6. §5.9 → T9. §7 no migration → asserted in Global Constraints; no task writes SQL.

**Type consistency.** `SupabaseReadEnvelope` is defined in T5 and consumed by name in T6 and T7. `resolveColumns(settings, table, modelSelect)` keeps its signature across T2, T3, T5. `truncated_by` uses the same seven values throughout. Failure assertions read `result.error.code` everywhere.

**Codex round-1 objections, resolved:** 1 → T4 budget clamp plus `SUPABASE_MIN_HOP_MS`. 2 → `dependencies.ts` untouched; per-hop timeout shallow-copied. 3 → per-row cost accumulation, `SUPABASE_CHAR_BUDGET` named for UTF-16 units. 4 → T7 narrowed to one payload, `credentialRepresentations()` retained, redaction before truncation. 5 → HEAD for count. 6 → `messaging-api` added to the deploy step. 7 → spec §4.1 corrected, promise rescoped to the credential. 8 → `ROW_LIMIT` kept until T5, real seams, `result.error.code`, T4 split out, existing assertions rewritten explicitly. 9 → short-page and ordering tests. 10 → `upstream_error`, `no_progress`, exact-multiple test. 11 → fail-closed map plus the cleared-field sentinel.
