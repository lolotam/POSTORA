import { Grid3X3, LayoutList } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DataViewMode = "grid" | "table";

export function ViewModeToggle({ value, onChange, labels }: {
  value: DataViewMode;
  onChange: (value: DataViewMode) => void;
  labels: { viewMode: string; grid: string; table: string };
}) {
  return (
    <div role="group" className="flex rounded-md border p-0.5" aria-label={labels.viewMode}>
      <Button
        size="sm"
        variant={value === "grid" ? "secondary" : "ghost"}
        aria-label={labels.grid}
        aria-pressed={value === "grid"}
        onClick={() => onChange("grid")}
      >
        <Grid3X3 className="me-1.5 h-4 w-4" aria-hidden="true" />
        {labels.grid}
      </Button>
      <Button
        size="sm"
        variant={value === "table" ? "secondary" : "ghost"}
        aria-label={labels.table}
        aria-pressed={value === "table"}
        onClick={() => onChange("table")}
      >
        <LayoutList className="me-1.5 h-4 w-4" aria-hidden="true" />
        {labels.table}
      </Button>
    </div>
  );
}
