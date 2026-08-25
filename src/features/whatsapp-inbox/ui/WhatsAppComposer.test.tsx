import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useMessaging";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

const upload = vi.fn();
const getPublicUrl = vi.fn();
const getUser = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => getUser(...args) },
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => upload(...args),
        getPublicUrl: (...args: unknown[]) => getPublicUrl(...args),
      }),
    },
    from: () => ({ insert: vi.fn() }),
  },
}));

vi.mock("@/lib/postoraFileName", () => ({
  buildPostoraFileName: vi.fn(async () => "postora_2026-08-25_user-uuid_1.jpg"),
}));

vi.mock("@/hooks/useMessaging", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/messaging/QuickReplyPicker", () => ({
  QuickReplyPicker: () => <div>Quick replies</div>,
  SlashCommandSuggestions: () => null,
}));

vi.mock("@/components/messaging/InteractiveMessageBuilder", () => ({
  InteractiveMessageBuilder: () => <div>Interactive</div>,
}));

import { WhatsAppComposer } from "./WhatsAppComposer";

const conversation: Conversation = {
  id: "wa_96550000000_96551111111",
  participant_name: "Customer",
  participant_id: "96551111111",
  participant_avatar: null,
  last_message: "Hello",
  last_message_time: "2026-08-25T10:00:00.000Z",
  last_message_from: "96551111111",
  unread_count: 0,
  updated_time: "2026-08-25T10:00:00.000Z",
};

describe("WhatsAppComposer outbound upload", () => {
  let sendMedia: ReturnType<typeof vi.fn>;
  let api: WhatsAppInboxApi;
  let queryClient: QueryClient;

  beforeEach(() => {
    sendMedia = vi.fn(async () => ({}));
    api = { getMessagesPage: vi.fn(), getMedia: vi.fn(), sendMedia, sendInteractive: vi.fn() };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(queryClient, "invalidateQueries");
    getUser.mockResolvedValue({ data: { user: { id: "user-uuid" } } });
    upload.mockResolvedValue({ data: { path: "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg" }, error: null });
    getPublicUrl.mockReturnValue({ data: { publicUrl: "https://should-not-be-used.example/x" } });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  function renderComposer() {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
      </QueryClientProvider>
    );
    return render(
      <WhatsAppComposer conversation={conversation} socialAccountId="account-1" />,
      { wrapper },
    );
  }

  it("uploads under the caller's uid and sends media_path instead of a public URL", async () => {
    const { container } = renderComposer();
    const file = new File(["hello"], "photo.jpg", { type: "image/jpeg" });
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(sendMedia).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg",
      file,
    );
    expect(sendMedia).toHaveBeenCalledWith({
      social_account_id: "account-1",
      recipient_phone: conversation.participant_id,
      media_path: "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg",
      media_type: "image",
      caption: undefined,
    });
    expect(getPublicUrl).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["messaging-messages", conversation.id],
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
