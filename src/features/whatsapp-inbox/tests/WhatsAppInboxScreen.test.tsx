import type { ReactElement, ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Message, MessagingAccount } from "@/hooks/useMessaging";
import { WhatsAppChromeProvider } from "@/components/whatsapp/WhatsAppChromeContext";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppMediaScope } from "../application/useWhatsAppMedia";
import { WhatsAppConversationPane } from "../ui/WhatsAppConversationPane";
import { WhatsAppInboxApiProvider } from "../ui/WhatsAppInboxApiProvider";
import { WhatsAppInboxScreen } from "../ui/WhatsAppInboxScreen";

const testState = vi.hoisted(() => ({
  accounts: [] as MessagingAccount[],
  conversations: [] as Conversation[],
  messages: [] as Message[],
  sendMessage: vi.fn(),
  fetchOlder: vi.fn(),
  hasOlder: false,
}));

vi.mock("@/hooks/useMessaging", () => ({
  useMessagingAccounts: () => ({ accounts: testState.accounts, isLoading: false }),
  useConversations: () => ({ data: testState.conversations, isLoading: false }),
  useMessages: () => ({ data: testState.messages, isLoading: false }),
  useSendMessage: () => ({ mutate: testState.sendMessage, isPending: false }),
  useMarkConversationRead: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@/components/whatsapp/WhatsAppWorkspaceProvider", () => ({
  useWhatsAppWorkspaceContext: () => ({ activeRole: "owner" }),
}));

vi.mock("../application/useWhatsAppMessages", () => ({
  useWhatsAppMessages: () => ({
    messages: testState.messages,
    pinned: [],
    isLoading: false,
    hasOlder: testState.hasOlder,
    isFetchingOlder: false,
    fetchOlder: testState.fetchOlder,
  }),
}));

vi.mock("../application/useWhatsAppMessageActions", () => ({
  HIDDEN_UNDO_MS: 8_000,
  useWhatsAppMessageActions: () => ({
    pin: vi.fn(),
    unpin: vi.fn(),
    hide: vi.fn(),
    unhide: vi.fn(),
    revoke: vi.fn(),
    isRevoking: false,
  }),
}));

vi.mock("@/components/messaging/QuickReplyPicker", () => ({
  QuickReplyPicker: () => <div>Quick replies</div>,
  SlashCommandSuggestions: () => null,
}));

