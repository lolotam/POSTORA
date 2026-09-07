import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingInboxPlatform } from "@/components/messaging/MessagingInbox";
import type { WhatsAppInboxApi, WhatsAppMessage } from "@/features/whatsapp-inbox/application/ports";
import type { Conversation, MessagingAccount } from "@/hooks/useMessaging";
import UnifiedInboxesPage from "../UnifiedInboxesPage";

type WhatsAppRejected = Extract<MessagingInboxPlatform, "whatsapp">;
const messagingInboxRejectsWhatsApp: [WhatsAppRejected] extends [never] ? true : never = true;

const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ACCOUNT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CHAT_ID = "cccccccc-0000-4000-8000-00000000000c";
const IMAGE_ROW = "dddddddd-0000-4000-8000-00000000000d";
const PDF_ROW = "eeeeeeee-0000-4000-8000-00000000000e";
const AUDIO_ROW = "ffffffff-0000-4000-8000-00000000000f";
const WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

const testState = vi.hoisted(() => {
  const getMedia = vi.fn();
  const api: WhatsAppInboxApi = {
    downloadBlob: vi.fn(),
    getMessagesPage: vi.fn(async () => ({ messages: [] })),
    getMedia: ((...args: Parameters<WhatsAppInboxApi["getMedia"]>) => getMedia(...args)) as WhatsAppInboxApi["getMedia"],
    sendMedia: vi.fn(async () => ({})),
    sendInteractive: vi.fn(async () => ({})),
    getConversationState: vi.fn(async () => ({ flags: [], pinned: [], mutable: [] })),
    setMessageFlag: vi.fn(async ({ message_row_id }) => ({
      flag: { message_row_id, pinned_at: null, hidden_at: null },
    })),
    revokeMessage: vi.fn(async () => ({ success: true, revoked_at: "2026-09-07T12:00:00.000Z" })),
    sendVoice: vi.fn(async () => ({ success: true, message_id: "3EB0" })),
    forwardMessage: vi.fn(async () => ({ success: true, message_id: "3EB1" })),
    deleteConversation: vi.fn(async () => ({ success: true })),
  };
  return {
    accounts: [] as MessagingAccount[],
    conversations: [] as Conversation[],
    messages: [] as WhatsAppMessage[],
    getMedia,
    api,
    markReadRequest: vi.fn(),
  };
});

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: {
      msgWhatsapp: true,
      msgFacebook: true,
      msgInstagram: true,
      msgThreads: true,
      commentManager: true,
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-user-id", email: "test@example.com" },
    session: {},
  }),
}));

