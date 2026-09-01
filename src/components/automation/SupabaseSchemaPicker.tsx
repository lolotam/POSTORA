import { useState } from "react";
import { Loader2, RefreshCw, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  fetchSupabaseIntrospection,
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
  onPatch: (patch: Record<string, string>) => void;
}

function parseList(value: string): string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
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
  onPatch,
}: SupabaseSchemaPickerProps) {
  const [introspection, setIntrospection] = useState<SupabaseIntrospection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = projectUrl.trim().length > 0 && anonKey.trim().length > 0;
  const selectedTables = parseList(tableAllowList);
  const selectedColumns = parseList(selectColumns);

  // Columns are offered from the SELECTED tables only; with none selected yet,
  // every table's columns would be one undifferentiated pile.
  const offeredColumns = introspection
    ? [...new Set(
      selectedTables.flatMap((table) => introspection.columnsByTable[table] ?? []),
    )]
    : [];

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setIntrospection(await fetchSupabaseIntrospection(projectUrl, anonKey, schema));
    } catch (cause) {
      setIntrospection(null);
      setError(cause instanceof Error ? cause.message : "Could not read the project.");
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
            <div className="space-y-1">
              <p className="text-[10px] font-medium text-muted-foreground">
                Columns the AI agent reads ({selectedColumns.length === 0
                  ? "all"
                  : selectedColumns.length} selected)
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-40 overflow-y-auto">
                {offeredColumns.map((column) => (
                  <label key={column} className="flex items-center gap-2 text-xs cursor-pointer">
                    <Checkbox
                      checked={selectedColumns.includes(column)}
                      onCheckedChange={() =>
                        onPatch({ select_columns: toggled(selectedColumns, column).join(", ") })}
                    />
                    <span className="truncate font-mono">{column}</span>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Selecting none returns every column. Fewer columns means smaller prompts and
                cheaper replies.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
