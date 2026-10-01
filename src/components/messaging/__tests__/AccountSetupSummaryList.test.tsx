import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountSetupSummaryList } from "@/components/messaging/AccountSetupSummaryList";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

describe("AccountSetupSummaryList", () => {
  it("renders one line per non-zero count and nothing for zero counts", () => {
    const summary = {
      agent_config: 1,
      connectors: 1,
      connector_links: 0,
      store_bindings: 1,
      knowledge_sources: 5,
      test_cases: 0,
      waitlist: 0,
      templates: 0,
      partner_keys_primary: 0,
      partner_key_links: 0,
      partner_webhooks: 0,
      n8n_subscriptions: 0,
      scheduled_messages: 0,
      automation_handlers: [],
    };

    render(<AccountSetupSummaryList summary={summary} />);

    // Assert non-zero counts are displayed
    expect(screen.getByText("AI agent settings")).toBeInTheDocument();
    expect(screen.getByText("1 connector")).toBeInTheDocument();
    expect(screen.getByText("1 store webhook")).toBeInTheDocument();
    expect(screen.getByText("5 knowledge sources")).toBeInTheDocument();

    // Assert nothing is rendered for zeros
    expect(screen.queryByText(/test case/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/waitlist/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/template/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/partner key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/partner webhook/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/n8n subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scheduled message/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Automation settings")).not.toBeInTheDocument();
  });

  it("renders 'Automation settings' line when automation_handlers is non-empty", () => {
    const summary = {
      agent_config: 0,
      connectors: 0,
      connector_links: 0,
      store_bindings: 0,
      knowledge_sources: 0,
      test_cases: 0,
      waitlist: 0,
      templates: 0,
      partner_keys_primary: 0,
      partner_key_links: 0,
      partner_webhooks: 0,
      n8n_subscriptions: 0,
      scheduled_messages: 0,
      automation_handlers: ["automation_handler", "comment_automation_handler"],
    };

    render(<AccountSetupSummaryList summary={summary} />);

    expect(screen.getByText("Automation settings")).toBeInTheDocument();
  });

  it("renders nothing when all counts are zero and automation_handlers is empty", () => {
    const summary = {
      agent_config: 0,
      connectors: 0,
      connector_links: 0,
      store_bindings: 0,
      knowledge_sources: 0,
      test_cases: 0,
      waitlist: 0,
      templates: 0,
      partner_keys_primary: 0,
      partner_key_links: 0,
      partner_webhooks: 0,
      n8n_subscriptions: 0,
      scheduled_messages: 0,
      automation_handlers: [],
    };

    const { container } = render(<AccountSetupSummaryList summary={summary} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });
});
