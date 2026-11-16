import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MediaLibraryPicker } from "../MediaLibraryPicker";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner" } }) }));
vi.mock("@/hooks/useCdnConfig", () => ({ useCdnConfig: () => ({ data: null }) }));

function queryResult(data: unknown) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: async () => ({ data, error: null }),
    then: (resolve: (value: { data: unknown; error: null }) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
  };
  return builder;
}

const rows = ["a", "b", "c"].map((id) => ({
  id,
  file_path: `https://images.example/${id}.png`,
  file_type: "image",
  file_size: 1,
  created_at: `2026-01-0${id === "a" ? 3 : id === "b" ? 2 : 1}T00:00:00Z`,
  upload_date: null,
  folder_path: "/",
  platforms: null,
  social_account_ids: null,
  storage_bucket: "cloudinary",
  metadata: { width: 100, height: 100 },
  media_file_providers: [],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => queryResult(table === "media_files" ? rows : []),
    storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) },
  },
}));

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { postmedia: {} } }, defaultNS: "postmedia" });

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});

describe("media library selection order", () => {
  it("confirms files in click order rather than created_at source order", async () => {
    const onSelect = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={client}>
          <MediaLibraryPicker open onOpenChange={vi.fn()} onSelect={onSelect} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    await screen.findByText("3 files");
    const cards = screen.getAllByRole("button").filter((button) => button.className.includes("aspect-square"));
    expect(cards).toHaveLength(3);
    await userEvent.click(cards[2]);
    await userEvent.click(cards[0]);
    await userEvent.click(screen.getByRole("button", { name: "Add 2 Files" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect.mock.calls[0][0].map((file: { storagePath: string }) => file.storagePath)).toEqual(["c", "a"]);
  });
});
