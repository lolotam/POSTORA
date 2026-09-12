import { useState } from "react";
import { Loader2, RefreshCw, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  fetchSupabaseIntrospection,
  fetchTableColumns,
  TableListUnavailableError,
  type SupabaseIntrospection,
} from "@/lib/supabaseIntrospection";

// The dropdown upgrade for the Supabase connector card.
//
// The three text fields (schema, table allow-list, columns) stay authoritative
// and stay editable: this component only OFFERS what the project reports and
// writes selections back into those same fields as the comma-joined strings
// the adapter already parses. That keeps every existing save path untouched,
// and keeps the card usable when introspection cannot run — a saved connector
// never gets its anon key back (blank means keep-existing), so on edit the
// picker can only work after the key is re-entered.

interface SupabaseSchemaPickerProps {
  projectUrl: string;
  anonKey: string;
  schema: string;
  tableAllowList: string;
  selectColumns: string;
  columnMap: string;
  /** The project's tables and columns as the picker last read them (settings.column_catalog). */
  columnCatalog: string;
  onPatch: (patch: Record<string, string>) => void;
}

// The catalog is only ever written by this component, from a successful load,
// so anything that fails to parse is treated as absent rather than reported.
function parseCatalog(value: string): SupabaseIntrospection | null {
  if (!value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SupabaseIntrospection>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tables)) return null;
    const tables = parsed.tables.filter((table): table is string => typeof table === "string");
    const columnsByTable: Record<string, string[]> = {};
    for (const [table, columns] of Object.entries(parsed.columnsByTable ?? {})) {
      if (Array.isArray(columns)) {
        columnsByTable[table] = columns.filter((column): column is string => typeof column === "string");
      }
    }
    return { tables, columnsByTable };
  } catch {
    return null;
  }
}

// A settings value has no size limit, but a whole-project catalog on a large
// schema is more than an edit needs: past this, only the allowed tables keep
// their columns and the rest are listed by name.
const CATALOG_CHAR_BUDGET = 60_000;

function catalogPatch(result: SupabaseIntrospection, allowedTables: string[]): string {
  const full = JSON.stringify(result);
  if (full.length <= CATALOG_CHAR_BUDGET) return full;
  return JSON.stringify({
    tables: result.tables,
    columnsByTable: Object.fromEntries(
      allowedTables.map((table) => [table, result.columnsByTable[table] ?? []]),
    ),
  });
}

function parseList(value: string): string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function parseColumnMap(value: string): Record<string, string[]> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([table, columns]) => [table, parseList(String(columns))]),
    );
  } catch {
    // A hand-edited map that will not parse must not blank the picker; the
    // adapter refuses it loudly at call time.
    return {};
  }
}

function toggled(list: string[], entry: string): string[] {
  return list.includes(entry) ? list.filter((item) => item !== entry) : [...list, entry];
}

