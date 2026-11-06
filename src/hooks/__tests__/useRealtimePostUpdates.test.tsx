import { act, render, renderHook, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealtimePostUpdates } from "../useRealtimePostUpdates";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { PublishingProvider, usePublishing } from "@/contexts/PublishingContext";
import { PublishingStatusIndicator } from "@/components/history/PublishingStatusIndicator";

interface Change { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }
const { callbacks, toast, sendNotification, polled } = vi.hoisted(() => ({ callbacks: new Map<string, (change: Change) => void | Promise<void>>(), toast: vi.fn(), sendNotification: vi.fn(), polled: { status: "processing" } }));
vi.mock("@/hooks/usePushNotifications", () => ({ usePushNotifications: () => ({ sendNotification, isEnabled: true }) }));
vi.mock("@/hooks/useNotificationSound", () => ({ useNotificationSound: () => ({ playSuccessSound: vi.fn(), playErrorSound: vi.fn() }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  channel: () => {
    const channel = { on: (_event: string, filter: { table: string }, callback: (change: Change) => void) => {
      callbacks.set(filter.table, callback);
      return channel;
    }, subscribe: () => channel };
    return channel;
  },
  removeChannel: vi.fn(),
  from: () => ({ select: () => ({
    eq: () => ({ single: async () => ({ data: { user_id: "user-1", platforms: ["facebook"] }, error: null }) }),
    in: async (_column: string, ids: string[]) => ({ data: ids.map((id) => ({ id, status: polled.status })), error: null }),
  }) }),
} }));

function renderUpdates() {
  const client = new QueryClient();
  return renderHook(() => useRealtimePostUpdates(), { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children) });
}

beforeAll(async () => { await i18next.use(initReactI18next).init({ lng: "en", resources: {}, fallbackLng: "en" }); });
beforeEach(() => { vi.useFakeTimers(); polled.status = "processing"; callbacks.clear(); toast.mockClear(); sendNotification.mockClear(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("publishing lifecycle", () => {
  it.each(["completed", "failed"])("clears only when the parent post becomes %s", async (status) => {
    const { result } = renderUpdates();
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    await act(async () => { await callbacks.get("posts")!({ eventType: "UPDATE", new: { id: "post-1", status }, old: {} }); });
    expect(result.current.publishingPosts.has("post-1")).toBe(false);
  });

  // Regression, 2026-11-06: posts and platform_posts were missing from the realtime publication,
  // so the badge kept spinning on a post that had finished within a minute.
  it("clears a finished post from its own status when no realtime event arrives", async () => {
    const { result } = renderUpdates();
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.publishingPosts.has("post-1")).toBe(true);
    polled.status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.publishingPosts.has("post-1")).toBe(false);
  });

  it("keeps the badge after sixty seconds, shows still publishing, and caps tracking at 35 minutes", () => {
    const { result } = renderUpdates();
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.publishingPosts.get("post-1")).toMatchObject({ stillPublishing: true });
    const badge = render(<PublishingStatusIndicator publishingPosts={result.current.publishingPosts} />);
    expect(screen.getByText("Still publishing 1 post(s)...")).toBeInTheDocument();
    badge.unmount();
    act(() => vi.advanceTimersByTime(34 * 60_000 - 1));
    expect(result.current.isPublishing).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.isPublishing).toBe(false);
  });

  it("does not let a previous attempt's timer clear a newly tracked attempt", () => {
    const { result } = renderUpdates();
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    act(() => vi.advanceTimersByTime(34 * 60_000));
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.isPublishing).toBe(true);
  });

  it.each(["success", "failed"])("toasts a terminal %s INSERT once even if UPDATE repeats it", async (status) => {
    renderUpdates();
    const row = { id: "result-1", post_id: "post-1", platform: "facebook", status };
    await act(async () => {
      await callbacks.get("platform_posts")!({ eventType: "INSERT", new: row, old: {} });
      expect(toast).toHaveBeenCalledTimes(1);
      await callbacks.get("platform_posts")!({ eventType: "UPDATE", new: row, old: { status: "pending" } });
      await callbacks.get("platform_posts")!({ eventType: "INSERT", new: row, old: {} });
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: status === "success" ? "Published to facebook" : "Failed on facebook" }));
  });

  it("does not clear a post when one account finishes on its only platform", async () => {
    const { result } = renderUpdates();
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    await act(async () => {
      await callbacks.get("platform_posts")!({ eventType: "UPDATE", new: { id: "result-1", post_id: "post-1", platform: "facebook", status: "success" }, old: { status: "pending" } });
    });
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.isPublishing).toBe(true);
  });

  it("toasts a later retry row independently on the same platform", async () => {
    renderUpdates();
    await act(async () => {
      for (const id of ["result-1", "result-2"]) {
        await callbacks.get("platform_posts")!({ eventType: "INSERT", new: { id, post_id: "post-1", platform: "facebook", status: "success" }, old: {} });
      }
    });
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("does not announce all platforms published when only one account has finished", async () => {
    const client = new QueryClient();
    const { result } = renderHook(() => usePublishing(), { wrapper: ({ children }: { children: ReactNode }) =>
      <QueryClientProvider client={client}><PublishingProvider>{children}</PublishingProvider></QueryClientProvider> });
    act(() => result.current.trackPublishingPost("post-1", ["facebook"]));
    await act(async () => {
      await callbacks.get("platform_posts")!({ eventType: "INSERT", new: { id: "result-1", post_id: "post-1", platform: "facebook", status: "success" }, old: {} });
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(expect.stringContaining("Published to Facebook"), expect.any(Object));
    expect(result.current.isPublishing).toBe(true);
  });

});
