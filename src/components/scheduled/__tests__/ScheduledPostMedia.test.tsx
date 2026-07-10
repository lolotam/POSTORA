import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduledPostMedia } from "../ScheduledPostMedia";
import { supabase } from "@/integrations/supabase/client";

const toast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    storage: { from: vi.fn() },
  },
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, disabled }: any) => (
    <button
      aria-label="Media folder"
      data-folder-value={value}
      disabled={disabled}
      onClick={() => onValueChange("/Campaign")}
    >
      {value}
    </button>
  ),
  SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
}));

const rows = Array.from({ length: 5 }, (_, index) => ({
  id: `media-${index + 1}`,
  file_path: `https://example.com/${index + 1}.jpg`,
  file_type: "image",
  storage_bucket: "cloudinary",
  folder_path: "/",
}));

function mockMediaLoad(
  updateResult = { data: rows.map(({ id }) => ({ id })), error: null as null | Error },
  mediaRows = rows,
) {
  const selectUpdate = vi.fn().mockResolvedValue(updateResult);
  const inUpdate = vi.fn().mockReturnValue({ select: selectUpdate });
  const eqUpdate = vi.fn().mockReturnValue({ in: inUpdate });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });
  const inSelect = vi.fn().mockResolvedValue({ data: mediaRows, error: null });
  const eqSelect = vi.fn().mockReturnValue({ in: inSelect });
  const select = vi.fn().mockReturnValue({ eq: eqSelect });
  (supabase.from as any).mockReturnValue({ select, update });
  return { update, eqUpdate, inUpdate, selectUpdate };
}

describe("ScheduledPostMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every resolved carousel item without an overflow tile", async () => {
    mockMediaLoad();
    render(
      <ScheduledPostMedia
        mediaFileIds={rows.map((row) => row.id)}
        mediaFolders={[]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    expect(await screen.findAllByRole("button", { name: "View image" })).toHaveLength(5);
    expect(screen.queryByText("+1")).not.toBeInTheDocument();
  });

  it("updates every media ID and changes local folder state only on success", async () => {
    const { update, eqUpdate, inUpdate } = mockMediaLoad();
    render(
      <ScheduledPostMedia
        mediaFileIds={rows.map((row) => row.id)}
        mediaFolders={[{ id: "folder-1", name: "Campaign", full_path: "/Campaign" }]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/"));
    fireEvent.click(screen.getByLabelText("Media folder"));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ folder_path: "/Campaign" }));
    expect(eqUpdate).toHaveBeenCalledWith("user_id", "user-1");
    expect(inUpdate).toHaveBeenCalledWith("id", rows.map((row) => row.id));
    expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/Campaign");
  });

  it("preserves the previous folder label when moving media fails", async () => {
    const failureRows = rows.map((row) => ({ ...row, id: `failure-${row.id}` }));
    mockMediaLoad({ data: null, error: new Error("move failed") }, failureRows);
    render(
      <ScheduledPostMedia
        mediaFileIds={failureRows.map((row) => row.id)}
        mediaFolders={[{ id: "folder-1", name: "Campaign", full_path: "/Campaign" }]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/"));
    fireEvent.click(screen.getByLabelText("Media folder"));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
    expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/");
  });

  it("preserves folder state when only some expected media rows are updated", async () => {
    const partialRows = rows.map((row) => ({ ...row, id: `partial-${row.id}` }));
    mockMediaLoad({ data: [{ id: partialRows[0].id }], error: null }, partialRows);
    render(
      <ScheduledPostMedia
        mediaFileIds={partialRows.map((row) => row.id)}
        mediaFolders={[{ id: "folder-1", name: "Campaign", full_path: "/Campaign" }]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/"));
    fireEvent.click(screen.getByLabelText("Media folder"));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
    expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/");
  });

  it("reloads folder paths from the database when cached URLs are reused", async () => {
    const freshRows = rows.map((row) => ({ ...row, id: `fresh-${row.id}` }));
    mockMediaLoad(undefined, freshRows);
    const { unmount } = render(
      <ScheduledPostMedia
        mediaFileIds={freshRows.map((row) => row.id)}
        mediaFolders={[{ id: "folder-1", name: "Campaign", full_path: "/Campaign" }]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/"));
    unmount();

    const movedRows = freshRows.map((row) => ({ ...row, folder_path: "/Campaign" }));
    mockMediaLoad(undefined, movedRows);
    render(
      <ScheduledPostMedia
        mediaFileIds={freshRows.map((row) => row.id)}
        mediaFolders={[{ id: "folder-1", name: "Campaign", full_path: "/Campaign" }]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Media folder")).toHaveAttribute("data-folder-value", "/Campaign"));
  });
});
