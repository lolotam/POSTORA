import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const emptyRules = {
  rules: [],
  isLoading: false,
  createRule: { mutate: vi.fn(), isPending: false },
  updateRule: { mutate: vi.fn(), isPending: false },
  deleteRule: { mutate: vi.fn(), isPending: false },
  toggleRule: { mutate: vi.fn(), isPending: false },
};

vi.mock("@/hooks/useWhatsAppAutoReplies", () => ({ useWhatsAppAutoReplies: () => emptyRules }));
vi.mock("@/hooks/useMessengerAutoReplies", () => ({ useMessengerAutoReplies: () => emptyRules }));

import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";

// One rule table drives three different surfaces. Copy that names the wrong one sends users
// to write private-inbox wording for a public post, or to expect a DM reply on a platform
// that has no DMs.
describe("AutoReplyManager surface copy", () => {
  it("promises messages only on WhatsApp, which has no comments", () => {
    render(<AutoReplyManager />);
    expect(screen.getByText(/for incoming messages$/i)).toBeInTheDocument();
  });

  it("names both messages and public comments on Facebook and Instagram", () => {
    for (const platform of ["facebook", "instagram"] as const) {
      const { unmount } = render(<AutoReplyManager platform={platform} />);
      expect(screen.getByText(/incoming messages and public comments/i)).toBeInTheDocument();
      unmount();
    }
  });

  it("promises only public replies on Threads, which has no DM API", () => {
    render(<AutoReplyManager platform="threads" />);

    expect(screen.getByText(/public replies to comments and mentions/i)).toBeInTheDocument();
    expect(screen.queryByText(/incoming messages/i)).not.toBeInTheDocument();
    expect(screen.getByText(/reply publicly when a comment or mention matches/i)).toBeInTheDocument();
  });
});
