import type { GridColumns } from "./gridColumns";

export function GridColumnControls({ value, onChange, perRowLabel }: {
  value: GridColumns;
  onChange: (value: GridColumns) => void;
  perRowLabel: (count: GridColumns) => string;
}) {
  return (
    <div role="group" className="flex items-center gap-1 rounded-md border p-0.5">
      {([4, 5, 6] as const).map((columns) => (
        <button
          key={columns}
          type="button"
          aria-label={perRowLabel(columns)}
          aria-pressed={value === columns}
          onClick={() => onChange(columns)}
          className={`rounded px-2 py-1 text-xs font-medium tabular-nums ${
            value === columns ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {columns}
        </button>
      ))}
    </div>
  );
}
