import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleLibraryPicker } from "./ScheduleLibraryPicker";

const imageRow = {
  id: "file-1",
  file_path: "https://cdn.example/photo.jpg",
  file_type: "image",
  file_size: 1200,
  mime_type: "image/jpeg",
  metadata: { kind: "image", original_filename: "holiday photo.jpg" },
  storage_bucket: "cloudinary",
  current_object_version: 1,
  media_file_providers: [{
    provider: "cloudinary",
    object_version: 1,
    status: "ready",
    delivery_url: "https://cdn.example/photo.jpg",
  }],
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => (typeof fallback === "string" ? fallback : _key),
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

vi.mock("@/hooks/useCdnConfig", () => ({
  useCdnConfig: () => ({ data: { read_preference: "cloudinary" } }),
}));

vi.mock("@/integrations/supabase/client", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    range: () => Promise.resolve({ data: [imageRow], error: null }),
  };
  return { supabase: { from: () => builder, storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } } };
});

describe("ScheduleLibraryPicker", () => {
  it("renders an image file as a thumbnail instead of a generic tile", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ScheduleLibraryPicker active selectedId={null} onPick={vi.fn()} />
      </QueryClientProvider>,
    );

    const image = await screen.findByRole("img", { name: "holiday photo.jpg" });
    expect(image).toHaveAttribute("src", "https://cdn.example/photo.jpg");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image.className).toContain("object-cover");
  });
});
