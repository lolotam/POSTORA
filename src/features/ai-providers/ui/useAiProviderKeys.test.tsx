import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { connectedKey, fakeGateway, queryWrapper } from "../tests/fixtures";
import { useAiProviderKeys } from "./useAiProviderKeys";

describe("AI key queries", () => {
  it("switches cache identity when the user changes", async () => {
    const first = fakeGateway();
    const second = fakeGateway();
    second.listKeys.mockResolvedValue([]);
    const { client, wrapper } = queryWrapper();
    const { result, rerender } = renderHook(({ user, gateway }) => useAiProviderKeys(gateway, user), {
      wrapper, initialProps: { user: "user-1", gateway: first },
    });
    await waitFor(() => expect(result.current.data).toEqual([connectedKey]));
    rerender({ user: "user-2", gateway: second });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(client.getQueryData(["ai-provider-keys", "user-1"])).toEqual([connectedKey]);
  });
  it("refreshes status after a rejected test marks a key invalid", async () => {
    const gateway = fakeGateway();
    gateway.testKey.mockImplementation(async () => {
      gateway.listKeys.mockResolvedValue([{ ...connectedKey, status: "invalid" }]);
      throw new Error("AI_USER_KEY_INVALID");
    });
    const { result } = renderHook(() => useAiProviderKeys(gateway, "user-1"), queryWrapper());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.test.mutate("openai"));
    await waitFor(() => expect(result.current.data?.[0].status).toBe("invalid"));
  });
});