vi.mock("@/components/messaging/InteractiveMessageBuilder", () => ({
  InteractiveMessageBuilder: () => <div>Interactive</div>,
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

const fakeApi: WhatsAppInboxApi = {
  getMessagesPage: vi.fn(async () => ({ messages: [] })),
  getMedia: vi.fn(async () => ({ media: [] })),
  sendMedia: vi.fn(async () => ({})),
  sendInteractive: vi.fn(async () => ({})),
  getConversationState: vi.fn(async () => ({ flags: [], pinned: [], mutable: [] })),
  setMessageFlag: vi.fn(async ({ message_row_id }) => ({
    flag: { message_row_id, pinned_at: null, hidden_at: null },
  })),
  revokeMessage: vi.fn(async () => ({ success: true, revoked_at: "2026-08-25T12:00:00.000Z" })),
  sendVoice: vi.fn(async () => ({ success: true, message_id: "3EB0" })),
};

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWithProviders(
  ui: ReactElement,
  options: { accounts?: MessagingAccount[]; route?: string; withInboxApi?: boolean } = {},
) {
  testState.accounts = options.accounts ?? [account];
  const inner = options.withInboxApi ? (
    <WhatsAppInboxApiProvider api={fakeApi}>
      <WhatsAppMediaScope socialAccountId={account.id}>{ui}</WhatsAppMediaScope>
    </WhatsAppInboxApiProvider>
  ) : ui;
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <MemoryRouter initialEntries={[options.route ?? "/messaging/whatsapp/conversations"]}>
        <WhatsAppChromeProvider>{inner}</WhatsAppChromeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WhatsAppInboxScreen", () => {
  beforeEach(() => {
    testState.accounts = [account];
    testState.conversations = [conversation];
    testState.messages = [];
    testState.hasOlder = false;
    testState.fetchOlder.mockReset();
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
      { withInboxApi: true },
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

// Regression, 2026-08-25: the Phase 1 brief described the pane as a port of
// ConversationDetail.tsx:240-284 -- a range that stops just short of the composer at :312-366.
// Both implementers followed it literally, and the forked screen shipped read-only: no text
// box, no attachments, no quick replies. Reading a WhatsApp inbox you cannot reply in is a
// regression against the screen this replaces.
describe("WhatsAppConversationPane composer", () => {
  it("can send a message", () => {
    testState.messages = [];
    renderWithProviders(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId="account-1"
        pageId="96550000000"
        onScrollStateChange={() => {}}
      />,
      { withInboxApi: true },
    );

    const box = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(testState.sendMessage).toHaveBeenCalled();
    expect(testState.sendMessage.mock.calls[0][0]).toMatchObject({
      message: "hello",
      platform: "whatsapp",
      recipientPhone: conversation.participant_id,
    });
  });

  it("offers attachment and quick-reply affordances", () => {
    testState.messages = [];
    renderWithProviders(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId="account-1"
        pageId="96550000000"
        onScrollStateChange={() => {}}
      />,
      { withInboxApi: true },
    );

    expect(screen.getByRole("button", { name: /attach a file/i })).toBeInTheDocument();
    expect(screen.getByText("Quick replies")).toBeInTheDocument();
  });
});

function bubble(id: string, createdTime: string): Message {
  return {
    id,
    message: id,
    from: { name: "Ada", id: "1" },
    to: [{ name: "", id: "2" }],
    created_time: createdTime,
    attachments: [],
  };
}

describe("WhatsAppConversationPane message scroll", () => {
  let scrollTopAssignments: number[];
  let currentScrollTop: number;
  let currentScrollHeight: number;
  let observerCallback: IntersectionObserverCallback | null;

  function renderPane() {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter>
          <WhatsAppChromeProvider>
            <WhatsAppInboxApiProvider api={fakeApi}>
              <WhatsAppMediaScope socialAccountId={account.id}>{children}</WhatsAppMediaScope>
            </WhatsAppInboxApiProvider>
          </WhatsAppChromeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    return render(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId={account.id}
        pageId={account.platform_user_id}
        onScrollStateChange={() => undefined}
      />,
      { wrapper },
    );
  }

  beforeEach(() => {
    scrollTopAssignments = [];
    currentScrollTop = 0;
    currentScrollHeight = 1000;
    observerCallback = null;
    testState.hasOlder = true;
    testState.messages = [
      bubble("a", "2026-08-25T12:00:00.000Z"),
      bubble("b", "2026-08-25T12:00:01.000Z"),
    ];
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() { return currentScrollHeight; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() { return 100; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() { return currentScrollTop; },
      set(value: number) {
        scrollTopAssignments.push(value);
        currentScrollTop = value;
      },
    });
    HTMLElement.prototype.scrollTo = vi.fn(function scrollTo(this: HTMLElement, arg?: ScrollToOptions | number) {
      if (typeof arg === "object" && arg && typeof arg.top === "number") {
        this.scrollTop = arg.top;
      }
    }) as typeof HTMLElement.prototype.scrollTo;
    window.IntersectionObserver = class {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
    } as typeof IntersectionObserver;
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();
  });

  // 2026-08-25: the pane force-scrolled to the bottom on every 15s poll because the effect
  // keyed on the raw query array, whose identity changes on each refetch.
  it("selecting a conversation sets scrollTop once and never calls scrollIntoView", () => {
    const view = renderPane();
    expect(scrollTopAssignments).toEqual([1000]);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    testState.messages = testState.messages.map((message) => ({ ...message }));
    view.rerender(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId={account.id}
        pageId={account.platform_user_id}
        onScrollStateChange={() => undefined}
      />,
    );
    expect(scrollTopAssignments).toEqual([1000]);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("a refetch returning the same page does not re-scroll", () => {
    const view = renderPane();
    scrollTopAssignments = [];
    (HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>).mockClear();

    testState.messages = testState.messages.map((message) => ({ ...message }));
    view.rerender(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId={account.id}
        pageId={account.platform_user_id}
        onScrollStateChange={() => undefined}
      />,
    );
    expect(scrollTopAssignments).toEqual([]);
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("a prepended page preserves the anchor", () => {
    const view = renderPane();
    currentScrollTop = 0;
    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(testState.fetchOlder).toHaveBeenCalled();

    currentScrollHeight = 1400;
    testState.messages = [bubble("older", "2026-08-25T11:59:00.000Z"), ...testState.messages];
    view.rerender(
      <WhatsAppConversationPane
        conversation={conversation}
        socialAccountId={account.id}
        pageId={account.platform_user_id}
        onScrollStateChange={() => undefined}
      />,
    );
    expect(currentScrollTop).toBe(400);
  });
});
