import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseSchemaPicker } from "@/components/automation/SupabaseSchemaPicker";

// The dropdown upgrade for the Supabase card: the project's own tables and
// columns are OFFERED, and selections are written back into the same
// comma-joined text fields the adapter already parses. Free text remains the
// source of truth — this component must never be required for a save to work.

const { fetchSupabaseIntrospection, fetchTableColumns, TableListUnavailableError } = vi.hoisted(
  () => ({
    fetchSupabaseIntrospection: vi.fn(),
    fetchTableColumns: vi.fn(),
    TableListUnavailableError: class TableListUnavailableError extends Error {},
  }),
);
vi.mock("@/lib/supabaseIntrospection", () => ({
  fetchSupabaseIntrospection,
  fetchTableColumns,
  TableListUnavailableError,
}));

const INTROSPECTION = {
  tables: ["orders", "price_table"],
  columnsByTable: {
    price_table: ["id", "type_name", "price", "image_url"],
    orders: ["id", "total"],
  },
};

function renderPicker(overrides: Partial<Parameters<typeof SupabaseSchemaPicker>[0]> = {}) {
  const onPatch = vi.fn();
  render(
    <SupabaseSchemaPicker
      projectUrl="https://proj.supabase.co"
      anonKey="anon-1"
      schema="public"
      tableAllowList=""
      selectColumns=""
      onPatch={onPatch}
      {...overrides}
    />,
  );
  return onPatch;
}

beforeEach(() => {
  cleanup();
  fetchSupabaseIntrospection.mockReset();
  fetchSupabaseIntrospection.mockResolvedValue(INTROSPECTION);
});

describe("SupabaseSchemaPicker", () => {
  it("does not offer the pickers until the key is present, and says why", () => {
    renderPicker({ anonKey: "" });
    expect(screen.getByRole("button", { name: /load from project/i })).toBeDisabled();
    // The saved-connector case: the anon key is never returned to the browser.
    expect(screen.getByText(/re-enter it to use the pickers/i)).toBeInTheDocument();
  });

  it("loads the project's tables on demand, never automatically", async () => {
    renderPicker();
    // No fetch on mount: introspection runs against a third-party project and
    // must be the user's explicit action, not a keystroke side effect.
    expect(fetchSupabaseIntrospection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() => expect(screen.getByText("price_table")).toBeInTheDocument());
    expect(fetchSupabaseIntrospection).toHaveBeenCalledWith(
      "https://proj.supabase.co",
      "anon-1",
      "public",
    );
  });

  it("checking a table writes the comma-joined allow-list the adapter parses", async () => {
    const onPatch = renderPicker({ tableAllowList: "orders" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() => expect(screen.getByText("price_table")).toBeInTheDocument());

    fireEvent.click(screen.getByText("price_table"));
    expect(onPatch).toHaveBeenCalledWith({ table_allow_list: "orders, price_table" });
  });

  it("unchecking removes only that table", async () => {
    const onPatch = renderPicker({ tableAllowList: "orders, price_table" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());

    fireEvent.click(screen.getByText("orders"));
    expect(onPatch).toHaveBeenCalledWith({ table_allow_list: "price_table" });
  });

  it("offers only the selected tables' columns and writes select_columns", async () => {
    const onPatch = renderPicker({ tableAllowList: "price_table" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() => expect(screen.getByText("type_name")).toBeInTheDocument());

    // orders' columns are not offered while orders is unselected.
    expect(screen.queryByText("total")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("price"));
    expect(onPatch).toHaveBeenCalledWith({ select_columns: "price" });
  });

  it("shows the introspection error instead of an empty picker", async () => {
    fetchSupabaseIntrospection.mockRejectedValue(
      new Error('Schema "privates" is not exposed by this project. Try "public".'),
    );
    renderPicker({ schema: "privates" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() =>
      expect(screen.getByText(/"privates" is not exposed/)).toBeInTheDocument()
    );
    expect(screen.queryByText("price_table")).not.toBeInTheDocument();
  });
});


describe("service_role-gated projects (Supabase Cloud)", () => {
  // Discovered live: a working anon key gets 401 from the table-listing root
  // with "Only the `service_role` API key can be used for this endpoint."
  // The picker must fall back to sampling the tables the operator typed --
  // not blame the key, which sent a real operator hunting a typo that did not
  // exist (2026-09-01).
  it("falls back to per-table column sampling for typed tables", async () => {
    fetchSupabaseIntrospection.mockRejectedValue(new TableListUnavailableError());
    fetchTableColumns.mockResolvedValue(["id", "type_name", "price"]);

    renderPicker({ tableAllowList: "price_table" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));

    await waitFor(() => expect(screen.getByText("type_name")).toBeInTheDocument());
    expect(fetchTableColumns).toHaveBeenCalledWith(
      "https://proj.supabase.co",
      "anon-1",
      "public",
      "price_table",
    );
    expect(screen.getByText(/only lists tables to its service_role key/i)).toBeInTheDocument();
    // The key is NOT blamed.
    expect(screen.queryByText(/refused the anon key/i)).not.toBeInTheDocument();
  });

  it("with no typed tables it explains what to do instead of failing silently", async () => {
    fetchSupabaseIntrospection.mockRejectedValue(
      new TableListUnavailableError(
        "This project does not expose its table list to the anon key. Type the table names, then load their columns.",
      ),
    );
    renderPicker({ tableAllowList: "" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));
    await waitFor(() =>
      expect(screen.getByText(/type the table names/i)).toBeInTheDocument()
    );
  });

  it("a table that fails to sample is reported while the others still load", async () => {
    fetchSupabaseIntrospection.mockRejectedValue(new TableListUnavailableError());
    fetchTableColumns
      .mockResolvedValueOnce(["id", "price"])
      .mockRejectedValueOnce(new Error('Table "stock" was not found in schema "public".'));

    renderPicker({ tableAllowList: "price_table, stock" });
    fireEvent.click(screen.getByRole("button", { name: /load from project/i }));

    await waitFor(() => expect(screen.getByText("price")).toBeInTheDocument());
    expect(screen.getByText(/"stock" was not found/)).toBeInTheDocument();
  });
});
