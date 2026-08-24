import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WebhookSubscriptionsCard } from "../WebhookSubscriptionsCard";
import { useWebhookSubscriptions } from "../hooks/useWebhookObservability";

vi.mock("../hooks/useWebhookObservability", () => ({
  useWebhookSubscriptions: vi.fn(),
}));

const mockHook = vi.mocked(useWebhookSubscriptions);

function mockResult(overrides: Record<string, unknown>) {
  mockHook.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    ...overrides,
  } as ReturnType<typeof useWebhookSubscriptions>);
}

describe("WebhookSubscriptionsCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("tells the user that test-mode listening does not register a trigger", () => {
    mockResult({ data: [] });
    render(<WebhookSubscriptionsCard />);

    // The whole point of the empty state. A user whose workflow is only listening in the
    // n8n editor has zero rows here, and previously the only evidence of that lived in
    // edge-function logs they cannot see.
    expect(screen.getByText("No triggers registered.")).toBeInTheDocument();
    expect(screen.getByText(/Save and Activate/)).toBeInTheDocument();
  });

  it("shows a subscription with its events and registry", () => {
    mockResult({
      data: [
        {
          registry: "n8n",
          webhook_id: "wh-1",
          webhook_url: "https://n8n.example.com/webhook/abc/postora",
          events: ["message.received", "comment.received"],
          platform: null,
          social_account_id: null,
          is_active: true,
          failure_count: 0,
          created_at: "2026-08-24T14:36:38Z",
        },
      ],
    });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText("https://n8n.example.com/webhook/abc/postora")).toBeInTheDocument();
    expect(screen.getByText("n8n trigger")).toBeInTheDocument();
    expect(screen.getByText("message.received")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("labels a legacy WhatsApp destination as such", () => {
    // These live in whatsapp_webhooks, not app_settings. Dispatch reads both registries,
    // so a card that showed only one would under-report what is actually listening.
    mockResult({
      data: [
        {
          registry: "legacy",
          webhook_id: "legacy-1",
          webhook_url: "https://hooks.example.com/wa",
          events: null,
          platform: null,
          social_account_id: null,
          is_active: true,
          failure_count: 0,
          created_at: null,
        },
      ],
    });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText("WhatsApp webhook")).toBeInTheDocument();
  });

  it("explains an auto-disabled subscription rather than just showing it as inactive", () => {
    mockResult({
      data: [
        {
          registry: "n8n",
          webhook_id: "wh-dead",
          webhook_url: "https://n8n.example.com/webhook/dead/postora",
          events: ["message.received"],
          platform: null,
          social_account_id: null,
          is_active: false,
          failure_count: 10,
          created_at: null,
        },
      ],
    });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText("Auto-disabled")).toBeInTheDocument();
    expect(screen.getByText(/stopped\s+sending to this URL/)).toBeInTheDocument();
  });

  it("warns about failures on a subscription that is still active", () => {
    mockResult({
      data: [
        {
          registry: "n8n",
          webhook_id: "wh-flaky",
          webhook_url: "https://n8n.example.com/webhook/flaky/postora",
          events: ["comment.received"],
          platform: "threads",
          social_account_id: null,
          is_active: true,
          failure_count: 7,
          created_at: null,
        },
      ],
    });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText(/7 recent delivery failures/)).toBeInTheDocument();
    expect(screen.getByText("threads only")).toBeInTheDocument();
  });

  it("renders a loading state", () => {
    mockResult({ isLoading: true });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText(/Loading subscriptions/)).toBeInTheDocument();
  });

  it("renders an error state instead of an empty one", () => {
    // Distinct from "no triggers": telling a user they have nothing registered when the
    // query merely failed would send them off to re-activate a working workflow.
    mockResult({ error: new Error("boom") });
    render(<WebhookSubscriptionsCard />);

    expect(screen.getByText(/Could not load your webhook subscriptions/)).toBeInTheDocument();
    expect(screen.queryByText("No triggers registered.")).not.toBeInTheDocument();
  });
});
