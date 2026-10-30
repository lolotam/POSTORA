import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMediaUploadLimits, useMediaUploadLimitsState, useSaveMediaUploadLimits } from "../ui/useMediaUploadLimits";

const maybeSingle = vi.hoisted(() => vi.fn());
const upsert = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      upsert,
    }),
  },
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useMediaUploadLimits", () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    upsert.mockReset();
  });

  it("returns the admin's limits once they load", async () => {
    maybeSingle.mockResolvedValue({ data: { value: { image_max_mb: 50, video_max_mb: 2000 } }, error: null });
    const { result } = renderHook(() => useMediaUploadLimits(), { wrapper: wrapper() });
    expect(result.current).toEqual({ image_max_mb: 20, video_max_mb: 500 });
    await waitFor(() => expect(result.current).toEqual({ image_max_mb: 50, video_max_mb: 2000 }));
  });

  it("keeps the defaults when the setting cannot be read", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const { result } = renderHook(() => useMediaUploadLimits(), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ image_max_mb: 20, video_max_mb: 500 });
  });

  it("ignores a stored value that is not one of the options", async () => {
    maybeSingle.mockResolvedValue({ data: { value: { image_max_mb: 30, video_max_mb: 100 } }, error: null });
    const { result } = renderHook(() => useMediaUploadLimits(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toEqual({ image_max_mb: 20, video_max_mb: 100 }));
  });
});

describe("useMediaUploadLimitsState", () => {
  beforeEach(() => maybeSingle.mockReset());

  it("is loading, then ready with the stored values", async () => {
    maybeSingle.mockResolvedValue({ data: { value: { image_max_mb: 50, video_max_mb: 200 } }, error: null });
    const { result } = renderHook(() => useMediaUploadLimitsState(), { wrapper: wrapper() });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.limits).toEqual({ image_max_mb: 50, video_max_mb: 200 });
  });

  it("reports a failed read as an error, not as the defaults being stored", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    const { result } = renderHook(() => useMediaUploadLimitsState(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("error"));
  });
});

describe("useSaveMediaUploadLimits", () => {
  it("upserts the chosen values under media_upload_limits", async () => {
    upsert.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useSaveMediaUploadLimits(), { wrapper: wrapper() });
    await result.current.mutateAsync({ image_max_mb: 100, video_max_mb: 1000 });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: "media_upload_limits", value: { image_max_mb: 100, video_max_mb: 1000 } }),
      { onConflict: "key" },
    );
  });
});
