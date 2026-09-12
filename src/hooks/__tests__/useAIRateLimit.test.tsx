import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAIRateLimit } from "../useAIRateLimit";

const { fromMock, rpcMock, singleMock, user } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
  singleMock: vi.fn(),
  user: { id: "user-a" },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: fromMock, rpc: rpcMock },
}));
vi.mock("../useAuth", () => ({ useAuth: () => ({ user }) }));

function queryResponse(data: unknown) {
  return Object.assign(Promise.resolve({ data, error: null }), {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    order() { return this; },
    limit() { return this; },
    maybeSingle() { return Promise.resolve({ data, error: null }); },
  });
}

describe("useAIRateLimit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fromMock.mockImplementation((table: string) => {
      if (table === "user_subscriptions") return queryResponse(null);
      if (table === "tier_rate_limits" || table === "user_rate_limits") return queryResponse([]);
      throw new Error(`Unexpected table: ${table}`);
    });
    rpcMock.mockReturnValue({ single: singleMock });
    singleMock.mockResolvedValue({
      data: {
        caption_hour: 2, caption_day: 7,
        image_hour: 1, image_day: 4,
        hashtag_hour: 3, hashtag_day: 9,
      },
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses all six RPC counts to calculate remaining hourly and daily quota", async () => {
    const { result } = renderHook(() => useAIRateLimit());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.captionLimit).toMatchObject({ remainingHour: 3, remainingDay: 13 });
    expect(result.current.imageLimit).toMatchObject({ remainingHour: 1, remainingDay: 6 });
    expect(result.current.hashtagLimit).toMatchObject({ remainingHour: 7, remainingDay: 21 });
  });

  it("preserves previous limits when an RPC refresh fails instead of restoring full quota", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useAIRateLimit());
    await waitFor(() => expect(result.current.captionLimit.remainingHour).toBe(3));
    const { captionLimit, imageLimit, hashtagLimit } = result.current;
    singleMock.mockResolvedValueOnce({ data: null, error: { message: "statement timeout" } });

    await act(() => result.current.refreshLimits());

    expect(result.current.captionLimit).toEqual(captionLimit);
    expect(result.current.imageLimit).toEqual(imageLimit);
    expect(result.current.hashtagLimit).toEqual(hashtagLimit);
    expect(result.current.isLoading).toBe(false);
  });

  it("makes exactly one counts RPC call per refresh without querying api_logs", async () => {
    const { result } = renderHook(() => useAIRateLimit());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(rpcMock).toHaveBeenCalledExactlyOnceWith("get_ai_rate_limit_counts");
    expect(singleMock).toHaveBeenCalledTimes(1);

    rpcMock.mockClear();
    singleMock.mockClear();
    await act(() => result.current.refreshLimits());

    expect(rpcMock).toHaveBeenCalledExactlyOnceWith("get_ai_rate_limit_counts");
    expect(singleMock).toHaveBeenCalledTimes(1);
    expect(fromMock).not.toHaveBeenCalledWith("api_logs");
  });
});
