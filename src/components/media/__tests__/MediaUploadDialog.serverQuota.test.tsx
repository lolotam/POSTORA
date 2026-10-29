import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MediaUploadDialog } from "../MediaUploadDialog";

const toast = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => ({
    canUploadMedia: vi.fn().mockResolvedValue({ allowed: true }),
    quota: { max_media_uploads_per_day: 5, media_uploads_today: 0 },
    planLimits: {
      max_profiles: 2,
      max_social_accounts: 3,
      max_posts_per_month: 30,
      max_posts_per_day: 2,
      max_media_uploads_per_day: 5,
    },
  }),
}));

vi.mock("@/hooks/useMediaOperationsHistory", () => ({
  useLogMediaOperation: () => ({
    logOperation: vi.fn().mockResolvedValue("op-1"),
    completeOperation: vi.fn(),
    failOperation: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke },
    from: vi.fn(),
  },
}));

class StubFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readAsDataURL() {
    this.result = "data:image/jpeg;base64,SGVsbG8=";
    queueMicrotask(() => this.onload?.());
  }
}

const SENTENCE = "Daily upload limit of 5 reached. Upgrade your plan or try again tomorrow.";

describe("MediaUploadDialog — server quota refusal", () => {
  beforeEach(() => {
    toast.mockClear();
    invoke.mockReset();
    vi.stubGlobal("FileReader", StubFileReader);
  });

  it("shows the server's daily limit sentence and does not increment a client counter", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: new Response(JSON.stringify({
          success: false,
          error: SENTENCE,
          code: "MEDIA_QUOTA_DAILY_EXCEEDED",
        }), { status: 429 }),
      }),
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
        <MediaUploadDialog open onClose={() => {}} currentFolder="/" onUploadComplete={() => {}} />
      </MemoryRouter>
      </QueryClientProvider>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    const upload = await screen.findByRole("button", { name: /Upload/ });
    fireEvent.click(upload);

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: SENTENCE }));
    });
    expect(invoke).toHaveBeenCalled();
  });
});
