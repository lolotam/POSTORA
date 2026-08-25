import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message, MessagingAccount } from "@/hooks/useMessaging";
import { WhatsAppChromeProvider } from "@/components/whatsapp/WhatsAppChromeContext";
import { WhatsAppInboxScreen } from "../ui/WhatsAppInboxScreen";
import { WhatsAppConversationPane } from "../ui/WhatsAppConversationPane";

const testState = vi.hoisted(() => ({
  accounts: [] as MessagingAccount[],
  conversations: [] as Conversation[],
  messages: [] as Message[],
}));

vi.mock("@/hooks/useMessaging", () => ({
  useMessagingAccounts: () => ({ accounts: testState.accounts, isLoading: false }),
  useConversations: () => ({ data: testState.conversations, isLoading: false }),
  useMessages: () => ({ data: testState.messages, isLoading: false }),
}));

vi.mock("@/hooks/useWhatsAppLabels", () => ({
  useWhatsAppLabels: () => ({ assignments: [] }),
}));

vi.mock("@/components/messaging/AccountSelector", () => ({
  AccountSelector: ({ accounts, onSelect }: { accounts: MessagingAccount[]; onSelect(id: string): void }) => (
    <button type="button" onClick={() => onSelect(accounts[0]?.id)}>Select account</button>
  ),
}));

vi.mock("@/components/messaging/ConversationList", () => ({
  ConversationList: ({ conversations, onSelect }: { conversations: Conversation[]; onSelect(conversation: Conversation): void }) => (
    <div>
      {conversations.map((conversation) => (
        <button key={conversation.id} type="button" onClick={() => onSelect(conversation)}>
          {conversation.participant_name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/messaging/ConversationLabels", () => ({
  LabelFilter: () => <div>Labels</div>,
}));

vi.mock("@/components/messaging/NewConversationDialog", () => ({
  NewConversationDialog: () => null,
}));

vi.mock("@/components/messaging/WhatsAppSetup", () => ({
  WhatsAppSetup: () => <div>WhatsApp setup content</div>,
}));

vi.mock("@/components/messaging/WhatsAppCoexistenceSetupBanner", () => ({
  WhatsAppCoexistenceSetupBanner: () => <div>Coexistence setup</div>,
}));

vi.mock("@/components/messaging/AiConversationModeSelect", () => ({
  AiConversationModeSelect: () => <div>AI mode</div>,
}));

const account: MessagingAccount = {
  id: "account-1",
  platform: "whatsapp",
  platform_user_id: "96550000000",
  platform_username: "Support",
  avatar_url: null,
  connection_mode: "evolution_qr",
};

const conversation: Conversation = {
  id: "wa_96550000000_96551111111",
  cache_id: "11111111-1111-4111-8111-111111111111",
  participant_name: "Customer",
  participant_id: "96551111111",
  participant_avatar: null,
  last_message: "Hello",
  last_message_time: "2026-08-25T10:00:00.000Z",
  last_message_from: "96551111111",
  unread_count: 0,
  updated_time: "2026-08-25T10:00:00.000Z",
};

function renderWithProviders(
  ui: ReactElement,
  options: { accounts?: MessagingAccount[]; route?: string } = {},
) {
  testState.accounts = options.accounts ?? [account];
  return render(
    <MemoryRouter initialEntries={[options.route ?? "/messaging/whatsapp/conversations"]}>
      <WhatsAppChromeProvider>{ui}</WhatsAppChromeProvider>
    </MemoryRouter>,
  );
}

describe("WhatsAppInboxScreen", () => {
  beforeEach(() => {
    testState.accounts = [account];
    testState.conversations = [conversation];
    testState.messages = [];
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression guard, 2026-08-25: the chat was a hard h-[600px] inside a min-h-[640px] page
  // inside an overflow-y-auto main, giving nested scrollbars and dead space on tall screens.
  it("sizes to its flex parent instead of a fixed pixel height", () => {
    renderWithProviders(<WhatsAppInboxScreen />);
    const shell = screen.getByTestId("wa-inbox-shell");
    expect(shell.className).toContain("min-h-0");
    expect(shell.className).not.toMatch(/h-\[\d+px\]/);
  });

  it("keeps the setup panel expanded and non-collapsible with no account connected", () => {
    renderWithProviders(<WhatsAppInboxScreen />, { accounts: [] });
    expect(screen.getByTestId("wa-setup-panel")).toBeVisible();
    expect(screen.queryByRole("button", { name: /connection details/i })).not.toBeInTheDocument();
  });

  it("renders the conversation list and thread as siblings that each scroll independently", async () => {
    renderWithProviders(<WhatsAppInboxScreen />);
    expect(await screen.findByTestId("wa-conversation-list")).toHaveClass("min-h-0");
    expect(screen.getByTestId("wa-message-pane")).toHaveClass("overflow-y-auto");
  });

  it("shows one mobile pane at a time with a back affordance", async () => {
    renderWithProviders(<WhatsAppInboxScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Customer" }));

    expect(screen.getByTestId("wa-conversation-list")).toHaveClass("hidden", "lg:flex");
    expect(screen.getByRole("button", { name: /back to conversations/i })).toHaveClass("lg:hidden");

    fireEvent.click(screen.getByRole("button", { name: /back to conversations/i }));
    await waitFor(() => expect(screen.getByTestId("wa-conversation-list")).not.toHaveClass("hidden"));
  });

  // Regression guard, 2026-08-25: a stale chat id must not silently open a neighbouring chat.
  it("selects nothing for an unknown deep-linked chat id", async () => {
    renderWithProviders(<WhatsAppInboxScreen />, {
      route: "/messaging/whatsapp/conversations?chat=22222222-2222-4222-8222-222222222222",
    });

    await screen.findByTestId("wa-message-pane");
    expect(screen.getByText("Select a conversation")).toBeInTheDocument();
  });
});

describe("WhatsAppConversationPane scroll state", () => {
  let animationFrames: FrameRequestCallback[];

  beforeEach(() => {
    testState.messages = [];
    animationFrames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Regression guard, 2026-08-25: a single threshold made the shell header flicker near its edge.
  it("uses position-based hysteresis with an unchanged dead band", () => {
    const onScrollStateChange = vi.fn();
    renderWithProviders(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId={account.id}
        pageId={account.platform_user_id}
        onScrollStateChange={onScrollStateChange}
      />,
    );
    const pane = screen.getByTestId("wa-message-pane");
    onScrollStateChange.mockClear();

    fireEvent.scroll(pane, { target: { scrollTop: 73 } });
    act(() => animationFrames.shift()?.(0));
    expect(onScrollStateChange).toHaveBeenLastCalledWith(true);

    onScrollStateChange.mockClear();
    fireEvent.scroll(pane, { target: { scrollTop: 48 } });
    act(() => animationFrames.shift()?.(0));
    expect(onScrollStateChange).not.toHaveBeenCalled();

    fireEvent.scroll(pane, { target: { scrollTop: 23 } });
    act(() => animationFrames.shift()?.(0));
    expect(onScrollStateChange).toHaveBeenLastCalledWith(false);
  });
});
