import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import AdminMediaCleanup from "../AdminMediaCleanup";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { count?: number }, options?: { count?: number }) => {
      const template = typeof fallback === "string" ? fallback : key;
      const count = options?.count ?? (typeof fallback === "object" ? fallback.count : undefined);
      return count === undefined ? template : template.replace("{{count}}", String(count));
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke } },
}));

describe("AdminMediaCleanup", () => {
  it("renders the retention contract", async () => {
    invoke.mockResolvedValue({
      data: {
        deleteEnabled: false,
        result: { warned: 4, due: 2, deleted: 0, failed: 0, backlog: 2 },
        filesToDelete: [{ id: "file-1", action: "would_warn" }],
      },
      error: null,
    });
    render(<AdminMediaCleanup />);
    expect(screen.getByText(/Each account chooses 7, 30 or 90 days/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByText("Warned")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    expect(screen.getByText("file-1")).toBeInTheDocument();
    expect(screen.getByTestId("delete-switch-state")).toHaveTextContent("Deletion paused by admin");
    expect(invoke).toHaveBeenCalledWith("cleanup-media", { body: { dryRun: true } });
  });

  it.each([
    ["enabled", "Deletion enabled"],
    ["disabled", "Deletion paused by admin"],
    ["unknown", "Deletion switch unreadable — nothing will be deleted"],
  ] as const)("shows the %s deletion switch", async (deleteState, label) => {
    invoke.mockResolvedValue({
      data: { deleteState, deleteEnabled: deleteState === "enabled", result: { warned: 0, due: 0, deleted: 0, failed: 0, backlog: 0 }, filesToDelete: [] },
      error: null,
    });
    render(<AdminMediaCleanup />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByTestId("delete-switch-state")).toHaveTextContent(label);
  });
});
