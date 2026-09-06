import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeGateway, queryWrapper } from "../tests/fixtures";
import { useAiRoutingPreferences } from "./useAiRoutingPreferences";

describe("Routing preferences cache", () => {
  it("invalidates only the saving user's preferences and reflects the new row", async () => {
    const gateway = fakeGateway();
    const { client, wrapper } = queryWrapper();
    client.setQueryData(["ai-routing-prefs", "user-2"], []);
    const pref = { capability: "chat", mode: "postora_only", preferred_provider_code: null, preferred_model_id: null, allow_platform_fallback: false } as const;
    gateway.upsertPreference.mockImplementation(async () => { gateway.getPreferences.mockResolvedValue([pref]); });
    const { result } = renderHook(() => useAiRoutingPreferences(gateway, "user-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.save.mutate(pref));
    await waitFor(() => expect(result.current.data).toEqual([pref]));
    expect(client.getQueryState(["ai-routing-prefs", "user-2"])?.isInvalidated).toBe(false);
  });
});