export function SupabaseSchemaPicker({
  projectUrl,
  anonKey,
  schema,
  tableAllowList,
  selectColumns,
  columnMap,
  columnCatalog,
  onPatch,
}: SupabaseSchemaPickerProps) {
  const [introspection, setIntrospection] = useState<SupabaseIntrospection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Supabase Cloud gates the table-listing endpoint to the service_role key,
  // so on those projects only columns are discoverable -- per table the
  // operator has named, by reading one sample row with the anon key.
  const [tableListUnavailable, setTableListUnavailable] = useState(false);

  const ready = projectUrl.trim().length > 0 && anonKey.trim().length > 0;
  const selectedTables = parseList(tableAllowList);
  const selectedColumns = parseList(selectColumns);

  const parsedMap = parseColumnMap(columnMap);

  const columnsFor = (table: string): string[] => {
    const mapped = parsedMap[table];
    // "*" means the operator explicitly left this table unrestricted.
    if (mapped && mapped.length === 1 && mapped[0] === "*") return [];
    if (mapped) return mapped;
    // Before any per-table choice exists, the flat list is what applies.
    return selectedColumns;
  };

  // Columns are offered per SELECTED table. Unioning them was wrong once a
  // connector allowed two tables: picking products.price and orders.total sent
  // "price,total" to BOTH, so each query failed on the column its table lacks,
  // and adding a second table broke access that already worked.
  //
  // The tree is drawn before any load. On edit the anon key is never shown
  // back, so introspection cannot run until it is re-entered -- and an empty
  // tree made editing look like starting from scratch. The base is the catalog
  // this picker stored on its last successful load (every table, every column,
  // so the saved columns show ticked AMONG the others); a connector saved
  // before the catalog existed falls back to the saved selection alone, which
  // is all it has. A live load then only ADDS what the project reports; saved
  // tables and columns stay listed and ticked even if the project no longer
  // lists them, so a save cannot silently drop them.
  const union = (first: string[], second: string[]) => [...new Set([...first, ...second])];
  const base = introspection ?? parseCatalog(columnCatalog);
  const view: SupabaseIntrospection | null = base
    ? {
      tables: union(base.tables, selectedTables),
      columnsByTable: Object.fromEntries(
        selectedTables.map((table) => [
          table,
          union(base.columnsByTable[table] ?? [], columnsFor(table)),
        ]),
      ),
    }
    : selectedTables.length > 0
    ? {
      tables: selectedTables,
      columnsByTable: Object.fromEntries(selectedTables.map((table) => [table, columnsFor(table)])),
    }
    : null;

  // The adapter refuses any table an active map does not name, so narrowing one
  // table must not silently deny the others. Every allowed table is therefore
  // always represented: narrowed ones by their column list, the rest by "*",
  // which the adapter reads as "no restriction on this table".
  // An active map denies any table it does not name, so selecting a table has
  // to add it -- as "*", since no narrower choice has been made yet. Without
  // this the picker shows a table as allowed while the adapter refuses it.
  const patchTables = (tables: string[]): Record<string, string> => {
    const patch: Record<string, string> = { table_allow_list: tables.join(", ") };
    if (Object.keys(parsedMap).length === 0) return patch;
    const next: Record<string, string[] | string> = {};
    for (const table of tables) {
      const columns = parsedMap[table];
      next[table] = columns && columns.length > 0 && columns[0] !== "*" ? columns : "*";
    }
    const narrowed = Object.values(next).some((value) => Array.isArray(value));
    patch.column_map = narrowed ? JSON.stringify(next) : "{}";
    return patch;
  };

  // A click never WIDENS access. Unchecking a table's last column leaves it
  // with an empty list, which the adapter refuses, rather than promoting it to
  // every column -- removing a permission must not grant a broader one. Saying
  // "all columns" is a separate, deliberate act: clear the raw field.
  const emitMap = (table: string, column: string) => {
    const next: Record<string, string[] | string> = {};
    for (const allowed of selectedTables) {
      if (allowed === table) {
        next[allowed] = toggled(columnsFor(allowed), column);
        continue;
      }
      const current = parsedMap[allowed];
      const narrowed = current && current.length > 0 && current[0] !== "*";
      next[allowed] = narrowed ? current : "*";
    }
    const restricts = Object.values(next).some((value) => Array.isArray(value));
    // Collapsing to "{}" hands control back to the flat select_columns list.
    // That is right when there is no flat list, and wrong when there is one:
    // the tables just left as "*" would silently inherit its columns instead of
    // staying unrestricted, so the wildcard entries are kept.
    const legacyFlatList = selectedColumns.length > 0;
    // "{}" rather than "" because a blank value is dropped before save and the
    // old restriction would survive the settings merge.
    onPatch({
      column_map: restricts || legacyFlatList ? JSON.stringify(next) : "{}",
    });
  };

  const sampleTypedTables = async () => {
    if (selectedTables.length === 0) {
      throw new TableListUnavailableError();
    }
    const columnsByTable: Record<string, string[]> = {};
    const failures: string[] = [];
    for (const table of selectedTables) {
      try {
        columnsByTable[table] = await fetchTableColumns(projectUrl, anonKey, schema, table);
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : `Could not read "${table}".`);
      }
    }
    if (Object.keys(columnsByTable).length === 0) {
      throw new Error(failures.join(" ") || "Could not read any of the named tables.");
    }
    // Partial success still helps; the tables that failed are said out loud.
    if (failures.length) setError(failures.join(" "));
    return { tables: selectedTables, columnsByTable };
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    setTableListUnavailable(false);
    try {
      const result = await fetchSupabaseIntrospection(projectUrl, anonKey, schema);
      setIntrospection(result);
      onPatch({ column_catalog: catalogPatch(result, selectedTables) });
    } catch (cause) {
      if (cause instanceof TableListUnavailableError && selectedTables.length > 0) {
        // The listing is gated, not the data: fall back to sampling the tables
        // the operator has already named.
        try {
          const sampled = await sampleTypedTables();
          setIntrospection(sampled);
          setTableListUnavailable(true);
          onPatch({ column_catalog: catalogPatch(sampled, selectedTables) });
        } catch (sampleCause) {
          setIntrospection(null);
          setError(sampleCause instanceof Error ? sampleCause.message : "Could not read the project.");
        }
      } else {
        setIntrospection(null);
        setError(cause instanceof Error ? cause.message : "Could not read the project.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed border-input p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs flex items-center gap-1.5">
          <Table2 className="w-3.5 h-3.5" />
          Pick tables & columns from the project
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={!ready || loading}
          onClick={load}
        >
          {loading
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />}
          <span className="ml-1">{introspection ? "Reload" : "Load from project"}</span>
        </Button>
      </div>

      {!ready && (
        <p className="text-[10px] text-muted-foreground">
          Enter the project URL and anon key above first. For a saved connector the key is
          never shown back, so re-enter it to use the pickers — or keep typing the fields by
          hand.
        </p>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
      {!introspection && view && (
        <p className="text-[10px] text-muted-foreground">
          {parseCatalog(columnCatalog)
            ? "Showing the tables and columns as last read from the project, with the saved selection ticked. Load from project to refresh."
            : "Showing the saved selection only. Load from project to see the other tables and columns."}
        </p>
      )}
      {tableListUnavailable && (
        <p className="text-[10px] text-muted-foreground">
          This project only lists tables to its service_role key, so the table names come from
          the field above — columns below were read live from each table.
        </p>
      )}

      {view && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">
              Tables ({selectedTables.length} selected)
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-40 overflow-y-auto">
              {view.tables.map((table) => (
                <label key={table} className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={selectedTables.includes(table)}
                    onCheckedChange={() =>
                      onPatch(patchTables(toggled(selectedTables, table)))}
                  />
                  <span className="truncate font-mono">{table}</span>
                </label>
              ))}
            </div>
          </div>

          {selectedTables.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-medium text-muted-foreground">
                Columns the AI agent reads, per table
              </p>
              {selectedTables.map((table) => (
                <div key={table} className="space-y-1">
                  <p className="text-[10px] font-mono text-muted-foreground">
                    {table} ({columnsFor(table).length === 0 ? "all" : columnsFor(table).length}
                    {" selected"})
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-32 overflow-y-auto">
                    {(view.columnsByTable[table] ?? []).map((column) => (
                      <label
                        key={`${table}.${column}`}
                        className="flex items-center gap-2 text-xs cursor-pointer"
                      >
                        <Checkbox
                          aria-label={`${table}.${column}`}
                          checked={columnsFor(table).includes(column)}
                          onCheckedChange={() => emitMap(table, column)}
                        />
                        <span className="truncate font-mono">{column}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground">
                Deselecting every column for a table stops the agent reading that table at
                all. To let a table return all its columns again, clear the column map field.
                Fewer columns means smaller prompts and cheaper replies.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
