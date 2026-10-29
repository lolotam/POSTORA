import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MediaUploadLimitsSettings } from "../MediaUploadLimitsSettings";

const toast = vi.hoisted(() => vi.fn());
const mutate = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/features/media-upload", () => ({
  useMediaUploadLimits: () => ({ image_max_mb: 20, video_max_mb: 500 }),
  useSaveMediaUploadLimits: () => ({ mutate, isPending: false }),
}));

// Radix Select needs pointer capture and scrollIntoView, which jsdom lacks.
beforeEach(() => {
  toast.mockClear();
  mutate.mockReset();
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function openSelect(name: string) {
  fireEvent.pointerDown(screen.getByRole("combobox", { name }), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByRole("listbox");
}

describe("MediaUploadLimitsSettings", () => {
  it("offers exactly the agreed options for images and video", () => {
    render(<MediaUploadLimitsSettings />);
    const images = within(openSelect("Maximum image size")).getAllByRole("option").map((o) => o.textContent);
    expect(images).toEqual(["10 MB", "20 MB", "50 MB", "100 MB"]);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });

    const videos = within(openSelect("Maximum video size")).getAllByRole("option").map((o) => o.textContent);
    expect(videos).toEqual(["100 MB", "200 MB", "500 MB", "1000 MB", "2000 MB"]);
  });

  it("shows the stored limits and keeps Save off until something changes", () => {
    render(<MediaUploadLimitsSettings />);
    expect(screen.getByRole("combobox", { name: "Maximum image size" })).toHaveTextContent("20 MB");
    expect(screen.getByRole("combobox", { name: "Maximum video size" })).toHaveTextContent("500 MB");
    expect(screen.getByRole("button", { name: "Save limits" })).toBeDisabled();
  });

  it("saves the chosen values and confirms", async () => {
    mutate.mockImplementation((_limits, options) => options.onSuccess());
    render(<MediaUploadLimitsSettings />);

    fireEvent.click(within(openSelect("Maximum video size")).getByRole("option", { name: "2000 MB" }));
    fireEvent.click(screen.getByRole("button", { name: "Save limits" }));

    expect(mutate).toHaveBeenCalledWith({ image_max_mb: 20, video_max_mb: 2000 }, expect.anything());
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Upload limits saved" }));
  });
});
