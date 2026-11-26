import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SortableColumnHeader } from "../SortableColumnHeader";
import { ViewModeToggle } from "../ViewModeToggle";

describe("data view controls", () => {
  it("exposes sort state and chooses the first direction by data type", () => {
    const onSort = vi.fn();
    const { rerender } = render(<table><thead><tr><SortableColumnHeader label="Views" direction={null} defaultDirection="descending" onSort={onSort} /></tr></thead></table>);
    expect(screen.getByRole("columnheader")).toHaveAttribute("aria-sort", "none");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(onSort).toHaveBeenLastCalledWith("descending");
    rerender(<table><thead><tr><SortableColumnHeader label="Views" direction="descending" onSort={onSort} /></tr></thead></table>);
    expect(screen.getByRole("columnheader")).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(onSort).toHaveBeenLastCalledWith("ascending");
  });

  it("marks the selected view as pressed", () => {
    render(<ViewModeToggle value="grid" onChange={vi.fn()} labels={{ viewMode: "View mode", grid: "Grid", table: "Table" }} />);
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "false");
  });
});
