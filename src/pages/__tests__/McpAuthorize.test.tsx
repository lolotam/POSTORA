import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import McpAuthorize, { SCOPE_LABEL } from "../McpAuthorize";

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
        data: { session: { access_token: "test-token" } },
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
        "Read your posts, analytics, competitor reports, and brand analysis",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Create, schedule, and publish posts, sync analytics, track competitors, and run paid AI generation (captions, hashtags, and images)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Upload and store media in your Postora library"),
    ).toBeInTheDocument();
    expect(SCOPE_LABEL["ai:generate"]).toBe(
      "Generate captions, hashtags, and images using your paid AI quota",
    );
  });
});
