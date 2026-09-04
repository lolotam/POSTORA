import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listGoogleSheetsConnections = vi.fn();
const fetchSpreadsheetInfo = vi.fn();
const syncContactsToSheet = vi.fn();
const toasts: Array<{ title?: string; description?: string; variant?: string }> = [];
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return {
    ...actual,
    listGoogleSheetsConnections: (...a: unknown[]) => listGoogleSheetsConnections(...a),
    fetchSpreadsheetInfo: (...a: unknown[]) => fetchSpreadsheetInfo(...a),
    syncContactsToSheet: (...a: unknown[]) => syncContactsToSheet(...a),
  };
});
vi.mock("@/hooks/use-toast", () => ({
  toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t),
  useToast: () => ({ toast: vi.fn() }),
}));

import { SheetsSyncDialog } from "../SheetsSyncDialog";

const TABS = { spreadsheet_title: "Audience export", sheets: ["Sheet1", "Contacts 2026"] };

beforeEach(() => {
  listGoogleSheetsConnections.mockReset();
  fetchSpreadsheetInfo.mockReset();
  syncContactsToSheet.mockReset();
  toasts.length = 0;
});

/** Types the id, checks it, and waits for the tab select to render. */
async function loadTabs() {
  fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "1AbC_spreadsheet" } });
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());
}

/** Opens the radix select and picks a tab by its rendered option. */
async function chooseTab(name: string) {
  const trigger = screen.getByRole("combobox");
  fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: "mouse" });
  fireEvent.click(trigger);
  const option = await waitFor(() => screen.getByRole("option", { name }));
  fireEvent.click(option);
}

describe("SheetsSyncDialog", () => {
  it("syncs through the selected connection with a tab chosen from the real spreadsheet", async () => {
    listGoogleSheetsConnections.mockResolvedValue([
      { id: "conn-1", external_account_label: "Growth sheets" },
      { id: "conn-2", external_account_label: null },
    ]);
    fetchSpreadsheetInfo.mockResolvedValue(TABS);
    syncContactsToSheet.mockResolvedValue(2);
    const onClose = vi.fn();
    render(<SheetsSyncDialog contactIds={["a", "b"]} onClose={onClose} />);

    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    await loadTabs();
    expect(fetchSpreadsheetInfo).toHaveBeenCalledWith({
      connection_id: "conn-1",
      spreadsheet_id: "1AbC_spreadsheet",
    });
    // The spreadsheet's own title confirms the id was read correctly, and the
    // first real tab is preselected.
    expect(screen.getByText(/Audience export/)).toBeInTheDocument();
    expect(screen.getByRole("combobox").textContent).toContain("Sheet1");
    await chooseTab("Contacts 2026");
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(syncContactsToSheet).toHaveBeenCalledWith({
      connection_id: "conn-1",
      spreadsheet_id: "1AbC_spreadsheet",
      sheet_name: "Contacts 2026",
      contact_ids: ["a", "b"],
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toasts.some((t) => t.title === "Appended 2 rows to the sheet")).toBe(true);
  });

  it("selects another connection when its button is pressed", async () => {
    listGoogleSheetsConnections.mockResolvedValue([
      { id: "conn-1", external_account_label: "Growth sheets" },
      { id: "conn-2", external_account_label: "Backup" },
    ]);
    fetchSpreadsheetInfo.mockResolvedValue(TABS);
    syncContactsToSheet.mockResolvedValue(1);
    render(<SheetsSyncDialog contactIds={["a"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Backup")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    await loadTabs();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() =>
      expect(syncContactsToSheet).toHaveBeenCalledWith(expect.objectContaining({ connection_id: "conn-2" })));
  });

  it("shows the connect-first message when there is no active connection", async () => {
    listGoogleSheetsConnections.mockResolvedValue([]);
    render(<SheetsSyncDialog contactIds={["a"]} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/No active Google Sheets connection/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
  });

  it("toasts destructively when the sync fails and keeps the dialog open", async () => {
    listGoogleSheetsConnections.mockResolvedValue([{ id: "conn-1", external_account_label: "Growth sheets" }]);
    fetchSpreadsheetInfo.mockResolvedValue(TABS);
    syncContactsToSheet.mockRejectedValue(new Error("forbidden"));
    const onClose = vi.fn();
    render(<SheetsSyncDialog contactIds={["a"]} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    await loadTabs();
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(toasts.some((t) => t.variant === "destructive")).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
  });

  // A failed lookup must not look like a spreadsheet with no tabs: the alert
  // names the reason and Sync stays disabled until a tab is actually chosen.
  it("words an unreadable spreadsheet id clearly and never offers tabs", async () => {
    listGoogleSheetsConnections.mockResolvedValue([{ id: "conn-1", external_account_label: "Growth sheets" }]);
    fetchSpreadsheetInfo.mockRejectedValue(new Error("composio_failed"));
    render(<SheetsSyncDialog contactIds={["a"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "not-a-spreadsheet" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toMatch(/not a spreadsheet this connection can read/i);
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.getByRole("button", { name: "Sync" })).toBeDisabled();
  });

  it("recovers from a failed lookup on a corrected id", async () => {
    listGoogleSheetsConnections.mockResolvedValue([{ id: "conn-1", external_account_label: "Growth sheets" }]);
    fetchSpreadsheetInfo
      .mockRejectedValueOnce(new Error("composio_failed"))
      .mockResolvedValueOnce(TABS);
    render(<SheetsSyncDialog contactIds={["a"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Correcting the id clears the error and offers the real tabs.
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "1AbC_spreadsheet" } });
    await loadTabs();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Sync" })).toBeEnabled();
  });
});
