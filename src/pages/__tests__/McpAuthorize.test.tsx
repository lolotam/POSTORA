import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import McpAuthorize from "../McpAuthorize";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "owner@postora.cloud" },
    isLoading: false,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: null },
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      })),
    })),
  },
}));

describe("McpAuthorize consent screen disclosures", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_id: "auth-123",
          client: {
            client_id: "client-1",
            client_name: "Claude Desktop",
          },
          redirect_uri: "http://localhost:3333/callback",
          scopes: ["posts:read", "posts:write", "media:write"],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders analytics, competitor report, and paid AI generation disclosures for granted scopes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/mcp/authorize?authorization_id=auth-123"]}>
          <McpAuthorize />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Claude Desktop wants to access your Postora account/i),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        "Read your posts, media library, analytics, competitor reports, brand analysis, and run paid AI best-time suggestions",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Create, schedule, publish, and delete posts (including platform copies and media), sync analytics, track competitors, and run paid AI generation (captions, hashtags, and images; post creation and image generation also require media:write)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Upload and store media in your Postora library"),
    ).toBeInTheDocument();
  });

  it("discloses that post creation and image generation require media:write when only posts:write is requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_id: "auth-456",
          client: {
            client_id: "client-1",
            client_name: "Claude Desktop",
          },
          redirect_uri: "http://localhost:3333/callback",
          scopes: ["posts:write"],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/mcp/authorize?authorization_id=auth-456"]}>
          <McpAuthorize />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText(
        "Create, schedule, publish, and delete posts (including platform copies and media), sync analytics, track competitors, and run paid AI generation (captions, hashtags, and images; post creation and image generation also require media:write)",
      ),
    ).toBeInTheDocument();
  });
});
