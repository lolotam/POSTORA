import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useBrandScrape } from "../useBrandScrape";
import type { BrandProfile, BrandPost } from "@/types/brand-intelligence";

/**
 * Load-more ownership: one request at a time, and a request that belongs to an
 * earlier search, reset or saved session can neither commit nor release the guard
 * of a newer one. Every deferred promise below settles exactly once.
 */
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: "test-token", user: { id: "fixture-owner" } } }, error: null }),
      refreshSession: async () => ({ data: { session: { access_token: "test-token", user: { id: "fixture-owner" } } }, error: null }),
    },
  },
}));

const PROFILE: BrandProfile = {
  id: "profile-1", username: "northwind", fullName: "Northwind", bio: "", avatarUrl: "",
  followersCount: 1, followingCount: 1, postsCount: 9, isVerified: false, platform: "instagram",
};
const post = (id: string): BrandPost => ({
  id, mediaType: "IMAGE", thumbnailUrl: "", caption: "", likesCount: 1, commentsCount: 0,
  engagementScore: 1, timestamp: "2026-10-30T08:00:00Z", permalink: `https://www.instagram.com/p/${id}`,
});
const RECONNECT = { code: "IG_RECONNECT_REQUIRED", message: "Reconnect Instagram to enable official competitor data." };
const ok = (id: string, extra: Record<string, unknown> = {}) => ({
  ok: true, status: 200, json: async () => ({ profile: PROFILE, posts: [post(id)], totalPosts: 99, hasMore: true, ...extra }),
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useBrandScrape("fixture-owner"), { wrapper });
}
type Hook = ReturnType<typeof setup>["result"];
async function search(result: Hook, handle: string, firstPostId: string, extra: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValueOnce(ok(firstPostId, extra));
  act(() => result.current.search(handle, "instagram"));
  await waitFor(() => expect(result.current.posts.map((entry) => entry.id)).toEqual([firstPostId]));
}
const calls = () => fetchMock.mock.calls.length;

describe("useBrandScrape load more", () => {
  it("starts one request for two load-more calls in the same tick", async () => {
    const { result } = setup();
    await search(result, "northwind", "a0");
    const second = deferred();
    fetchMock.mockReturnValueOnce(second.promise);
    act(() => { void result.current.loadMore(); void result.current.loadMore(); });
    await waitFor(() => expect(calls()).toBe(2));
    await act(async () => { await Promise.resolve(); });
    expect(calls()).toBe(2);
    expect(result.current.isLoadingMore).toBe(true);
    await act(async () => { second.resolve(ok("a1")); });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["a0", "a1"]);
  });

  it("ignores a late page that belongs to an earlier search", async () => {
    const { result } = setup();
    await search(result, "northwind", "a0");
    const stale = deferred();
    fetchMock.mockReturnValueOnce(stale.promise);
    act(() => { void result.current.loadMore(); });
    await waitFor(() => expect(calls()).toBe(2));
    await search(result, "other", "o0");
    await act(async () => { stale.resolve(ok("a1")); });
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["o0"]);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it("keeps the loaded posts, shows a closed error and retries after a failed page", async () => {
    const { result } = setup();
    await search(result, "northwind", "a0");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: "SECRET upstream stack trace" }) });
    await act(() => result.current.loadMore());
    expect(result.current.loadMoreError).toBe("unavailable");
    expect(result.current.error).toBeNull();
    expect(JSON.stringify([result.current.loadMoreError, result.current.warning])).not.toContain("SECRET");
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["a0"]);
    expect(result.current.hasMore).toBe(true);
    fetchMock.mockResolvedValueOnce(ok("a1"));
    await act(() => result.current.loadMore());
    expect(result.current.loadMoreError).toBeNull();
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["a0", "a1"]);
  });

  it.each([
    ["is returned with the page", ok("a1", { warning: RECONNECT })],
    ["is thrown by the page request", { ok: false, status: 409, json: async () => ({ error: "x", error_code: "IG_INSIGHTS_SCOPE_MISSING" }) }],
  ])("exposes a reconnect signal that %s", async (_scenario, reply) => {
    const { result } = setup();
    await search(result, "northwind", "a0");
    fetchMock.mockResolvedValueOnce(reply);
    await act(() => result.current.loadMore());
    expect(result.current.reconnectRequired).toBe(true);
    expect(result.current.warning).toBe(RECONNECT.message);
    expect(result.current.loadMoreError).toBeNull();
  });

  it.each(["northwind", "elsewhere"])("drops the live warning and reconnect flag while a saved session of %s is shown", async (savedHandle) => {
    const { result } = setup();
    await search(result, "northwind", "a0", { warning: { ...RECONNECT, code: "IG_INSIGHTS_SCOPE_MISSING" } });
    expect(result.current.reconnectRequired).toBe(true);
    act(() => result.current.loadFromSession({ ...PROFILE, username: savedHandle }, [post("s0")]));
    expect(result.current.warning).toBeNull();
    expect(result.current.reconnectRequired).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("a late %s of request A neither commits nor releases the guard of request B", async (settle) => {
    const { result } = setup();
    await search(result, "northwind", "a0");
    const first = deferred();
    fetchMock.mockReturnValueOnce(first.promise);
    act(() => { void result.current.loadMore(); });
    await waitFor(() => expect(calls()).toBe(2));
    await search(result, "other", "o0");
    const second = deferred();
    fetchMock.mockReturnValueOnce(second.promise);
    act(() => { void result.current.loadMore(); });
    await waitFor(() => expect(calls()).toBe(4));
    expect(result.current.isLoadingMore).toBe(true);
    await act(async () => { if (settle === "resolve") first.resolve(ok("a1")); else first.reject(new Error("late failure")); });
    expect(result.current.isLoadingMore).toBe(true);
    expect(result.current.loadMoreError).toBeNull();
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["o0"]);
    act(() => { void result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });
    expect(calls()).toBe(4);
    await act(async () => { second.resolve(ok("o1")); });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));
    expect(result.current.posts.map((entry) => entry.id)).toEqual(["o0", "o1"]);
  });
});
