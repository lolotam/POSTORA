import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCdnConfig } from "../useCdnConfig";

const { tableRow, rpc } = vi.hoisted(() => ({ tableRow: { value: null as unknown }, rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: tableRow.value === null ? null : { value: tableRow.value }, error: null }),
  };
  return { supabase: { from: () => query, rpc } };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const stored = {
  read_preference: "openinary",
  write_policy: { providers: ["openinary"], required: ["openinary"] },
  openinary: { enabled: true, serverUrl: "https://cdn.example", folderPrefix: "postora.cloud" },
};

describe("useCdnConfig for a non-admin", () => {
  beforeEach(() => {
    rpc.mockReset();
    tableRow.value = null;
  });

  // 2026-09-29: cdn_storage is admin-only under RLS, so non-admins got no Openinary
  // origin and every Library thumbnail downloaded the full original.
  it("reads the public config when the settings row is hidden by RLS", async () => {
    rpc.mockResolvedValue({ data: stored, error: null });
    const { result } = renderHook(() => useCdnConfig(), { wrapper });
    await waitFor(() => expect(result.current.data?.openinary?.serverUrl).toBe("https://cdn.example"));
    expect(rpc).toHaveBeenCalledWith("get_cdn_public_config");
  });

  it("keeps the admin's full stored row and skips the public read", async () => {
    tableRow.value = { ...stored, cloudinary: { enabled: true, cloudName: "c" } };
    const { result } = renderHook(() => useCdnConfig(), { wrapper });
    await waitFor(() => expect(result.current.data?.cloudinary?.cloudName).toBe("c"));
    expect(rpc).not.toHaveBeenCalled();
  });
});
