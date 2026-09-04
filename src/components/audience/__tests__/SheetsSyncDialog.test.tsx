import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listGoogleSheetsConnections = vi.fn();
const syncContactsToSheet = vi.fn();
const toasts: Array<{ title?: string; description?: string; variant?: string }> = [];
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return {
    ...actual,
    listGoogleSheetsConnections: (...a: unknown[]) => listGoogleSheetsConnections(...a),
    syncContactsToSheet: (...a: unknown[]) => syncContactsToSheet(...a),
  };
});
vi.mock("@/hooks/use-toast", () => ({
  toast: (t: { title?: string; description?: string; variant?: string }) => toasts.push(t),
  useToast: () => ({ toast: vi.fn() }),
}));

import { SheetsSyncDialog } from "../SheetsSyncDialog";

beforeEach(() => {
  listGoogleSheetsConnections.mockReset();
  syncContactsToSheet.mockReset();
  toasts.length = 0;
});

describe("SheetsSyncDialog", () => {
  it("syncs the given contact ids through the selected connection and toasts the appended count", async () => {
    listGoogleSheetsConnections.mockResolvedValue([
      { id: "conn-1", external_account_label: "Growth sheets" },
      { id: "conn-2", external_account_label: null },
    ]);
    syncContactsToSheet.mockResolvedValue(2);
    const onClose = vi.fn();
    render(<SheetsSyncDialog contactIds={["a", "b"]} onClose={onClose} />);

    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "1AbC_spreadsheet" } });
    fireEvent.change(screen.getByLabelText("Sheet name"), { target: { value: "Audience" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));

    await waitFor(() => expect(syncContactsToSheet).toHaveBeenCalledWith({
      connection_id: "conn-1",
      spreadsheet_id: "1AbC_spreadsheet",
      sheet_name: "Audience",
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
    syncContactsToSheet.mockResolvedValue(1);
    render(<SheetsSyncDialog contactIds={["a"]} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Backup")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Backup" }));
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "sheet-id" } });
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
    syncContactsToSheet.mockRejectedValue(new Error("forbidden"));
    const onClose = vi.fn();
    render(<SheetsSyncDialog contactIds={["a"]} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("Growth sheets")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "sheet-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(toasts.some((t) => t.variant === "destructive")).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
  });
});
