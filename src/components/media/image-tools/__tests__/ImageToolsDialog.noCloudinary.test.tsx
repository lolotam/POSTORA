import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_CDN_STORAGE_CONFIG } from "@/lib/cdnConfig";
import { AiImageToolError, PROVIDER_UNAVAILABLE_CODE } from "../aiImageTools";
import { ImageToolsDialog } from "../ImageToolsDialog";

const toast = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const runBackgroundRemoval = vi.hoisted(() => vi.fn());
const runUpscale = vi.hoisted(() => vi.fn());
const completeOperation = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke }, from: vi.fn() } }));
vi.mock("@/hooks/useFeatureFlags", () => ({ useFeatureFlags: () => ({ flags: { atlascloudUpscale: false } }) }));
vi.mock("@/hooks/useMediaOperationsHistory", () => ({
  useLogMediaOperation: () => ({ logOperation: vi.fn().mockResolvedValue("op-1"), completeOperation, failOperation: vi.fn() }),
}));
// The default policy writes to Openinary only, i.e. Cloudinary is not serving transforms.
vi.mock("@/hooks/useCdnConfig", () => ({ useCdnConfig: () => ({ data: DEFAULT_CDN_STORAGE_CONFIG }) }));
vi.mock("../aiImageTools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../aiImageTools")>()),
  runBackgroundRemoval,
  runUpscale,
}));

const file = {
  id: "file-1",
  publicUrl: "https://o.example/t/postora.cloud/u/photo.jpg",
  storage_bucket: "openinary",
  file_path: "u/photo.jpg",
};

function renderDialog() {
  render(<ImageToolsDialog open onClose={() => {}} file={file} cloudName="" />);
}

// FeatureToggles renders the switches in this order.
const SWITCH = { bgRemoval: 0, resize: 1, upscale: 2, filters: 3, quality: 4 } as const;

describe("ImageToolsDialog while Cloudinary is not serving transforms", () => {
  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
    runBackgroundRemoval.mockReset();
    runUpscale.mockReset();
    completeOperation.mockReset();
  });

  it("removes the background on the server from the file's public URL, without any Cloudinary upload", async () => {
    runBackgroundRemoval.mockResolvedValue("https://o.example/t/processed/photo.png");
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /Process Image/ }));

    await waitFor(() => expect(screen.getByAltText("Processed")).toHaveAttribute("src", "https://o.example/t/processed/photo.png"));
    expect(runBackgroundRemoval).toHaveBeenCalledWith(file.publicUrl);
    expect(runUpscale).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled(); // no cloudinary-upload staging
    expect(completeOperation).toHaveBeenCalledWith("op-1", "https://o.example/t/processed/photo.png", expect.any(Number));
  });

  it("chains upscale after background removal, each step on the previous result", async () => {
    runBackgroundRemoval.mockResolvedValue("https://o.example/t/step1.png");
    runUpscale.mockResolvedValue("https://o.example/t/step2.jpg");
    renderDialog();

    fireEvent.click(screen.getAllByRole("switch")[SWITCH.upscale]);
    fireEvent.click(await screen.findByRole("button", { name: /Process Image/ }));

    await waitFor(() => expect(screen.getByAltText("Processed")).toHaveAttribute("src", "https://o.example/t/step2.jpg"));
    expect(runBackgroundRemoval).toHaveBeenCalledWith(file.publicUrl);
    expect(runUpscale).toHaveBeenCalledWith("https://o.example/t/step1.png");
  });

  it("offers upscale without a provider choice, even with the AtlasCloud flag off", async () => {
    renderDialog();
    fireEvent.click(screen.getAllByRole("switch")[SWITCH.upscale]);
    expect(await screen.findByText(/Uses AtlasCloud/)).toBeInTheDocument();
    expect(screen.queryByText("Upscale Platform")).not.toBeInTheDocument();
  });

  it("turns off the Cloudinary-only transforms instead of letting them fail later", () => {
    renderDialog();
    const switches = screen.getAllByRole("switch");
    expect(switches[SWITCH.resize]).toBeDisabled();
    expect(switches[SWITCH.filters]).toBeDisabled();
    expect(switches[SWITCH.quality]).toBeDisabled();
    expect(switches[SWITCH.bgRemoval]).toBeEnabled();
    expect(switches[SWITCH.upscale]).toBeEnabled();
  });

  it("says plainly when no AI provider is available", async () => {
    runBackgroundRemoval.mockRejectedValue(new AiImageToolError("Background removal is temporarily unavailable", PROVIDER_UNAVAILABLE_CODE));
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /Process Image/ }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "AI tool unavailable", description: "This AI tool is temporarily unavailable. Please try again later.", variant: "destructive" }),
      ),
    );
    expect(screen.queryByAltText("Processed")).not.toBeInTheDocument();
  });
});
