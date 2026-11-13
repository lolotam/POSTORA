import { redactSensitive } from "../_shared/logging.ts";
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

/**
 * The catalog's product link is copied verbatim: the agent must hand over the
 * store's own URL, and a shortened one reads as a working link while pointing
 * nowhere (curemedkw, 2026-11-12). Every other cell is still bounded, and the
 * envelope's character budget still decides how many rows fit.
 */
const VERBATIM_COLUMNS = new Set(["product_url"]);

function trimRows(payload: unknown): unknown {
  const trimRow = (row: unknown): unknown => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return trimValue(row);
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [
        key,
        VERBATIM_COLUMNS.has(key) ? value : trimValue(value),
      ]),
    );
  };
  return Array.isArray(payload) ? payload.map(trimRow) : trimRow(payload);
}

function tableAllowList(settings: Record<string, unknown>): string[] {
  const raw = settings.table_allow_list;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string")
      .map((value) => value.trim()).filter((value) => value !== "" && value !== "-");
  }
  if (typeof raw === "string") {
    return raw.split(/[,\n]/).map((value) => value.trim()).filter((value) => value !== "" && value !== "-");
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
  // "-" is the card's cleared-field marker: a blank value is dropped before
  // save, so clearing the input has to travel as something. It can never be a
  // column name, unlike any bare identifier.
  if (raw.trim() === "-") return null;
  const columns = raw.split(",").map((column) => column.trim()).filter(Boolean);
  // A comma-separated list is accepted so a non-unique lead column can carry a
  // unique tie-breaker: `status,id` orders deterministically where `status`
  // alone does not, and Postgres may reorder equal values between the separate
  // queries this loop issues. Only bare identifiers, never raw query syntax.
  if (columns.length === 0) return null;
  if (!columns.every((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column))) return null;
  return columns.join(",");
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
 */
export interface ResolvedColumns {
  select: string;
  /**
   * True only when the OPERATOR named these columns. The model choosing its own
   * `select` is not approval: it could name `password` or `refresh_token`, so
   * that path keeps the structural redaction pass.
   */
  explicit: boolean;
}

/**
 * The operator's per-table column map, parsed once. NULL when there is none.
 *
 * It fails CLOSED. A map that will not parse, or that names this table with an
 * empty list, refuses the call instead of falling through to star — otherwise a
 * typo, or deleting the last column from a table, silently returns every column.
 */
function columnMap(settings: Record<string, unknown>): Record<string, unknown> | null {
  const raw = settings.column_map;
  if (typeof raw !== "string" || !raw.trim()) return null;
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
  return parsed as Record<string, unknown>;
}

export function resolveColumns(
  settings: Record<string, unknown>,
  table: string,
  modelSelect: string | null,
): ResolvedColumns {
  const map = columnMap(settings);
  if (map) {
    const entry = map[table];
    if (entry !== undefined) {
      // "*" is an explicit "no restriction on this table", so a map can name
      // every allowed table without the ones nobody narrowed being refused.
      if (typeof entry === "string" && entry.trim() === "*") {
        return { select: "*", explicit: false };
      }
      const columns = splitColumns(entry);
      if (columns.length === 0) {
        throw new SupabaseValidationError(
          "supabase_columns_empty",
          `No columns are allowed on "${table}" for this connector.`,
        );
      }
      return { select: columns.join(","), explicit: true };
    }
    // An ACTIVE map that does not name this table is refused, not widened.
    // Deleting or mistyping a table's entry would otherwise take the agent
    // from a scoped column list to every column, which is the opposite of what
    // editing a restriction should do. An empty map means "no restriction".
    if (Object.keys(map).length > 0) {
      throw new SupabaseValidationError(
        "supabase_columns_unmapped",
        `This connector's per-table column list does not cover "${table}".`,
      );
    }
  }
  const flat = splitColumns(settings.select_columns);
  if (flat.length) return { select: flat.join(","), explicit: true };
  const fromModel = splitColumns(modelSelect);
  if (fromModel.length) return { select: fromModel.join(","), explicit: false };
  return { select: "*", explicit: false };
}

/**
 * The column restriction the RPC result carries.
 *
 * The search function returns catalog rows, so the operator's restriction
 * applies to them exactly as it does to a table read (plan Task 5). column_map
 * is keyed by table, so the catalog table is the table the connector may read;
 * a connector that has only the function takes the table its map names, and a
 * map naming several tables cannot say which one the function returns, so it
 * is refused rather than guessed.
 *
 * The same rule applies to the table allow-list: it may name several tables,
 * and the function returns the rows of ONE of them. The first entry is not the
 * catalog table by any rule the operator wrote, so a list of several is
 * refused the same way a map of several is -- a guess filters away the product
 * fields the agent needs, and the operator is told which table to name.
 */
function rpcColumns(invocation: ConnectorInvocation): ResolvedColumns {
  const settings = invocation.tool.settings;
  const map = columnMap(settings);
  const mapTables = map ? Object.keys(map) : [];
  const allowList = tableAllowList(settings);
  // Exactly one named table names the catalog table: the per-table map first,
  // because it is the operator's explicit per-table restriction.
  const catalogTable = mapTables.length === 1
    ? mapTables[0]
    : allowList.length === 1
    ? allowList[0]
    : null;
  if (catalogTable) return resolveColumns(settings, catalogTable, null);
  if (mapTables.length > 1 || allowList.length > 1) {
    throw new SupabaseValidationError(
      "supabase_columns_unmapped",
      "This connector's per-table column list does not name the catalog table the search function returns.",
    );
  }
  const flat = splitColumns(settings.select_columns);
  if (flat.length) return { select: flat.join(","), explicit: true };
  return { select: "*", explicit: false };
}

/**
 * The projection PostgREST applies for a table read, applied here to an RPC
 * result: a column the operator did not allow never leaves the adapter.
 */
function projectColumns(row: unknown, columns: ResolvedColumns): unknown {
  if (!columns.explicit) return row;
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const allowed = new Set(columns.select.split(",").map((column) => column.trim()));
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).filter(([key]) => allowed.has(key)),
  );
}