vi.mock("@/hooks/useUserRole", () => ({
  useUserRole: () => ({
    role: "admin",
    isAdmin: true,
    isSubscriber: true,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useMessaging", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useMessaging")>("@/hooks/useMessaging");
  return {
    ...actual,
    useMessagingAccounts: () => ({ accounts: testState.accounts, isLoading: false }),
    useConversations: () => ({ data: testState.conversations, isLoading: false, error: null }),
    useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useWhatsAppLabels", () => ({
  useWhatsAppLabels: () => ({ assignments: [] }),
}));

vi.mock("@/hooks/useWhatsAppWorkspace", () => ({
  useWorkspaces: () => ({
    data: [{ id: WORKSPACE_ID, name: "Personal", is_personal: true, role: "owner", member_count: 1 }],
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

vi.mock("@/components/messaging/MessagingInbox", () => ({
  MessagingInbox: ({ platform }: { platform: string }) => <div data-testid="messaging-inbox">{platform}</div>,
}));

vi.mock("@/components/messaging/AutomationHandlerCard", () => ({
  AutomationHandlerCard: ({ platform }: { platform: string }) => (
    <div data-testid="automation-handler">{platform}</div>
  ),
}));

vi.mock("@/components/messaging/AccountSelector", () => ({
  AccountSelector: ({ selectedId }: { selectedId: string | null }) => (
    <div data-testid="selected-account">{selectedId}</div>
  ),
}));

vi.mock("@/components/messaging/ConversationList", () => ({
  ConversationList: ({
    conversations,
    onSelect,
  }: {
    conversations: Conversation[];
    onSelect(conversation: Conversation): void;
  }) => (
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

vi.mock("@/components/messaging/QuickReplyPicker", () => ({
  QuickReplyPicker: () => <div>Quick replies</div>,
  SlashCommandSuggestions: () => null,
}));

vi.mock("@/components/messaging/InteractiveMessageBuilder", () => ({
  InteractiveMessageBuilder: () => <div>Interactive</div>,
}));

vi.mock("@/components/messaging/WhatsAppSetup", () => ({
  WhatsAppSetup: () => <div>WhatsApp setup content</div>,
}));

vi.mock("@/components/messaging/WhatsAppCoexistenceSetupBanner", () => ({
  WhatsAppCoexistenceSetupBanner: () => <div>Coexistence setup</div>,
}));

vi.mock("@/features/whatsapp-inbox/application/useWhatsAppMessages", () => ({
  useWhatsAppMessages: () => ({
    messages: testState.messages,
    pinned: [],
    isLoading: false,
    hasOlder: false,
    isFetchingOlder: false,
    fetchOlder: vi.fn(),
  }),
  waHistoryQueryKey: () => ["wa-history"],
  waLatestQueryKey: () => ["wa-latest"],
}));

vi.mock("@/features/whatsapp-inbox/application/useWhatsAppMessageActions", () => ({
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

vi.mock("@/features/whatsapp-inbox/infrastructure/whatsappInboxApi", () => ({
  createWhatsAppInboxApi: () => testState.api,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } } }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-uuid" } } }),
    },
    storage: { from: () => ({ upload: vi.fn(), getPublicUrl: vi.fn() }) },
    from: () => ({ insert: vi.fn() }),
  },
}));

const firstAccount: MessagingAccount = {
  id: ACCOUNT_A,
  platform: "whatsapp",
  platform_user_id: "96550000000",
  platform_username: "First",
  avatar_url: null,
  connection_mode: "evolution_qr",
};

const qrAccount: MessagingAccount = {
  ...firstAccount,
  id: ACCOUNT_B,
  platform_username: "Support",
};

const conversation: Conversation = {
  id: "wa_96550000000_96551111111",
  cache_id: CHAT_ID,
  participant_name: "Customer",
  participant_id: "96551111111",
  participant_avatar: null,
  last_message: "Hello",
  last_message_time: "2026-09-07T10:00:00.000Z",
  last_message_from: "96551111111",
  unread_count: 0,
  updated_time: "2026-09-07T10:00:00.000Z",
};

const mediaMessages: WhatsAppMessage[] = [
  {
    id: IMAGE_ROW,
    message: "",
    from: { name: "Customer", id: "96551111111" },
    to: [],
    created_time: "2026-09-07T10:00:00.000Z",
    attachments: [{
      kind: "image",
      message_row_id: IMAGE_ROW,
      mime_type: "image/jpeg",
      name: "photo.jpg",
      needs_fetch: true,
      file_url: null,
    }],
  },
  {
    id: PDF_ROW,
    message: "",
    from: { name: "Customer", id: "96551111111" },
    to: [],
    created_time: "2026-09-07T10:01:00.000Z",
    attachments: [{
      kind: "document",
      message_row_id: PDF_ROW,
      mime_type: "application/pdf",
      name: "invoice.pdf",
      needs_fetch: true,
      file_url: null,
    }],
  },
  {
    id: AUDIO_ROW,
    message: "",
    from: { name: "Customer", id: "96551111111" },
    to: [],
    created_time: "2026-09-07T10:02:00.000Z",
    attachments: [{
      kind: "audio",
      message_row_id: AUDIO_ROW,
      mime_type: "audio/ogg",
      name: "note.ogg",
      needs_fetch: true,
      file_url: null,
      duration_seconds: 4,
    }],
  },
];

function renderPage(route = "/messaging") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <UnifiedInboxesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("UnifiedInboxesPage", () => {
  beforeEach(() => {
    testState.accounts = [];
    testState.conversations = [];
    testState.messages = [];
    testState.getMedia.mockReset().mockImplementation(async ({ message_row_ids }: { message_row_ids: string[] }) => ({
      media: message_row_ids.map((id) => {
        if (id === IMAGE_ROW) {
          return {
            message_row_id: id,
            kind: "image" as const,
            url: "https://signed.example/photo.jpg",
            mime_type: "image/jpeg",
            file_name: "photo.jpg",
          };
        }
        if (id === PDF_ROW) {
          return {
            message_row_id: id,
            kind: "document" as const,
            url: "https://signed.example/doc.pdf",
            mime_type: "application/pdf",
            file_name: "invoice.pdf",
          };
        }
        if (id === AUDIO_ROW) {
          return {
            message_row_id: id,
            kind: "audio" as const,
            url: "https://signed.example/note.ogg",
            mime_type: "audio/ogg",
          };
        }
        return { message_row_id: id, kind: "document" as const, url: null, error: "MEDIA_UNAVAILABLE" as const };
      }),
    }));
    testState.markReadRequest.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.action === "whatsapp_mark_read") {
        return testState.markReadRequest(body).then((response: Response) => response.clone());
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the unified inboxes page header and 3D channel cards", () => {
    renderPage();
    expect(screen.getByText("Unified Inboxes")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /WhatsApp/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Facebook/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Instagram/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Threads/i })).not.toBeInTheDocument();
  });

  it.each(["facebook", "instagram"] as const)(
    "places the %s automation handler under the channel icons, above the inbox",
    (platform) => {
      renderPage(`/messaging?platform=${platform}`);
      const tabs = screen.getByRole("tablist", { name: "Inbox Channels" });
      const handler = screen.getByTestId("automation-handler");
      const inbox = screen.getByTestId("messaging-inbox");
      expect(handler).toHaveTextContent(platform);
      expect(tabs.compareDocumentPosition(handler) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(handler.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  it("places the WhatsApp automation handler above the feature inbox shell", async () => {
    expect(messagingInboxRejectsWhatsApp).toBe(true);
    renderPage("/messaging?platform=whatsapp");
    const tabs = screen.getByRole("tablist", { name: "Inbox Channels" });
    const handler = screen.getByTestId("automation-handler");
    const shell = await screen.findByTestId("wa-inbox-shell");
    expect(handler).toHaveTextContent("whatsapp");
    expect(tabs.compareDocumentPosition(handler) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(handler.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("messaging-inbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open full whatsapp studio/i })).toBeInTheDocument();
  });

  it("redirects legacy ?platform=threads links to the Threads mentions page", () => {
    renderPage("/messaging?platform=threads");
    expect(screen.queryByRole("tab", { name: /Threads/i })).not.toBeInTheDocument();
  });

  it("switches active channel when clicking provider card", () => {
    renderPage();
    const facebookTab = screen.getByRole("tab", { name: /Facebook/i });
    fireEvent.click(facebookTab);
    expect(facebookTab).toHaveAttribute("aria-selected", "true");
  });

  it("resolves image, PDF and audio in the WhatsApp tab through getMedia", async () => {
    testState.accounts = [firstAccount, qrAccount];
    testState.conversations = [conversation];
    testState.messages = mediaMessages;
    renderPage(`/messaging?platform=whatsapp&account=${ACCOUNT_B}&chat=${CHAT_ID}`);

    expect(await screen.findByTestId("wa-inbox-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("messaging-inbox")).not.toBeInTheDocument();

    await waitFor(() => expect(testState.getMedia).toHaveBeenCalled());
    const requested = testState.getMedia.mock.calls.flatMap(
      (call) => (call[0] as { message_row_ids: string[] }).message_row_ids,
    );
    expect(requested).toEqual(expect.arrayContaining([IMAGE_ROW, PDF_ROW, AUDIO_ROW]));

    expect(await screen.findByRole("img", { name: "photo.jpg" })).toHaveAttribute(
      "src",
      "https://signed.example/photo.jpg",
    );
    expect(await screen.findByTestId("wa-media-document")).toHaveTextContent("invoice.pdf");
    const audio = await waitFor(() => {
      const el = document.querySelector("audio");
      expect(el).toBeTruthy();
      return el as HTMLAudioElement;
    });
    expect(audio).toHaveAttribute("src", "https://signed.example/note.ogg");
  });
});
