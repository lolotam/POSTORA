import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_CDN_STORAGE_CONFIG } from "@/lib/cdnConfig";
import { AiImageToolError, PROVIDER_UNAVAILABLE_CODE } from "@/components/media/image-tools/aiImageTools";
import { BackgroundRemovalDialog } from "../BackgroundRemovalDialog";

const toast = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const runBackgroundRemoval = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke }, from: vi.fn() } }));
// The default policy writes to Openinary only, i.e. Cloudinary is not serving transforms.
vi.mock("@/hooks/useCdnConfig", () => ({ useCdnConfig: () => ({ data: DEFAULT_CDN_STORAGE_CONFIG }) }));
vi.mock("@/components/media/image-tools/aiImageTools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/media/image-tools/aiImageTools")>()),
  runBackgroundRemoval,
}));

const file = {
  id: "file-1",
  publicUrl: "https://o.example/t/postora.cloud/u/photo.jpg",
  storage_bucket: "openinary",
  file_path: "u/photo.jpg",
};

function renderDialog() {
  render(<BackgroundRemovalDialog open onClose={() => {}} file={file} cloudName="" />);
}

describe("BackgroundRemovalDialog while Cloudinary is not serving transforms", () => {
  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
    runBackgroundRemoval.mockReset();
  });

  it("removes the background on the server from the file's public URL, without any Cloudinary upload", async () => {
    runBackgroundRemoval.mockResolvedValue("https://o.example/t/processed/photo.png");
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Remove Background/ }));

    await waitFor(() => expect(screen.getByAltText("Processed")).toHaveAttribute("src", "https://o.example/t/processed/photo.png"));
    expect(runBackgroundRemoval).toHaveBeenCalledWith(file.publicUrl);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("explains that edge quality and resize are not available instead of showing controls that would be ignored", () => {
    renderDialog();
    expect(screen.getByText(/Edge quality and resize are not available right now/)).toBeInTheDocument();
    expect(screen.queryByText("This file will be automatically uploaded to Cloudinary for background removal processing.")).not.toBeInTheDocument();
    // The settings grid is kept out of the layout, not just out of sight.
    expect(screen.getByText("Edge Quality").closest("div.hidden")).not.toBeNull();
  });

  it("says plainly when no AI provider is available", async () => {
    runBackgroundRemoval.mockRejectedValue(new AiImageToolError("Background removal is temporarily unavailable", PROVIDER_UNAVAILABLE_CODE));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Remove Background/ }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI tool unavailable", description: "This AI tool is temporarily unavailable. Please try again later.", variant: "destructive" }),
      ),
    );
    expect(screen.queryByAltText("Processed")).not.toBeInTheDocument();
  });
});
