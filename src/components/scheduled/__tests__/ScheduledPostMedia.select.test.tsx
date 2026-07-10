import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduledPostMedia } from "../ScheduledPostMedia";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn().mockResolvedValue({
            data: [{
              id: "media-nested",
              file_path: "https://example.com/nested.jpg",
              file_type: "image",
              storage_bucket: "cloudinary",
              folder_path: "/Campaign/Launch",
            }],
            error: null,
          }),
        })),
      })),
    })),
    storage: { from: vi.fn() },
  },
}));

describe("ScheduledPostMedia folder Select", () => {
  it("displays the matching folder name while retaining its path as the controlled value", async () => {
    render(
      <ScheduledPostMedia
        mediaFileIds={["media-nested"]}
        mediaFolders={[
          { id: "folder-1", name: "Launch", full_path: "/Campaign/Launch" },
        ]}
        userId="user-1"
        onOpen={vi.fn()}
      />,
    );

    const folderSelect = await screen.findByRole("combobox", { name: "Media folder" });
    await waitFor(() => expect(folderSelect).toHaveTextContent("Launch"));
    expect(folderSelect).not.toHaveTextContent("/Campaign/Launch");
  });
});
