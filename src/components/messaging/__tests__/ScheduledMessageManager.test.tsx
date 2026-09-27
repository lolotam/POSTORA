import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMessage } from "@/hooks/useWhatsAppScheduledMessages";

const state = vi.hoisted(() => ({
  messages: [] as ScheduledMessage[],
  isLoading: false,
  accounts: [] as { id: string; platform_username: string | null; platform_user_id: string; connection_mode: string | null }[],
  accountsLoading: false,
  accountsError: false,
  schedule: { mutate: vi.fn(), isPending: false },
  cancel: { mutate: vi.fn(), isPending: false },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === "string" ? fallback : key),
  }),
}));

vi.mock("@/hooks/useWhatsAppScheduledMessages", () => ({
  SCHEDULED_CANCEL_BLOCKED: "This message is already being sent and can no longer be cancelled.",
  SCHEDULED_OWN_ACCOUNT_ONLY: "You can only schedule from your own WhatsApp accounts.",
  WHATSAPP_MESSAGE_MAX: 4096,
  useWhatsAppScheduledMessages: () => state,
}));

import { ScheduledMessageManager } from "@/components/messaging/ScheduledMessageManager";

function row(id: string, status: string, errorMessage: string | null = null): ScheduledMessage {
  return {
    id,
    social_account_id: "acc-1",
    recipient_phone: "+96550001111",
    recipient_name: null,
    message_text: "hello",
    media_url: null,
    media_type: null,
    scheduled_at: "2026-09-27T12:00:00Z",
    status,
    sent_at: null,
    error_message: errorMessage,
    created_at: "2026-09-27T11:00:00Z",
  };
}

describe("ScheduledMessageManager", () => {
  beforeEach(() => {
    state.messages = [];
    state.isLoading = false;
  });

  it("describes how to add the first scheduled message", () => {
    render(<ScheduledMessageManager />);
    expect(screen.getByText("No scheduled messages yet. Use \"Schedule message\" to add one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule message" })).toBeInTheDocument();
  });

  it("labels claimed and sending rows as sending and cancels only pending rows", () => {
    state.messages = [
      row("pending", "pending"),
      row("claimed", "claimed"),
      row("sending", "sending"),
      row("skipped", "skipped"),
      row("failed", "failed", "outside_session_window"),
    ];
    render(<ScheduledMessageManager />);
    expect(screen.getAllByText("sending")).toHaveLength(2);
    expect(screen.getByText("skipped (opted out)")).toBeInTheDocument();
    expect(screen.getByText("outside_session_window")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
  });
});
