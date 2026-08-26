import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const save = { mutate: vi.fn(), isPending: false };
const handlers = {
  social_account_id: "a1",
  platform: "instagram",
  automation_handler: "internal",
  comment_automation_handler: "off",
};

vi.mock("@/hooks/useAutomationHandlers", () => ({
  useAutomationHandlers: () => ({ handlers, isLoading: false, save }),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const accounts = [
  { id: "a1", platform: "instagram", platform_username: "mybrand", platform_user_id: "1789", is_active: true },
  { id: "t1", platform: "threads", platform_username: "mybrand", platform_user_id: "th-1", is_active: true },
  { id: "w1", platform: "whatsapp", platform_username: "mybrand", platform_user_id: "96599", is_active: true },
];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts }),
}));

import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";

describe("AutomationHandlerCard", () => {
  beforeEach(() => save.mutate.mockReset());

  it("shows a Messages and a Comments row for Instagram", () => {
    render(<AutomationHandlerCard platform="instagram" />);

    expect(screen.getByText("Incoming Messages")).toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(screen.getByTestId("messages-handler")).toHaveTextContent("Postora AI Agent");
    expect(screen.getByTestId("comments-handler")).toHaveTextContent("Off");
  });

  it("hides the Messages row on Threads, which has no DM API", () => {
    render(<AutomationHandlerCard platform="threads" />);

    expect(screen.queryByText("Messages")).not.toBeInTheDocument();
    expect(screen.getByText("Comments")).toBeInTheDocument();
  });

  it("renders nothing when no account of that platform is connected", () => {
    const { container } = render(<AutomationHandlerCard platform="facebook" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lets the Postora AI Agent be chosen for comments and saves it", async () => {
    // The option shipped disabled behind a "Coming in a later update" hint until the agent
    // could actually answer public comments. Choosing it has to reach the comments field, not
    // the messages one -- swapping those would silently retarget the account's DM automation.
    render(<AutomationHandlerCard platform="instagram" />);

    fireEvent.keyDown(screen.getByTestId("comments-handler"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Postora AI Agent" }));

    expect(save.mutate).toHaveBeenCalledWith({ comment_automation_handler: "internal" }, expect.objectContaining({ onError: expect.any(Function) }));
  });

  // Regression, 2026-08-26: the server rejected "Postora AI Agent" for comments with a 400
  // and the card swallowed it, so the Select just snapped back to n8n -- reported as "the
  // dropdown refuses to change". A rejection must be visible.
  it("reports a rejected save instead of silently snapping back", async () => {
    save.mutate.mockImplementation((_patch, options) =>
      options?.onError?.(new Error("The Postora AI agent does not handle comments yet")),
    );
    render(<AutomationHandlerCard platform="instagram" />);

    fireEvent.keyDown(screen.getByTestId("comments-handler"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Postora AI Agent" }));

    expect(toastError).toHaveBeenCalledWith(
      "Could not change the automation handler",
      expect.objectContaining({ description: "The Postora AI agent does not handle comments yet" }),
    );
  });

  it("hides the Comments row on WhatsApp, which has no public comments", () => {
    render(<AutomationHandlerCard platform="whatsapp" />);

    expect(screen.getByText("Incoming Messages")).toBeInTheDocument();
    expect(screen.queryByText("Comments")).not.toBeInTheDocument();
    // The public-reply warning belongs to the Comments row; showing it here would describe
    // automation this account cannot run.
    expect(screen.queryByText("publicly")).not.toBeInTheDocument();
  });

  it("warns that the comment agent replies in public", () => {
    // Choosing "Postora AI Agent" here starts posting under the account's own posts. The
    // card is the only place a user is told that before it happens.
    render(<AutomationHandlerCard platform="instagram" />);
    expect(screen.getByText("publicly")).toBeInTheDocument();
  });
});
