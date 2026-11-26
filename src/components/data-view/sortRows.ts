export type DataViewSortDirection = "ascending" | "descending";

export function sortRows<Row>(
  rows: readonly Row[],
  accessor: (row: Row) => unknown,
  direction: DataViewSortDirection,
  collator: Intl.Collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
): Row[] {
  const factor = direction === "ascending" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftValue = accessor(left.row);
    const rightValue = accessor(right.row);
    const leftMissing = leftValue === null || leftValue === undefined ||
      (typeof leftValue === "number" && Number.isNaN(leftValue));
    const rightMissing = rightValue === null || rightValue === undefined ||
      (typeof rightValue === "number" && Number.isNaN(rightValue));
    if (leftMissing || rightMissing) {
      if (leftMissing && rightMissing) return left.index - right.index;
      return leftMissing ? 1 : -1;
    }
    let comparison = 0;
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      comparison = leftValue - rightValue;
    } else if (typeof leftValue === "string" && typeof rightValue === "string") {
      comparison = collator.compare(leftValue, rightValue);
    } else {
      comparison = collator.compare(String(leftValue), String(rightValue));
    }
    return comparison === 0 ? left.index - right.index : comparison * factor;
  }).map(({ row }) => row);
}
