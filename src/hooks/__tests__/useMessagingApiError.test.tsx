import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppSendTemplate } from "@/hooks/useMessaging";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } } }),
      refreshSession: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

const OPTED_OUT = "This customer has opted out of WhatsApp messages. Templates cannot be sent to them.";

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("callMessagingApi error_type", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws RECIPIENT_OPTED_OUT instead of resolving a success:false body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: OPTED_OUT,
      error_type: "RECIPIENT_OPTED_OUT",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const { result } = renderHook(() => useWhatsAppSendTemplate(), { wrapper: wrapperFor(client) });

    await expect(result.current.mutateAsync({
      socialAccountId: "acct-1",
      recipientPhone: "+96550001111",
      templateName: "order_update",
    })).rejects.toMatchObject({ message: OPTED_OUT, errorType: "RECIPIENT_OPTED_OUT" });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
