import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeGateway, queryWrapper } from "../tests/fixtures";
import { useAiProviderModels } from "./useAiProviderModels";

describe("AI model catalog", () => {
  it("surfaces a failed catalog read instead of caching an empty catalog", async () => {
    const gateway = fakeGateway();
    gateway.listModels.mockRejectedValue(new Error("42501"));
    const { client, wrapper } = queryWrapper();
    const { result } = renderHook(() => useAiProviderModels(gateway), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("42501");
    expect(client.getQueryData(["ai-provider-models"])).toBeUndefined();
  });
});
