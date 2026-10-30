import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_CDN_STORAGE_CONFIG } from "@/lib/cdnConfig";
import { AiImageToolError, PROVIDER_UNAVAILABLE_CODE } from "@/components/media/image-tools/aiImageTools";
import { BatchImageToolsDialog } from "../BatchImageToolsDialog";

const toast = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const runBackgroundRemoval = vi.hoisted(() => vi.fn());
const runUpscale = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke }, from: () => ({ update: () => ({ eq: update }) }) },
}));
// The default policy writes to Openinary only, i.e. Cloudinary is not serving transforms.
const cdnQuery = vi.hoisted(() => ({ current: {} as { data?: unknown; isLoading: boolean } }));
vi.mock("@/hooks/useCdnConfig", () => ({ useCdnConfig: () => cdnQuery.current }));
vi.mock("@/components/media/image-tools/aiImageTools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/media/image-tools/aiImageTools")>()),
  runBackgroundRemoval,
  runUpscale,
}));

const files = [
  { id: "a", publicUrl: "https://o.example/t/u/a.jpg", storage_bucket: "openinary", file_path: "u/a.jpg", folder_path: "trips" },
  { id: "b", publicUrl: "https://o.example/t/u/b.jpg", storage_bucket: "openinary", file_path: "u/b.jpg" },
];

// The batch dialog renders the switches in this order.
const SWITCH = { bgRemoval: 0, resize: 1, upscale: 2, filters: 3, quality: 4 } as const;

function renderDialog() {
  render(<BatchImageToolsDialog open onClose={() => {}} files={files} cloudName="" />);
}

const toggle = (index: number) => fireEvent.click(screen.getAllByRole("switch")[index]);
const processButton = () => screen.getByRole("button", { name: /^Process .* Images$/ });

describe("BatchImageToolsDialog while Cloudinary is not serving transforms", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
    update.mockReset();
    update.mockResolvedValue({ error: null });
    runBackgroundRemoval.mockReset();
    runUpscale.mockReset();
    fetchMock.mockReset();
    // The server path must not download results in the browser; any fetch is a failure.
    vi.stubGlobal("fetch", fetchMock);
    invoke.mockResolvedValue({ data: { success: true, mediaFileId: "new-media" }, error: null });
    cdnQuery.current = { data: DEFAULT_CDN_STORAGE_CONFIG, isLoading: false };
  });

  afterEach(() => vi.unstubAllGlobals());

  it("runs background removal then upscale on the server per file and saves only the final result", async () => {
    runBackgroundRemoval.mockImplementation(async (url: string) => `${url}?bg`);
    runUpscale.mockImplementation(async (url: string) => `${url}&up`);
    renderDialog();

    toggle(SWITCH.bgRemoval);
    toggle(SWITCH.upscale);
    fireEvent.click(processButton());

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(runBackgroundRemoval).toHaveBeenCalledWith(files[0].publicUrl);
    expect(runUpscale).toHaveBeenCalledWith(`${files[0].publicUrl}?bg`, { outputFormat: "png" });
    expect(runUpscale).toHaveBeenCalledWith(`${files[1].publicUrl}?bg`, { outputFormat: "png" });
    // The only cloudinary-upload calls are the final saves, never a staging copy. Each saves the
    // result by URL (streamed by the server, so no 10 MB base64 cap and no browser download), with
    // no extension in the name, so the type comes from the bytes (Openinary may deliver WebP).
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map(([, { body }]) => body.externalUrl).sort()).toEqual([`${files[0].publicUrl}?bg&up`, `${files[1].publicUrl}?bg&up`]);
    for (const [name, { body }] of invoke.mock.calls) {
      expect(name).toBe("cloudinary-upload");
      expect(body).not.toHaveProperty("skipMediaFiles");
      expect(body).not.toHaveProperty("fileData");
      expect(body.fileName).toMatch(/^[ab]_bg-removed-upscaled_\d+$/);
    }
    expect(update).toHaveBeenCalledTimes(1); // only file "a" has a folder to restore
  });

  it("upscale alone leaves the output format to the server", async () => {
    runUpscale.mockResolvedValue("https://o.example/t/up.png");
    renderDialog();

    toggle(SWITCH.upscale);
    fireEvent.click(processButton());

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(runBackgroundRemoval).not.toHaveBeenCalled();
    expect(runUpscale).toHaveBeenCalledWith(files[0].publicUrl, {});
  });

  it("disables the Cloudinary-only switches and says why", () => {
    renderDialog();
    const switches = screen.getAllByRole("switch");
    for (const index of [SWITCH.resize, SWITCH.filters, SWITCH.quality]) expect(switches[index]).toBeDisabled();
    expect(switches[SWITCH.bgRemoval]).toBeEnabled();
    expect(switches[SWITCH.upscale]).toBeEnabled();
    expect(screen.getByText(/Only background removal and upscale are available/)).toBeInTheDocument();
  });

  it("turns off switches that were on, and the Cloudinary-only edge and upscale modes, once transforms are confirmed unavailable", async () => {
    cdnQuery.current = { data: undefined, isLoading: true };
    const { rerender } = render(<BatchImageToolsDialog open onClose={() => {}} files={files} cloudName="" />);
    for (const index of [SWITCH.resize, SWITCH.filters, SWITCH.quality]) toggle(index);
    expect(screen.getAllByRole("switch")[SWITCH.resize]).toBeChecked();

    cdnQuery.current = { data: DEFAULT_CDN_STORAGE_CONFIG, isLoading: false };
    rerender(<BatchImageToolsDialog open onClose={() => {}} files={files} cloudName="" />);

    await waitFor(() => expect(screen.getAllByRole("switch")[SWITCH.resize]).not.toBeChecked());
    for (const index of [SWITCH.resize, SWITCH.filters, SWITCH.quality]) {
      expect(screen.getAllByRole("switch")[index]).not.toBeChecked();
    }
    // The edge-quality and upscale-mode selects cannot offer anything but "Standard" now.
    toggle(SWITCH.bgRemoval);
    toggle(SWITCH.upscale);
    for (const select of screen.getAllByRole("combobox")) expect(select).toBeDisabled();
  });

  it("does not guess while the CDN config is loading: Process waits and no notice claims anything", () => {
    cdnQuery.current = { data: undefined, isLoading: true };
    renderDialog();

    expect(processButton()).toBeDisabled();
    expect(screen.queryByText(/Only background removal and upscale are available/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")[SWITCH.resize]).toBeEnabled();
    expect(runBackgroundRemoval).not.toHaveBeenCalled();
  });

  it("says plainly which file hit an unavailable AI provider and keeps going with the others", async () => {
    runBackgroundRemoval
      .mockRejectedValueOnce(new AiImageToolError("Background removal is temporarily unavailable", PROVIDER_UNAVAILABLE_CODE))
      .mockResolvedValueOnce("https://o.example/t/b-cutout.png");
    renderDialog();

    toggle(SWITCH.bgRemoval);
    fireEvent.click(processButton());

    expect(await screen.findByText("This AI tool is temporarily unavailable. Please try again later.")).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(runBackgroundRemoval).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1].body.externalUrl).toBe("https://o.example/t/b-cutout.png");
  });
});
