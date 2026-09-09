import { readJson, safeVendorFetch } from "./http.ts";
import { credentialSecrets, stripCredentialValues } from "./redaction.ts";
import {
  SUPABASE_CALL_TIMEOUT_MS,
  SUPABASE_LOOP_BUDGET_MS,
  SUPABASE_MIN_HOP_MS,
} from "../_shared/connectorBudgets.ts";
import type {
  AdapterDependencies,
  Capability,
  ConnectorAdapter,
  ConnectorFailure,
  ConnectorInvocation,
  ConnectorResult,
} from "./types.ts";
import { CAPABILITIES } from "./types.ts";
import { requiredString } from "./validation.ts";

export class SupabaseValidationError extends Error {
  constructor(readonly code: string, message: string, readonly vendorStatus?: number) {
    super(message);
    this.name = "SupabaseValidationError";
  }
}

function supabaseFailure(
  code: string,
  message: string,
  vendorStatus?: number,
): ConnectorFailure {
  return {
    ok: false,
    vendor: "supabase",
    error: {
      code,
      message,
      ...(vendorStatus === undefined ? {} : { vendor_status: vendorStatus }),
    },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return payload !== null && typeof payload === "object"
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function validateSupabaseAnonKey(key: string): void {
  if (key.startsWith("sb_secret_")) {
    throw new SupabaseValidationError(
      "supabase_service_role_refused",
      "Supabase service-role and secret keys are not allowed.",
    );
  }
  if (key.startsWith("sb_publishable_")) return;

  const payload = decodeJwtPayload(key);
  if (payload?.role === "service_role") {
    throw new SupabaseValidationError(
      "supabase_service_role_refused",
      "Supabase service-role and secret keys are not allowed.",
    );
  }
  if (payload?.role !== "anon") {
    throw new SupabaseValidationError(
      "supabase_anon_key_required",
      "A Supabase anon or publishable key is required.",
    );
  }
}

// Derived, not picked: a real row is ~250 characters after per-cell trimming
// below, so no single cell may take most of a row's share. A real product
// permalink fits comfortably; a signed storage token does not, which is the
// point. (The historical 25-row ROW_LIMIT that lived here was replaced by the
// configurable ceiling and internal page loop in the full-table-reads change.)
const MAX_VALUE_CHARS = 160;

/**
 * Bounds one cell. The table is arbitrary -- unlike WooCommerce there is no
 * known field list to project down to -- so length is the only thing that can
 * be bounded without knowing what the column means. A signed storage URL is
 * the case that forced this: several hundred characters of token that answer
 * no customer question, crowding out the price that does.
 *
 * The marker is deliberate: a silently shortened URL reads as a working link.
 */
function trimValue(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS)}…[truncated]`;
}

function trimRows(payload: unknown): unknown {
  const trimRow = (row: unknown): unknown => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return trimValue(row);
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, trimValue(value)]),
    );
  };
  return Array.isArray(payload) ? payload.map(trimRow) : trimRow(payload);
}

function tableAllowList(settings: Record<string, unknown>): string[] {
  const raw = settings.table_allow_list;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
  }
  return [];
}

export const DEFAULT_MAX_ROWS = 25;
export const MAX_ROWS_CEILING = 1000;
export const DEFAULT_PAGE_SIZE = 200;
// Wall-clock ceiling for the whole page loop, inside the caller's 12s budget.
export { SUPABASE_LOOP_BUDGET_MS, SUPABASE_MIN_HOP_MS };
// A hop is never started without at least this much budget left, so the loop
// cannot overrun its caller by starting a request it has no time to finish.

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

function validateResource(table: string, select: string, allowList: string[]): void {
  if (/(^|\/)rpc\//i.test(table)) {
    throw new SupabaseValidationError("supabase_rpc_refused", "Supabase RPC paths are not allowed.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new SupabaseValidationError("supabase_resource_invalid", "The Supabase resource is invalid.");
  }
  if (!allowList.includes(table)) {
    // The allowed names are said out loud so the model can correct itself on a
    // later tool iteration. "not allowed" alone named no alternative, so a
    // guessed table ended the conversation with "I cannot reach the system"
    // (2026-09-01). These names are the operator's own configuration, already
    // visible to them in the connector form -- not a secret.
    throw new SupabaseValidationError(
      "supabase_resource_refused",
      `Table "${table}" is not allowed for this connector. Allowed tables: ${allowList.join(", ")}.`,
    );
  }
  // Defence in depth only: the table allow-list is not the security boundary.
  // The target project's RLS is the boundary that PostgREST query syntax cannot bypass.
  if (/[()]/.test(select)) {
    throw new SupabaseValidationError(
      "supabase_embedding_refused",
      "Supabase relation embedding and select functions are not allowed.",
    );
  }
}

function buildUrl(invocation: ConnectorInvocation): { url: URL; schema: string } {
  const projectUrl = requiredString(invocation.tool.settings, "project_url");
  const schema = requiredString(invocation.tool.settings, "schema");
  const allowList = tableAllowList(invocation.tool.settings);
  if (!projectUrl || !schema || allowList.length === 0) {
    throw new SupabaseValidationError(
      "supabase_configuration_invalid",
      "Supabase is not fully configured.",
    );
  }

  const parameters = invocation.request.parameters;
  const table = requiredString(parameters, "table") ?? allowList[0];
  // An operator-configured column list OVERRIDES whatever the model asked for,
  // not merely defaults it: the setting exists so the agent reads only these
  // columns, and the model has a record of inventing column names that 400 the
  // whole query. Resolution order: column_map[table], then the flat
  // select_columns, then the model's select, then star.
  const select = resolveColumns(
    invocation.tool.settings,
    table,
    requiredString(parameters, "select"),
  );
  validateResource(table, select, allowList);

  const url = new URL(`${projectUrl.replace(/\/+$/, "")}/rest/v1/${encodeURIComponent(table)}`);
  url.searchParams.set("select", select);

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
      // The page loop writes `order`, `limit` and `offset` onto this same URL,
      // and `select` is already set. A filter sharing one of those names is
      // silently overwritten, so the connector answers the whole table where
      // the model asked for one row -- a wrong answer that looks right.
      if (RESERVED_QUERY_PARAMS.has(column)) {
        throw new SupabaseValidationError(
          "supabase_filter_refused",
          `Filtering on "${column}" is not supported by this connector.`,
        );
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
  // No limit/offset here: the test-connection probe sets limit=1 itself and
  // the page loop owns paging (spec §5.1).
  return { url, schema };
}

/** PostgREST answers `0-24/4213`, or `*` in place of the range on a count probe. */
function parseTotal(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const total = contentRange.split("/")[1];
  if (!total || total === "*") return null;
  const parsed = Number(total);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPostgrestErrorBody(payload: unknown): boolean {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
    (typeof (payload as Record<string, unknown>).code === "string" ||
      typeof (payload as Record<string, unknown>).message === "string");
}

/**
 * Races one hop's whole lifetime -- validation, redirects and the body read --
 * against the loop's absolute deadline. safeVendorFetch restarts its timer per
 * redirect hop and clears it before readJson, so only an outer race like this
 * bounds a hop end-to-end (C1).
 */
/** Distinguishes "we ran out of time" from any other rejection. */
class SupabaseDeadlineError extends Error {
  constructor() {
    super("Supabase page exceeded its deadline");
    this.name = "SupabaseDeadlineError";
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(Math.max(0, ms));
    const onAbort = () => reject(new SupabaseDeadlineError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted && value instanceof Response) {
          // The race already rejected; drop the body rather than leak it.
          value.body?.cancel().catch(() => {});
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// UTF-16 code units, not bytes: String.length is what the serialised envelope
// is measured in downstream, so the budget is counted the same way.
/** Reserved by PostgREST's query grammar and by the page loop's own params. */
const RESERVED_QUERY_PARAMS = new Set([
  "select", "order", "limit", "offset", "and", "or", "not",
]);

export const SUPABASE_CHAR_BUDGET = 60_000;

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

/**
 * One tool call, N PostgREST requests. Bounded by the resolved row ceiling, a
 * character budget and one ABSOLUTE deadline derived from the caller's budget
 * (C1), and it states in `truncated_by` exactly why it stopped so the model
 * never has to guess whether a result is whole.
 */
async function readPages(
  base: URL,
  headers: Record<string, string>,
  dependencies: AdapterDependencies,
  credentials: Record<string, unknown>,
  limits: {
    maxRows: number;
    pageSize: number;
    startOffset: number;
    orderBy: string | null;
    operation: string;
  },
): Promise<SupabaseReadEnvelope> {
  // The caller may have less than 12s left, so the loop cannot assume 8s. The
  // Supabase caller ceiling is SUPABASE_CALL_TIMEOUT_MS (C8); callBudgetMs
  // lets a caller that knows its remaining time shrink it further.
  const callerBudget = dependencies.callBudgetMs ?? SUPABASE_CALL_TIMEOUT_MS;
  const deadline = Date.now() + Math.min(SUPABASE_LOOP_BUDGET_MS, callerBudget - SUPABASE_MIN_HOP_MS);
  const collected: unknown[] = [];
  let chars = 2; // the enclosing [] of the serialized array
  let total: number | null = null;
  let cursor = limits.startOffset;
  let stop: SupabaseReadEnvelope["truncated_by"] = null;
  let exhausted = false;
  // Captured at whichever break site sets `upstream_error`, so the single log
  // call at loop exit can say what actually went wrong.
  let pageErrorCode = "supabase_http_error";
  let pageStatus: number | undefined;
  // Built once. This allocates a Set, URL-encodes, base64s and sorts, and the
  // row loop below runs up to `maxRows` times.
  const secrets = credentialSecrets(credentials);

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
    // Shallow copy only: dependencies.ts's shared timeoutMs stays untouched
    // because WooCommerce reads it too (spec §4.3).
    const hopDependencies = {
      ...dependencies,
      timeoutMs: Math.max(0, Math.min(dependencies.timeoutMs, deadline - Date.now())),
    };

    let response: Response;
    try {
      response = await withDeadline(
        safeVendorFetch(url.toString(), { method: "GET", headers: pageHeaders }, hopDependencies),
        deadline - Date.now(),
      );
    } catch (cause) {
      // A rejected fetch, an abort or a DNS failure on page two must not throw
      // away page one; the dispatcher would turn it into connector_request_failed.
      if (collected.length === 0) throw cause;
      pageErrorCode = "supabase_request_failed";
      stop = "upstream_error";
      break;
    }
    if (!response.ok) {
      // Rows already fetched are worth more than a whole-request failure. A
      // first-page failure keeps the exact pre-loop response, 400 hint included.
      if (collected.length === 0) {
        throw new SupabaseValidationError(
          "supabase_http_error",
          response.status === 400
            ? "Supabase rejected the query. Retry the same capability with no `select` and no `filters`."
            : "Supabase rejected the request.",
          response.status,
        );
      }
      pageErrorCode = "supabase_http_error";
      pageStatus = response.status;
      stop = "upstream_error";
      break;
    }
    if (total === null) total = parseTotal(response.headers.get("content-range"));

    let payload: unknown;
    try {
      payload = await withDeadline(readJson(response), deadline - Date.now());
    } catch (cause) {
      if (collected.length === 0) throw cause;
      pageErrorCode = "supabase_request_failed";
      stop = "upstream_error";
      break;
    }
    if (isPostgrestErrorBody(payload)) {
      if (collected.length === 0) {
        throw new SupabaseValidationError(
          "supabase_postgrest_error",
          "Supabase returned a PostgREST error.",
          response.status,
        );
      }
      pageErrorCode = "supabase_postgrest_error";
      pageStatus = response.status;
      stop = "upstream_error";
      break;
    }
    if (!Array.isArray(payload)) {
      if (collected.length === 0) {
        throw new SupabaseValidationError(
          "supabase_response_invalid",
          "Supabase returned an invalid response.",
          response.status,
        );
      }
      pageErrorCode = "supabase_response_invalid";
      pageStatus = response.status;
      stop = "upstream_error";
      break;
    }

    // Accumulate each row's own length instead of re-serializing the whole
    // array per row, which was quadratic. `length` counts UTF-16 code units.
    // Order per C7: fetch -> strip credentials -> trim cells -> accumulate, so
    // a credential longer than the cell cap cannot survive trimming as an
    // unmatchable prefix.
    let budgetHit = false;
    let acceptedFromPage = 0;
    for (const row of payload) {
      const stripped = stripCredentialValues(row, secrets);
      const trimmed = (trimRows([stripped]) as unknown[])[0];
      const cost = JSON.stringify(trimmed).length + (collected.length ? 1 : 0);
      if (chars + cost > SUPABASE_CHAR_BUDGET) { budgetHit = true; break; }
      collected.push(trimmed);
      chars += cost;
      acceptedFromPage += 1;
    }
    cursor += acceptedFromPage;

    if (budgetHit) {
      // Not one row fitted and nothing has ever fitted: stop rather than ask
      // for the same offset forever. C5 makes the result non-repeatable.
      stop = collected.length === 0 ? "no_progress" : "char_budget";
      break;
    }
    // An empty page is unambiguous exhaustion whether or not an order was
    // configured, so it is checked before the unordered stop.
    if (payload.length === 0) { exhausted = true; break; }
    // C2: an unordered read never continues, whatever the numbers say — the
    // table may genuinely have more rows, but paging without a stable order
    // would duplicate and skip them.
    if (limits.orderBy === null) { stop = "unordered"; break; }
    if (total !== null && cursor >= total) { exhausted = true; break; }
    // A SHORT page is PostgREST's own row cap, not the end of the table.
  }

  if (!stop && !exhausted && collected.length >= limits.maxRows) {
    const known = total !== null && cursor >= total;
    if (known) exhausted = true; else stop = "max_rows";
  }

  let hasMore = !exhausted && stop !== null;
  if (stop === "unordered") {
    // A single page that already covered the whole table must not claim there
    // is more; without a total the honest answer is "unknown", so true.
    hasMore = total === null || cursor < total;
  }
  if (stop === "no_progress") {
    // An unchanged offset tells the model to retry the same offset forever.
    hasMore = false;
  }

  // An offset is only worth handing back if a follow-up call would ACCEPT it.
  // Without an order column the connector refuses a non-zero offset outright,
  // and a stop that collected nothing would hand back the offset just used --
  // both leave the model retrying a call that cannot advance. `has_more` stays
  // honest either way: more rows may well exist, we just cannot page to them.
  const continuable = limits.orderBy !== null && cursor > limits.startOffset;

  if (stop === "upstream_error") {
    // A page that failed mid-loop still returns a SUCCESSFUL envelope, so the
    // dispatcher's failure logging never fires and a short answer reaches the
    // customer looking complete. This is the only place that can say otherwise.
    dependencies.log({
      event: "connector_failure",
      vendor: "supabase",
      operation: limits.operation,
      error_code: pageErrorCode,
      ...(pageStatus === undefined ? {} : { vendor_status: pageStatus }),
    });
  }

  return {
    rows: collected,
    row_count: collected.length,
    total,
    has_more: hasMore,
    next_offset: hasMore && continuable ? cursor : null,
    truncated_by: stop,
  };
}

async function callSupabase(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  capability?: Capability,
): Promise<ConnectorResult> {
  const anonKey = requiredString(invocation.credentials, "anon_key");
  if (!anonKey) return supabaseFailure("supabase_configuration_invalid", "Supabase is not fully configured.");

  try {
    validateSupabaseAnonKey(anonKey);
    const { url: baseUrl, schema } = buildUrl(invocation);
    const headers = {
      Accept: "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Accept-Profile": schema,
    };

    // The probe stays a single one-row read; paging would test N requests the
    // operator never configured.
    if (invocation.request.action === "test_connection") {
      const url = new URL(baseUrl.toString());
      url.searchParams.set("limit", "1");
      const response = await safeVendorFetch(url.toString(), { method: "GET", headers }, dependencies);
      if (!response.ok) {
        // A 400 here is almost always a column the model invented in `select`
        // or `filters`; saying so lets it retry without them. The vendor's own
        // message is NOT echoed: it names columns of the operator's database.
        return supabaseFailure(
          "supabase_http_error",
          response.status === 400
            ? "Supabase rejected the query. Retry the same capability with no `select` and no `filters`."
            : "Supabase rejected the request.",
          response.status,
        );
      }
      const payload = await readJson(response);
      if (isPostgrestErrorBody(payload)) {
        return supabaseFailure("supabase_postgrest_error", "Supabase returned a PostgREST error.", response.status);
      }
      if (!Array.isArray(payload)) {
        return supabaseFailure("supabase_response_invalid", "Supabase returned an invalid response.", response.status);
      }
      return {
        ok: true,
        vendor: "supabase",
        action: "test_connection",
        capabilities: [...CAPABILITIES],
        read_only: true,
      };
    }

    // The dispatcher already refuses an execute without a capability; this is
    // the boundary re-check so the adapter cannot be called around it.
    if (!capability) {
      return supabaseFailure("capability_unsupported", "The requested connector capability is not supported.");
    }

    // Count mode is routed first (C3): it needs no ordering and reads no rows.
    if (invocation.request.parameters.mode === "count") {
      const response = await safeVendorFetch(
        baseUrl.toString(),
        { method: "HEAD", headers: { ...headers, Prefer: "count=exact" } },
        dependencies,
      );
      if (!response.ok) {
        throw new SupabaseValidationError("supabase_http_error", "Supabase rejected the request.", response.status);
      }
      return { ok: true, vendor: "supabase", action: "execute", capability, data: {
        rows: [],
        row_count: 0,
        total: parseTotal(response.headers.get("content-range")),
        has_more: false,
        next_offset: null,
        truncated_by: null,
      } };
    }

    const orderBy = resolveOrderBy(invocation.tool.settings);
    const startOffset = resolveOffset(invocation.request.parameters);
    if (orderBy === null && startOffset > 0) {
      // C2: continuing from an offset with no stable order returns a
      // differently-shuffled window, which is worse than an error.
      throw new SupabaseValidationError(
        "supabase_order_required",
        "Continuing from an offset needs an `order_by` column configured on the connector; ask the operator to set one.",
      );
    }

    const envelope = await readPages(baseUrl, headers, dependencies, invocation.credentials, {
      maxRows: resolveMaxRows(invocation.tool.settings),
      pageSize: resolvePageSize(invocation.tool.settings),
      startOffset,
      orderBy,
      operation: capability,
    });
    return { ok: true, vendor: "supabase", action: "execute", capability, data: envelope };
  } catch (error) {
    if (error instanceof SupabaseDeadlineError) {
      // Otherwise this escapes as the dispatcher's generic
      // connector_request_failed and the model learns nothing it can act on.
      return supabaseFailure(
        "supabase_timeout",
        "Supabase did not answer within the time this request had left.",
      );
    }
    if (error instanceof SupabaseValidationError) {
      return supabaseFailure(error.code, error.message, error.vendorStatus);
    }
    throw error;
  }
}

export const supabaseAdapter: ConnectorAdapter = {
  id: "supabase",
  capabilities: [...CAPABILITIES],
  execute: (invocation, dependencies) =>
    callSupabase(invocation, dependencies, invocation.request.capability),
  testConnection: (invocation, dependencies) =>
    callSupabase(invocation, dependencies),
};
