import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useOAuthRedirectHandler } from "../useOAuthRedirectHandler";

const mocks = vi.hoisted(() => ({
  queryClient: { refetchQueries: vi.fn() },
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "fake-user-id" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {},
}));

const handlers = {
  handleTikTokCallback: vi.fn(async () => undefined),
  handleYouTubeCallback: vi.fn(async () => undefined),
  handleLinkedInCallback: vi.fn(async () => undefined),
  handleTwitterCallback: vi.fn(async () => undefined),
  handleThreadsCallback: vi.fn(async () => undefined),
  handleRedditCallback: vi.fn(async () => undefined),
  handleInstagramBusinessCallback: vi.fn(async () => undefined),
  handleBlueskyOAuthCallback: vi.fn(async () => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.searchParams.delete("connected");
  mocks.searchParams.delete("reconnected");
  mocks.searchParams.set("connected", "pinterest");
  mocks.searchParams.set("reconnected", "1");
});

it("shows refreshed state and refetches account health after reconnect", () => {
  renderHook(() => useOAuthRedirectHandler(handlers));

  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Connection refreshed" }),
  );
  expect(mocks.queryClient.refetchQueries).toHaveBeenCalledWith({
    queryKey: ["accounts-needing-reauth"],
  });
  expect(mocks.queryClient.refetchQueries).toHaveBeenCalledWith({
    queryKey: ["all_social_accounts"],
  });
});
