import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import { MediaUploadDialog } from "../MediaUploadDialog";

const toast = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const uploadLargeMedia = vi.hoisted(() => vi.fn());
const limits = vi.hoisted(() => ({ current: { image_max_mb: 20, video_max_mb: 500 } }));

vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => ({
    canUploadMedia: vi.fn().mockResolvedValue({ allowed: true }),
    quota: { max_media_uploads_per_day: 50, media_uploads_today: 0 },
    planLimits: { max_profiles: 2, max_social_accounts: 3, max_posts_per_month: 30, max_posts_per_day: 2, max_media_uploads_per_day: 50 },
  }),
}));

vi.mock("@/hooks/useMediaOperationsHistory", () => ({
  useLogMediaOperation: () => ({
    logOperation: vi.fn().mockResolvedValue("op-1"),
    completeOperation: vi.fn(),
    failOperation: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke }, from: vi.fn() } }));
vi.mock("@/features/media-upload", () => ({ uploadLargeMedia, useMediaUploadLimits: () => limits.current }));

const MB = 1024 * 1024;

function fileOfSize(name: string, type: string, size: number): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function renderDialog() {
  render(
    <MemoryRouter>
      <MediaUploadDialog open onClose={() => {}} currentFolder="/" onUploadComplete={() => {}} />
    </MemoryRouter>,
  );
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("MediaUploadDialog — files over 10 MB", () => {
  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
    uploadLargeMedia.mockReset();
    limits.current = { image_max_mb: 20, video_max_mb: 500 };
  });

  it("sends a 300 MB video straight to the provider instead of through the edge function", async () => {
    uploadLargeMedia.mockResolvedValue({ success: true, url: "https://o.example/clip.mp4", mediaFileId: "media-1", bytes: 300 * MB });
    const input = renderDialog();
    fireEvent.change(input, { target: { files: [fileOfSize("clip.mp4", "video/mp4", 300 * MB)] } });

    fireEvent.click(await screen.findByRole("button", { name: /Upload/ }));

    await waitFor(() => expect(uploadLargeMedia).toHaveBeenCalledTimes(1));
    expect(invoke).not.toHaveBeenCalled();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Upload complete" })));
  });

  it("refuses a video over 500 MB with the video limit", async () => {
    const input = renderDialog();
    fireEvent.change(input, { target: { files: [fileOfSize("huge.mp4", "video/mp4", 501 * MB)] } });
    expect(await screen.findByText("huge.mp4 is over the 500 MB limit")).toBeInTheDocument();
  });

  it("refuses an image over 20 MB with the image limit, though it is under the video one", async () => {
    const input = renderDialog();
    fireEvent.change(input, { target: { files: [fileOfSize("big.jpg", "image/jpeg", 21 * MB)] } });
    expect(await screen.findByText("big.jpg is over the 20 MB limit")).toBeInTheDocument();
    expect(screen.queryByText(/Files to upload/)).toBeNull();
  });

  it("holds files to the limits the admin chose", async () => {
    limits.current = { image_max_mb: 50, video_max_mb: 100 };
    const input = renderDialog();
    expect(screen.getByText(/Images up to 50 MB, video up to 100 MB/)).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [fileOfSize("clip.mp4", "video/mp4", 150 * MB)] } });
    expect(await screen.findByText("clip.mp4 is over the 100 MB limit")).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [fileOfSize("photo.jpg", "image/jpeg", 40 * MB)] } });
    expect(await screen.findByText(/Files to upload/)).toBeInTheDocument();
  });
});
