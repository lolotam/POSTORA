import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import YouTubeManagementPage from "./YouTubeManagementPage";

const flags = vi.hoisted(() => ({ youtubeManagement: true, loading: false }));
const accounts = vi.hoisted(() => ({
  data: [{ id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" }] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as unknown,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { youtubeManagement: flags.youtubeManagement }, isLoading: flags.loading }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts.data, isLoading: accounts.isLoading, error: accounts.error, refetch: accounts.refetch }),
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
    <MemoryRouter initialEntries={["/youtube"]}>
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <Routes>
            <Route path="/youtube" element={<YouTubeManagementPage />} />
            <Route path="/dashboard" element={<div>dashboard</div>} />
          </Routes>
        </I18nextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function validDataFor(operation: string): Record<string, unknown> {
  if (operation === "capabilities") {
    return {
      account_id: "acc-yt",
      channel_id: "UC",
      channel_title: "My channel",
      provider: "native",
      connection: "ok",
      scopes: { readonly: "granted", upload: "granted", force_ssl: "granted" },
      capabilities: { browse: { state: "available" }, upload: { state: "available" }, comments: { state: "available" } },
      quota: {
        provider_quota: "not_tracked",
        unit_costs: { channel: 1, videos_page: 1, video: 1 },
        per_user_burst: { limit: 30, window_seconds: 600 },
        per_user_daily: { limit: 300, window_seconds: 86400 },
      },
    };
  }
  if (operation === "channel") {
    return {
      id: "UC", title: "My channel", description: "", custom_url: null, thumbnail_url: null,
      published_at: null, country: null, privacy_status: "public",
      statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
    };
  }
  if (operation === "videos") return { items: [], next_page_token: null };
  return {
    id: "v", channel_id: "UC", title: "t", description: "", thumbnail_url: null, published_at: null,
    tags: [], category_id: null, default_language: null, duration_iso8601: null, privacy_status: "public",
    upload_status: null, made_for_kids: null, statistics: { view_count: null, like_count: null, comment_count: null },
    url: "https://www.youtube.com/watch?v=v",
  };
}

function envelope(data: Record<string, unknown>) {
  return {
    schema_version: 1,
    request_id: "req",
    freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" },
    data,
  };
}

describe("YouTubeManagementPage flag gating", () => {
  beforeEach(() => {
    vi.mocked(supabase.functions.invoke).mockReset();
    flags.youtubeManagement = true;
    flags.loading = false;
    accounts.data = [{ id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" }];
    accounts.isLoading = false;
    accounts.error = null;
    accounts.refetch = vi.fn();
  });

  it("sends a user without the flag to the dashboard without touching the gateway", async () => {
    flags.youtubeManagement = false;
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

  it("mounts the screen only once the flag is on", async () => {
    vi.mocked(supabase.functions.invoke).mockImplementation(async (_fn, options) => ({
      data: envelope(validDataFor((options?.body as { operation: string }).operation)),
      error: null,
    }));
    await renderAt();
    await waitFor(() => expect(supabase.functions.invoke).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: "My channel" })).toBeInTheDocument();
  });

  it("shows an accounts error with a retry instead of the empty state", async () => {
    accounts.data = [];
    accounts.error = new Error("accounts read failed");
    await renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Postora could not read your connected accounts. Nothing was changed.");
    expect(screen.queryByText("No YouTube channel is connected yet.")).not.toBeInTheDocument();
    expect(supabase.functions.invoke).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(accounts.refetch).toHaveBeenCalledTimes(1);
  });
});
