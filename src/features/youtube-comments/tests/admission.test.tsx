import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useYouTubeStage4Admission } from "../application/useYouTubeStage4Admission";
import { youtubeCommentsKey } from "../application/queryKeys";
import type { YouTubeCommentsGateway } from "../application/ports";
import type { Stage4CapabilitiesPayload } from "../domain/types";
import { YouTubeCommentsError } from "../domain/errors";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: USER } } }),
}));

function capabilities(read: boolean): Stage4CapabilitiesPayload {
  return {
    account_id: ACCOUNT,
    capabilities: {
      read: { allowed: read, reason: read ? null : "capability_off" },
      held: { allowed: false, reason: "capability_off" },
      write: { allowed: false, reason: "capability_off" },
      ban: { allowed: false, reason: "capability_off" },
    },
  };
}

function setup(answers: Array<() => Promise<Stage4CapabilitiesPayload>>) {
  let call = 0;
  const gateway = {
    capabilities: vi.fn(() => answers[Math.min(call++, answers.length - 1)]()),
  } as unknown as YouTubeCommentsGateway;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useYouTubeStage4Admission(ACCOUNT, true, gateway), { wrapper });
  return { gateway, client, hook };
}

describe("useYouTubeStage4Admission", () => {
  it("stays admitted when a later refetch fails: the data it already has decides", async () => {
    const { gateway, client, hook } = setup([
      () => Promise.resolve(capabilities(true)),
      () => Promise.reject(new Error("transient failure")),
    ]);
    await waitFor(() => expect(hook.result.current.admission).toBe("admitted"));
    await act(async () => { await client.invalidateQueries({ queryKey: youtubeCommentsKey(USER, ACCOUNT, "admission") }); });
    await waitFor(() => expect(gateway.capabilities).toHaveBeenCalledTimes(2));
    // The failed refetch really did put the query in the error state (the data is kept)...
    await waitFor(() => expect(client.getQueryState(youtubeCommentsKey(USER, ACCOUNT, "admission"))?.status).toBe("error"));
    // ...and the screen must not be unmounted by it.
    expect(hook.result.current.admission).toBe("admitted");
  });

  it("is legacy when the first load fails: with no data an error means the baseline inbox", async () => {
    const { hook } = setup([() => Promise.reject(new Error("down"))]);
    await waitFor(() => expect(hook.result.current.admission).toBe("legacy"));
  });

  it("is unavailable only when the server said the settings could not be read", async () => {
    const { hook } = setup([() => Promise.reject(new YouTubeCommentsError("settings_unavailable"))]);
    await waitFor(() => expect(hook.result.current.admission).toBe("unavailable"));
  });

  it("is legacy for an upstream failure with no data: a transport error or an old backend is not the settings", async () => {
    const { hook } = setup([() => Promise.reject(new YouTubeCommentsError("upstream"))]);
    await waitFor(() => expect(hook.result.current.admission).toBe("legacy"));
  });

  it("is legacy when the data says reads are not allowed", async () => {
    const { hook } = setup([() => Promise.resolve(capabilities(false))]);
    await waitFor(() => expect(hook.result.current.admission).toBe("legacy"));
  });
});
