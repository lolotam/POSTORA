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
  onPatch: (patch: Record<string, string>) => void;
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

  // Columns are offered per SELECTED table. Unioning them was wrong once a
  // connector allowed two tables: picking products.price and orders.total sent
  // "price,total" to BOTH, so each query failed on the column its table lacks,
  // and adding a second table broke access that already worked.
  const columnsByTable: Record<string, string[]> = introspection
    ? Object.fromEntries(
      selectedTables.map((table) => [table, introspection.columnsByTable[table] ?? []]),
    )
    : {};

  const parsedMap = parseColumnMap(columnMap);

  const columnsFor = (table: string): string[] => {
    const mapped = parsedMap[table];
    // "*" means the operator explicitly left this table unrestricted.
    if (mapped && mapped.length === 1 && mapped[0] === "*") return [];
    if (mapped) return mapped;
    // Before any per-table choice exists, the flat list is what applies.
    return selectedColumns;
  };

  // The adapter refuses any table an active map does not name, so narrowing one
  // table must not silently deny the others. Every allowed table is therefore
  // always represented: narrowed ones by their column list, the rest by "*",
  // which the adapter reads as "no restriction on this table".
  const emitMap = (table: string, column: string) => {
    const chosen: Record<string, string[]> = {};
    for (const allowed of selectedTables) {
      const columns = allowed === table ? toggled(columnsFor(allowed), column) : columnsFor(allowed);
      if (columns.length > 0) chosen[allowed] = columns;
    }
    if (Object.keys(chosen).length === 0) {
      // Nothing is narrowed any more, so there is no map to enforce. "{}"
      // rather than "" because a blank value is dropped before save and the
      // old restriction would survive the settings merge.
      onPatch({ column_map: "{}" });
      return;
    }
    const next: Record<string, string[] | string> = { ...chosen };
    for (const allowed of selectedTables) {
      if (!(allowed in chosen)) next[allowed] = "*";
    }
    onPatch({ column_map: JSON.stringify(next) });
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
      setIntrospection(await fetchSupabaseIntrospection(projectUrl, anonKey, schema));
    } catch (cause) {
      if (cause instanceof TableListUnavailableError && selectedTables.length > 0) {
        // The listing is gated, not the data: fall back to sampling the tables
        // the operator has already named.
        try {
          setIntrospection(await sampleTypedTables());
          setTableListUnavailable(true);
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
      {tableListUnavailable && (
        <p className="text-[10px] text-muted-foreground">
          This project only lists tables to its service_role key, so the table names come from
          the field above — columns below were read live from each table.
        </p>
      )}

      {introspection && (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">
              Tables ({selectedTables.length} selected)
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-40 overflow-y-auto">
              {introspection.tables.map((table) => (
                <label key={table} className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={selectedTables.includes(table)}
                    onCheckedChange={() =>
                      onPatch({ table_allow_list: toggled(selectedTables, table).join(", ") })}
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
                    {(columnsByTable[table] ?? []).map((column) => (
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
                Selecting none for a table returns every column it has. Fewer columns means
                smaller prompts and cheaper replies.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
