import type { DataViewSortDirection } from "./sortRows";

export function SortableColumnHeader({ label, direction, defaultDirection = "ascending", onSort, className = "" }: {
  label: string;
  direction: DataViewSortDirection | null;
  defaultDirection?: DataViewSortDirection;
  onSort: (direction: DataViewSortDirection) => void;
  className?: string;
}) {
  const nextDirection = direction === null
    ? defaultDirection
    : direction === "ascending"
    ? "descending"
    : "ascending";
  return (
    <th aria-sort={direction ?? "none"} className={`p-3 text-start ${className}`}>
      <button type="button" className="inline-flex items-center gap-1 font-medium hover:text-primary" onClick={() => onSort(nextDirection)}>
        <span>{label}</span>
        <span aria-hidden="true">{direction === "ascending" ? "▲" : direction === "descending" ? "▼" : ""}</span>
      </button>
    </th>
  );
}
