import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import YouTubeBenchmarkPage from "./YouTubeBenchmarkPage";

const flags = vi.hoisted(() => ({ youtubeBenchmark: true, loading: false }));
const accounts = vi.hoisted(() => ({
  data: [
    { id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" },
  ] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { youtubeBenchmark: flags.youtubeBenchmark }, isLoading: flags.loading }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: accounts.data,
    isLoading: accounts.isLoading,
    error: accounts.error,
    refetch: accounts.refetch,
  }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

let i18n: I18n;

async function renderAt(): Promise<void> {
  i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/youtube/benchmark"]}>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <Routes>
            <Route path="/youtube/benchmark" element={<YouTubeBenchmarkPage />} />
            <Route path="/dashboard" element={<div>dashboard</div>} />
          </Routes>
        </I18nextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("YouTubeBenchmarkPage flag gating", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
    flags.youtubeBenchmark = true;
    flags.loading = false;
    accounts.data = [
      { id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" },
    ];
    accounts.isLoading = false;
    accounts.error = null;
    accounts.refetch = vi.fn();
  });

  it("sends a user without the flag to the dashboard without touching the gateway", async () => {
    flags.youtubeBenchmark = false;
    await renderAt();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("does not mount the screen while the flags are still loading", async () => {
    flags.loading = true;
    await renderAt();
    expect(screen.getByRole("status")).toHaveTextContent("Loading…");
    expect(screen.queryByText("dashboard")).not.toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("mounts the screen once the flag is on and reads nothing until the creator compares", async () => {
    await renderAt();
    expect(await screen.findByRole("heading", { name: "YouTube channel benchmark" })).toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("hands only native YouTube channels to the screen", async () => {
    accounts.data = [
      { id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" },
      { id: "acc-yt-composio", platform: "youtube", platform_username: "Managed", avatar_url: null, auth_provider: "composio" },
      { id: "acc-ig", platform: "instagram", platform_username: "ig", avatar_url: null, auth_provider: "native" },
    ];
    await renderAt();
    const picker = await screen.findByLabelText("Your channel");
    expect(picker).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Managed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "ig" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "My channel" })).toBeInTheDocument();
  });

  it("shows an accounts error with a retry instead of the empty state", async () => {
    accounts.data = [];
    accounts.error = new Error("accounts read failed");
    await renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Postora could not read your connected accounts. Nothing was changed.",
    );
    expect(screen.queryByText("No YouTube channel is connected yet.")).not.toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(accounts.refetch).toHaveBeenCalledTimes(1);
  });

  it("reads the named channels only when the creator compares them", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: {
        schema_version: 1,
        request_id: "req",
        freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" },
        data: {
          account_id: "acc-yt",
          channels: [
            {
              input: "@alpha",
              status: "found",
              channel_id: "UCabcdefghijklmnopqrstuv",
              title: "Alpha Channel",
              thumbnail_url: null,
              subscriber_count: 10,
              subscriber_count_hidden: false,
              view_count: 20,
              video_count: 2,
              recent_videos: [],
            },
          ],
        },
      },
      error: null,
    });

    await renderAt();
    await userEvent.type(await screen.findByLabelText("Channel 1"), "@alpha");
    await userEvent.click(screen.getByRole("button", { name: "Compare channels" }));

    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-channel-benchmark", {
      body: { account_id: "acc-yt", channels: ["@alpha"] },
      timeout: 25000,
    });
    expect(await screen.findByRole("heading", { name: "Alpha Channel" })).toBeInTheDocument();
  });
});