/**
 * Whether a projection left the row with no field at all.
 *
 * A row the operator's restriction covers none of is not a match, and saying so
 * keeps it out of the row count.
 */
function isEmptyProjection(projected: unknown): boolean {
  return typeof projected === "object" && projected !== null && !Array.isArray(projected) &&
    Object.keys(projected as Record<string, unknown>).length === 0;
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

function buildUrl(invocation: ConnectorInvocation): { url: URL; schema: string; columns: ResolvedColumns } {
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
  const columns = resolveColumns(
    invocation.tool.settings,
    table,
    requiredString(parameters, "select"),
  );
  const select = columns.select;
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
  return { url, schema, columns };
}

/**
 * Order per C7: strip credentials, then trim cells, so a credential longer than
 * the cell cap cannot survive trimming as an unmatchable prefix. Columns the
 * operator named skip the key-name redaction; anything else (`select=*`, an RPC
 * result) still gets it.
 */
function vetRow(row: unknown, columnsExplicit: boolean, secrets: ReturnType<typeof credentialSecrets>): unknown {
  const vetted = columnsExplicit ? row : redactSensitive(row);
  const stripped = stripCredentialValues(vetted, secrets);
  return (trimRows([stripped]) as unknown[])[0];
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

/**
 * @param abortOnTimeout the hop's controller. Aborting the underlying fetch is
 * the only way to stop a stalled body: reading JSON locks the stream, and a
 * locked stream cannot be cancelled, so the socket would otherwise stay busy
 * past the deadline this function advertises.
 */
function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  abortOnTimeout?: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(Math.max(0, ms));
    const onAbort = () => {
      abortOnTimeout?.abort();
      reject(new SupabaseDeadlineError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          // The race already rejected; the hop was aborted with it.
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
    /** True when the operator named the columns, rather than falling back to `*`. */
    columnsExplicit: boolean;
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

    // One controller for the whole hop: the fetch AND the body read. Cancelling
    // the body afterwards is not possible once `.json()` has locked it.
    const hopAbort = new AbortController();
    let response: Response;
    try {
      response = await withDeadline(
        safeVendorFetch(
          url.toString(),
          { method: "GET", headers: pageHeaders, signal: hopAbort.signal },
          hopDependencies,
        ),
        deadline - Date.now(),
        hopAbort,
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
      payload = await withDeadline(readJson(response), deadline - Date.now(), hopAbort);
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
      // When the operator named the columns they vouched for them, so the
      // rows pass through and a column called `key` or `token` stays readable.
      // When they did not -- `select=*` -- the row may carry a `password`,
      // `refresh_token` or cookie nobody chose to expose, so the structural
      // key-name pass still applies.
      const trimmed = vetRow(row, limits.columnsExplicit, secrets);
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

  if (stop === "time_budget") {
    // Returns an ok envelope, so the dispatcher's failure logging never fires
    // and reply-side metering counts it as a success. Repeated database
    // slowness would otherwise leave no trace an administrator could find.
    dependencies.log({
      event: "connector_failure",
      vendor: "supabase",
      operation: limits.operation,
      error_code: "supabase_time_budget_exhausted",
    });
  }

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

export const DEFAULT_RPC_RESULTS = 8;
export const MAX_RPC_RESULTS = 25;
const BARE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Only the operator names a function, and only as a bare identifier: the
 * model-supplied `table` stays barred from `rpc/` (validateResource). An entry
 * that is not a bare name makes the whole list invalid rather than silently
 * skipping to the next one.
 */
function rpcFunction(settings: Record<string, unknown>): string | null {
  // "-" is the card's cleared-field marker, as for order_by.
  const names = splitColumns(settings.rpc_allow_list).filter((name) => name !== "-");
  if (names.length === 0) return null;
  if (!names.every((name) => BARE_IDENTIFIER.test(name))) {
    throw new SupabaseValidationError("supabase_configuration_invalid", "Supabase is not fully configured.");
  }
  return names[0];
}

/**
 * The connector names only a function: no table allow-list, and a function to
 * search the catalog with. The search path reaches the function instead of the
 * table, and the connection probe asks the function too (curemedkw, 2026-11-12).
 */
function rpcOnlyConnector(settings: Record<string, unknown>): boolean {
  if (tableAllowList(settings).length > 0) return false;
  return splitColumns(settings.rpc_allow_list).some((name) => name !== "-");
}

function rpcParamName(settings: Record<string, unknown>, key: string, fallback: string): string {
  const raw = settings[key];
  if (typeof raw !== "string" || !raw.trim() || raw.trim() === "-") return fallback;
  const name = raw.trim();
  if (!BARE_IDENTIFIER.test(name)) {
    throw new SupabaseValidationError("supabase_configuration_invalid", "Supabase is not fully configured.");
  }
  return name;
}

/**
 * The connection probe's query: one word no catalog holds, so the probe reads
 * nothing and still proves the project URL, the anon key, the schema and the
 * function. It is a read, with the same headers the search path uses.
 */
const CONNECTION_PROBE_QUERY = "postora-connection-probe";

/**
 * The probe for a connector that has only the function. The table probe reads
 * one row of a table; this asks the function for one row instead.
 *
 * The probe proves the SEARCH configuration, not only the transport: the column
 * restriction is resolved here too, so a column map that will not parse, or a
 * list of tables that does not name the catalog table, fails the probe instead
 * of failing every search afterwards.
 */
async function probeRpc(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  fn: string,
  anonKey: string,
): Promise<void> {
  rpcColumns(invocation);
  const search: RpcSearch = { ...rpcSearchFor(invocation, fn, anonKey), limit: 1 };
  const callerBudget = dependencies.callBudgetMs ?? SUPABASE_CALL_TIMEOUT_MS;
  const deadline = Date.now() + Math.min(SUPABASE_LOOP_BUDGET_MS, callerBudget - SUPABASE_MIN_HOP_MS);
  await postRpc(search, CONNECTION_PROBE_QUERY, dependencies, deadline);
}

/**
 * The probe for a connector that may read a table: one row of one allowed table.
 *
 * Returns the failure to report, or null when the table answered.
 */
async function probeTable(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  anonKey: string,
): Promise<ConnectorFailure | null> {
  const { url: baseUrl, schema } = buildUrl(invocation);
  const headers = {
    Accept: "application/json",
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    "Accept-Profile": schema,
  };
  // The probe stays a single one-row read; paging would test N requests the
  // operator never configured.
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
  return null;
}

/**
 * The capabilities this connector can actually run.
 *
 * A connector that names only a function has no table to read, so every
 * capability but the catalog search would fail on its first call. The probe
 * advertises what the connector can do, not what the adapter could do with a
 * table it was not given.
 */
function usableCapabilities(settings: Record<string, unknown>): Capability[] {
  return rpcOnlyConnector(settings) ? ["search_products"] : SUPABASE_CAPABILITIES;
}

/**
 * The one looser query a search that found nothing is retried with.
 *
 * The longest word is the plan's "brand only" form of the customer's words: a
 * product name searched as one word reaches the row the full phrase did not.
 * A single word has no shorter form, so there is nothing to loosen it to --
 * that case is the model's own second search, not this retry.
 */
function looserQuery(query: string): string | null {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  return words.reduce((longest, word) => (word.length > longest.length ? word : longest));
}

interface RpcSearch {
  url: string;
  headers: Record<string, string>;
  queryParam: string;
  limitParam: string;
  limit: number;
}

/**
 * The preference that makes a function call unable to commit anything.
 *
 * A function runs with the rights of its owner, so an allow-listed function can
 * write even when the anon role cannot: the connector's read-only promise is
 * only true if the CALL cannot leave a write behind, whatever the function does.
 * PostgREST's `tx=rollback` runs the request in a transaction it rolls back
 * afterwards, which makes the call read-only whatever the function's body is.
 *
 * The preference is honoured only where the target allows the client to choose
 * how the transaction ends (`db-tx-end = "commit-allow-override"`); a target
 * whose PostgREST commits by default ignores it. PostgREST says which of the
 * two happened in the `Preference-Applied` header, so the connector can tell a
 * read-only call from one that was only asked to be read-only.
 */
const READ_ONLY_PREFER = "tx=rollback";

/** Whether the target's PostgREST applied the read-only transaction. */
function readOnlyApplied(response: Response): boolean {
  const applied = response.headers.get("Preference-Applied") ?? "";
  return applied
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .includes(READ_ONLY_PREFER);
}

async function postRpc(
  search: RpcSearch,
  query: string,
  dependencies: AdapterDependencies,
  deadline: number,
): Promise<unknown[]> {
  const abort = new AbortController();
  const hopDependencies = {
    ...dependencies,
    timeoutMs: Math.max(0, Math.min(dependencies.timeoutMs, deadline - Date.now())),
  };
  const response = await withDeadline(
    safeVendorFetch(
      search.url,
      {
        method: "POST",
        headers: search.headers,
        body: JSON.stringify({ [search.queryParam]: query, [search.limitParam]: search.limit }),
        signal: abort.signal,
      },
      hopDependencies,
    ),
    deadline - Date.now(),
    abort,
  );
  if (!response.ok) {
    throw new SupabaseValidationError("supabase_http_error", "Supabase rejected the request.", response.status);
  }
  if (!readOnlyApplied(response)) {
    // The call was answered, but the target committed it: a function that writes
    // would have written. The connector promised a reader, so it refuses the
    // result rather than pass off an unproven call as a read.
    throw new SupabaseValidationError(
      "supabase_read_only_unenforced",
      "The search function was not called: this project's PostgREST does not apply `tx=rollback`, so the call cannot be proven read-only. Set `db-tx-end = \"commit-allow-override\"` on the project's PostgREST and try again.",
    );
  }
  const payload = await withDeadline(readJson(response), deadline - Date.now(), abort);
  if (isPostgrestErrorBody(payload)) {
    throw new SupabaseValidationError("supabase_postgrest_error", "Supabase returned a PostgREST error.", response.status);
  }
  if (!Array.isArray(payload)) {
    throw new SupabaseValidationError("supabase_response_invalid", "Supabase returned an invalid response.", response.status);
  }
  return payload;
}

function rpcSearchFor(invocation: ConnectorInvocation, fn: string, anonKey: string): RpcSearch {
  const settings = invocation.tool.settings;
  const projectUrl = requiredString(settings, "project_url");
  const schema = requiredString(settings, "schema");
  if (!projectUrl || !schema) {
    throw new SupabaseValidationError("supabase_configuration_invalid", "Supabase is not fully configured.");
  }
  const queryParam = rpcParamName(settings, "rpc_query_param", "q");
  const limitParam = rpcParamName(settings, "rpc_limit_param", "max_results");
  if (queryParam === limitParam) {
    // The body is one object, so two arguments with the same name are one
    // argument: the query would be dropped and the function would search with
    // the row count instead. The search is silently wrong, so it is refused.
    throw new SupabaseValidationError(
      "supabase_configuration_invalid",
      "Supabase is not fully configured.",
    );
  }
  return {
    url: `${projectUrl.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Profile": schema,
      "Accept-Profile": schema,
      // The call runs in a transaction the target rolls back: see READ_ONLY_PREFER.
      Prefer: READ_ONLY_PREFER,
    },
    queryParam,
    limitParam,
    // The operator's row ceiling binds the function too: the search path
    // reuses max_rows, so a model asking for more rows cannot outrun the
    // limit the connector card shows.
    limit: Math.min(
      clampInteger(invocation.request.parameters.max_results, DEFAULT_RPC_RESULTS, 1, MAX_RPC_RESULTS),
      resolveMaxRows(settings),
    ),
  };
}

/**
 * Catalog search through the store's own function, which does the Arabic
 * normalisation and fuzzy ranking an exact-match table filter cannot
 * (2026-11-12). When several words find nothing, the tool retries once with
 * the longest word itself: the model had already ignored a prompt rule asking
 * it to loosen the query.
 */
async function searchViaRpc(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  fn: string,
  anonKey: string,
): Promise<SupabaseReadEnvelope & { retried_with?: string }> {
  const raw = invocation.request.parameters.query;
  const query = typeof raw === "string" ? raw.trim() : "";
  if (!query) {
    // Never call with an empty query: on 2026-11-10 an empty-filter call
    // answered the customer with an arbitrary slice of the catalog.
    throw new SupabaseValidationError(
      "supabase_query_required",
      "Pass `query`: the product words from the customer's message, in their language.",
    );
  }
  // The column restriction is resolved BEFORE the call: a configuration that cannot
  // work is refused without spending a request on the vendor.
  const columns = rpcColumns(invocation);
  const secrets = credentialSecrets(invocation.credentials);
  const search = rpcSearchFor(invocation, fn, anonKey);
  const callerBudget = dependencies.callBudgetMs ?? SUPABASE_CALL_TIMEOUT_MS;
  const deadline = Date.now() + Math.min(SUPABASE_LOOP_BUDGET_MS, callerBudget - SUPABASE_MIN_HOP_MS);

  let rows = await postRpc(search, query, dependencies, deadline);
  let retriedWith: string | undefined;
  const looser = rows.length === 0 ? looserQuery(query) : null;
  if (looser && deadline - Date.now() >= SUPABASE_MIN_HOP_MS) {
    rows = await postRpc(search, looser, dependencies, deadline);
    retriedWith = looser;
  }

  const collected: unknown[] = [];
  let chars = 2; // the enclosing [] of the serialized array
  let truncated: SupabaseReadEnvelope["truncated_by"] = null;
  let projectedAway = 0;
  for (const row of rows.slice(0, search.limit)) {
    const projected = projectColumns(row, columns);
    // A row the restriction projects to nothing is not a match: it carries no field
    // the agent may show. Counting it would tell the agent the catalog has rows it
    // cannot read, so it is dropped before it reaches the count.
    if (columns.explicit && isEmptyProjection(projected)) {
      projectedAway++;
      continue;
    }
    const vetted = vetRow(projected, columns.explicit, secrets);
    const cost = JSON.stringify(vetted).length + (collected.length ? 1 : 0);
    if (chars + cost > SUPABASE_CHAR_BUDGET) { truncated = "char_budget"; break; }
    collected.push(vetted);
    chars += cost;
  }
  if (projectedAway > 0 && collected.length === 0) {
    // Every row the function returned was projected away: the operator's restriction
    // names none of the columns it returns. Saying so is better than an empty result
    // that reads as "the catalog has nothing".
    throw new SupabaseValidationError(
      "supabase_columns_unmapped",
      "This connector's per-table column list does not cover any column the search function returns.",
    );
  }
  return {
    rows: collected,
    row_count: collected.length,
    total: null,
    has_more: false,
    next_offset: null,
    truncated_by: truncated,
    ...(retriedWith === undefined ? {} : { retried_with: retriedWith }),
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
    const settings = invocation.tool.settings;
    // The execution path is resolved BEFORE the table settings are read. A
    // catalog connector names a function, not a table, and must not be refused
    // for having no table allow-list (curemedkw, 2026-11-12).
    const fn = capability === "search_products" ? rpcFunction(settings) : null;

    if (invocation.request.action === "test_connection") {
      // The probe asks the FUNCTION whenever the connector has one, because the
      // catalog search uses it: a probe that only reads the table reports success
      // for a connector whose function is missing, misnamed or unreachable, and
      // every search afterwards fails.
      const probeFunction = rpcFunction(settings);
      if (probeFunction) {
        await probeRpc(invocation, dependencies, probeFunction, anonKey);
        // A connector that may also read a table needs the table probe too: the
        // capabilities that read rows go there.
        if (tableAllowList(settings).length > 0) {
          const tableFailure = await probeTable(invocation, dependencies, anonKey);
          if (tableFailure) return tableFailure;
        }
        return {
          ok: true,
          vendor: "supabase",
          action: "test_connection",
          capabilities: usableCapabilities(settings),
          read_only: true,
        };
      }
      const tableFailure = await probeTable(invocation, dependencies, anonKey);
      if (tableFailure) return tableFailure;
      return {
        ok: true,
        vendor: "supabase",
        action: "test_connection",
        capabilities: SUPABASE_CAPABILITIES,
        read_only: true,
      };
    }

    // The dispatcher already refuses an execute without a capability; this is
    // the boundary re-check so the adapter cannot be called around it.
    if (!capability) {
      return supabaseFailure("capability_unsupported", "The requested connector capability is not supported.");
    }

    if (fn) {
      // The function's result is capped at the operator's row ceiling, so a count
      // taken from it would be that cap, not the number of matches: the model would
      // tell the customer a false total. Count mode is refused rather than answered
      // with a number that is wrong.
      if (invocation.request.parameters.mode === "count") {
        throw new SupabaseValidationError(
          "supabase_count_unsupported",
          "This connector searches through a function, which cannot count the matches. Ask for the rows instead.",
        );
      }
      const data = await searchViaRpc(invocation, dependencies, fn, anonKey);
      return { ok: true, vendor: "supabase", action: "execute", capability, data };
    }

    const { url: baseUrl, schema, columns } = buildUrl(invocation);
    const headers = {
      Accept: "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Accept-Profile": schema,
    };

    // Count mode is routed first (C3): it needs no ordering and reads no rows.
    if (invocation.request.parameters.mode === "count") {
      // The caller may have far less left than the vendor default, and its
      // abort would discard a count that was still running -- the same timeout
      // mismatch the row path exists to avoid.
      const countBudget = Math.max(
        0,
        Math.min(
          dependencies.timeoutMs,
          (dependencies.callBudgetMs ?? SUPABASE_CALL_TIMEOUT_MS) - SUPABASE_MIN_HOP_MS,
        ),
      );
      const countAbort = new AbortController();
      const response = await withDeadline(
        safeVendorFetch(
          baseUrl.toString(),
          {
            method: "HEAD",
            headers: { ...headers, Prefer: "count=exact" },
            signal: countAbort.signal,
          },
          { ...dependencies, timeoutMs: countBudget },
        ),
        countBudget,
        countAbort,
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
      columnsExplicit: columns.explicit,
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

const SUPABASE_CAPABILITIES = CAPABILITIES.filter(
  (name) => name === "search_products" || name === "check_stock" || name === "lookup_orders",
);

export const supabaseAdapter: ConnectorAdapter = {
  id: "supabase",
  capabilities: SUPABASE_CAPABILITIES,
  execute: (invocation, dependencies) =>
    callSupabase(invocation, dependencies, invocation.request.capability),
  testConnection: (invocation, dependencies) =>
    callSupabase(invocation, dependencies),
};
