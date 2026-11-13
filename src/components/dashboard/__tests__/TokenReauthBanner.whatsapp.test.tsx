import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi, beforeEach, type Mock } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { TokenReauthBanner } from "../TokenReauthBanner";

// A WhatsApp account paired through Evolution does not reconnect through OAuth: its
// session is gone and only a new QR code brings it back. The banner has to send the
// owner to the WhatsApp setup page, and it must not call the session "expired".

const whatsappAccount = {
  id: "wa-account-1",
  platform: "whatsapp",
  platform_username: "Postora Store",
  needs_reauth: true,
  last_refresh_error: null,
  social_profile_id: "profile-1",
  connection_mode: "evolution_qr",
  is_active: false,
};

/** A Meta-hosted WhatsApp account: it has no OAuth branch and its credential expired. */
const metaWhatsappAccount = {
  id: "wa-meta-1",
  platform: "whatsapp",
  platform_username: "Postora Meta",
  needs_reauth: true,
  last_refresh_error: null,
  social_profile_id: "profile-1",
  connection_mode: "cloud_api",
  is_active: true,
};

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock("@/hooks/useProfileOAuth", () => ({
  useProfileOAuth: () => ({
    connectingPlatform: null,
    instagramFlowRequest: null,
    handleReconnectPlatform: vi.fn(),
    selectInstagramFlow: vi.fn(),
    clearInstagramFlowRequest: vi.fn(),
  }),
}));

const reconnectWhatsApp = vi.fn();
const connectWhatsApp = vi.fn();

vi.mock("@/hooks/useWhatsAppConnect", () => ({
  useWhatsAppReconnect: () => ({ mutate: reconnectWhatsApp, isPending: false }),
  useWhatsAppConnect: () => ({ mutate: connectWhatsApp, isPending: false }),
}));

/** The builder answers any number of filters, and each call answers with its own result. */
function answerWith(results: Array<{ data: unknown[]; error: unknown }>) {
  let call = 0;
  (supabase.from as Mock).mockImplementation(() => {
    const result = results[call] ?? { data: [], error: null };
    call += 1;
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  });
}

const renderBanner = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TokenReauthBanner />
      </QueryClientProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  answerWith([
    { data: [], error: null },
    { data: [whatsappAccount], error: null },
  ]);
});

it("sends a disconnected WhatsApp account to the QR setup page", async () => {
  renderBanner();

  const link = await screen.findByRole("link", { name: /reconnect whatsapp/i });
  expect(link).toHaveAttribute("href", "/messaging/whatsapp/setup");
});

it("calls a dropped WhatsApp session disconnected, not expired", async () => {
  renderBanner();

  expect(await screen.findByText(/disconnected/i)).toBeInTheDocument();
  expect(screen.queryByText(/connection expired/i)).not.toBeInTheDocument();
});

// The `reconnect` action re-subscribes the app to the WABA with the STORED access
// token. It never refreshes that token and never clears needs_reauth, so a flagged
// Meta account sent there stays flagged forever. The credential has to be renewed
// through the Embedded Signup connect flow instead.
it("renews the credential of a flagged Meta WhatsApp account instead of resubscribing", async () => {
  answerWith([
    { data: [metaWhatsappAccount], error: null },
    { data: [], error: null },
  ]);
  renderBanner();

  const button = await screen.findByRole("button", { name: /reconnect whatsapp/i });
  fireEvent.click(button);

  expect(connectWhatsApp).toHaveBeenCalledWith("cloud_api");
  expect(reconnectWhatsApp).not.toHaveBeenCalled();
});

it("reports a partial check failure and keeps the accounts that loaded", async () => {
  answerWith([
    { data: [metaWhatsappAccount], error: null },
    { data: null, error: new Error("qr query failed") },
  ]);
  renderBanner();

  expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
  // The account that did load is still offered for a reconnect.
  expect(await screen.findByRole("button", { name: /reconnect whatsapp/i })).toBeInTheDocument();
});

it("offers a retry when a check failed", async () => {
  answerWith([
    { data: [], error: null },
    { data: null, error: new Error("qr query failed") },
  ]);
  renderBanner();

  const retry = await screen.findByRole("button", { name: /retry/i });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);

  expect(supabase.from).toHaveBeenCalled();
});
