import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useBrandScrape } from "../useBrandScrape";
import { resolveBrandProfileSource } from "@/types/brand-intelligence";
import type { BrandProfile, BrandPost } from "@/types/brand-intelligence";

/**
 * The provenance of a scraped profile.
 *
 * WHAT THIS SUITE PROVES
 *
 *   The source of an observation is a FACT THE PRODUCER STATED. The
 *   hook passes an explicit source through and says "unknown" when
 *   there is none. It never reads a source out of the handle, the
 *   platform or the fact that the answer came from the cache (T8-01).
 *
 * WHY "UNKNOWN" IS THE HONEST ANSWER TODAY
 *
 *   The interactive brand scrape does not publish a source yet - that
 *   is the parent plan's Task 2. Until it does, a card that claimed
 *   "official" would be a claim nobody made. The producer's contract
 *   is honoured the moment it exists; nothing has to change here for
 *   that to happen.
 */

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
      refreshSession: async () => ({
        data: { session: { access_token: "test-token" } },
        error: null,
      }),
    },
  },
}));

const PROFILE: BrandProfile = {
  id: "profile-1",
  username: "northwind",
  fullName: "Northwind",
  bio: "",
  avatarUrl: "",
  followersCount: 1200,
  followingCount: 40,
  postsCount: 12,
  isVerified: false,
  platform: "instagram",
};

const POST: BrandPost = {
  id: "post-1",
  mediaType: "IMAGE",
  thumbnailUrl: "",
  caption: "",
  likesCount: 1,
  commentsCount: 0,
  engagementScore: 1,
  timestamp: "2026-10-30T08:00:00Z",
  permalink: "https://www.instagram.com/p/1",
};

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("useBrandScrape provenance", () => {
  it("passes an explicit source through to the caller", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { ...PROFILE, source: "official" },
        posts: [POST],
        totalPosts: 1,
        hasMore: false,
      }),
    );

    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.search("northwind", "instagram");
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("official");
  });

  it("says unknown when the producer recorded no source", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { ...PROFILE },
        posts: [POST],
        totalPosts: 1,
        hasMore: false,
      }),
    );

    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.search("northwind", "instagram");
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("unknown");
  });

  it("does not read a source out of the cache flag", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { ...PROFILE },
        posts: [POST],
        totalPosts: 1,
        hasMore: false,
        fromCache: true,
      }),
    );

    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.search("northwind", "instagram");
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("unknown");
  });

  it("keeps the explicit source of a cached answer", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { ...PROFILE, source: "apify" },
        posts: [POST],
        totalPosts: 1,
        hasMore: false,
        fromCache: true,
      }),
    );

    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.search("northwind", "instagram");
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("apify");
  });

  it("refuses a source value it does not know", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        profile: { ...PROFILE, source: "scraped-by-magic" },
        posts: [POST],
        totalPosts: 1,
        hasMore: false,
      }),
    );

    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.search("northwind", "instagram");
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("unknown");
  });

  it("keeps the explicit source of a history session", async () => {
    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.loadFromSession({ ...PROFILE, source: "official" }, [POST]);
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("official");
    // A history session is not a new scrape.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not infer the source of a history session", async () => {
    const { result } = renderHook(() => useBrandScrape(), { wrapper });

    act(() => {
      result.current.loadFromSession({ ...PROFILE }, [POST]);
    });

    await waitFor(() => expect(result.current.profile).not.toBeNull());
    expect(result.current.profileSource).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveBrandProfileSource", () => {
  it("accepts exactly the stated source vocabulary", () => {
    expect(resolveBrandProfileSource("official")).toBe("official");
    expect(resolveBrandProfileSource("apify")).toBe("apify");
    expect(resolveBrandProfileSource("graph_own")).toBe("graph_own");
  });

  it("turns strategy names and anything else into unknown", () => {
    for (const value of ["cache", "meta_api", "Official", "", null, undefined, 1]) {
      expect(resolveBrandProfileSource(value)).toBe("unknown");
    }
  });
});
