import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useWhatsAppConnect, useWhatsAppDisconnect } from "../useWhatsAppConnect";

const mocks = vi.hoisted(() => ({ signup: vi.fn(), invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/whatsappEmbeddedSignup", () => ({ launchWhatsAppSignup: mocks.signup }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: mocks.invoke } } }));
vi.mock("@/hooks/use-toast", () => ({ toast: mocks.toast }));

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => { vi.clearAllMocks(); });

it("successful signup invalidates the reconnect banner immediately", async () => {
  const client = new QueryClient();
  client.setQueryData(["accounts-needing-reauth", "user-1"], ["old"]);
  mocks.signup.mockResolvedValue({ code: "test-code" });
  mocks.invoke.mockResolvedValue({ data: {}, error: null });
  const { result } = renderHook(() => useWhatsAppConnect(), { wrapper: wrapperFor(client) });
  await act(() => result.current.mutateAsync("cloud_api"));
  expect(client.getQueryState(["accounts-needing-reauth", "user-1"])?.isInvalidated).toBe(true);
});

it("a partial remote disconnect tells the owner how to finish logout", async () => {
  mocks.invoke.mockResolvedValue({ data: { success: true, teardown: { deactivated: true, evolution: "failed" } }, error: null });
  const { result } = renderHook(() => useWhatsAppDisconnect(), { wrapper: wrapperFor(new QueryClient()) });
  await act(() => result.current.mutateAsync("acc-1"));
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
    title: "WhatsApp disconnected locally",
    description: expect.stringContaining("Remove the linked device"),
  }));
});
