import { describe, expect, it } from "vitest";
import { parseInboxRoute, withInboxRoute } from "@/lib/whatsappInboxRoute";
import type { Conversation } from "@/hooks/useMessaging";

// These pin the deep-link selection rule that MessagingInbox implements: resolve a
// conversation by its stable messaging_cache id, and select NOTHING when the id is
// unknown. Selecting a neighbouring conversation instead would silently show the
// wrong customer's chat, which is the failure this guards against.

const CHAT_ONE = "cccccccc-0000-4000-8000-000000000001";
const CHAT_TWO = "cccccccc-0000-4000-8000-000000000002";
const ACCOUNT_ID = "bbbbbbbb-0000-4000-8000-000000000002";

function conversation(overrides: Partial<Conversation> & Pick<Conversation, "id">): Conversation {
  return {
    participant_name: "Acme Co",
    participant_id: "96500000001",
    participant_avatar: null,
    last_message: "hello",
    last_message_time: "2026-07-26T00:00:00Z",
    last_message_from: "Acme Co",
    unread_count: 0,
    updated_time: "2026-07-26T00:00:00Z",
    ...overrides,
  };
}

// Mirrors the resolution MessagingInbox performs for a `chat` param.
function resolveFromRoute(conversations: Conversation[], search: string) {
  const { conversationCacheId } = parseInboxRoute(search);
  if (!conversationCacheId) return null;
  return conversations.find((conv) => conv.cache_id === conversationCacheId) ?? null;
}

const CONVERSATIONS = [
  conversation({ id: "wa_1", cache_id: CHAT_ONE, participant_name: "First" }),
  conversation({ id: "wa_2", cache_id: CHAT_TWO, participant_name: "Second" }),
];

describe("inbox deep links", () => {
  it("selects exactly the conversation named by the chat param", () => {
    const selected = resolveFromRoute(CONVERSATIONS, `?chat=${CHAT_TWO}`);
    expect(selected?.participant_name).toBe("Second");
  });

  it("restores the same conversation on a refresh of the same URL", () => {
    const search = `?account=${ACCOUNT_ID}&chat=${CHAT_ONE}`;
    expect(resolveFromRoute(CONVERSATIONS, search)?.id).toBe("wa_1");
    expect(resolveFromRoute(CONVERSATIONS, search)?.id).toBe("wa_1");
  });

  it("selects nothing — not a neighbour — for a stale chat id", () => {
    const stale = "cccccccc-0000-4000-8000-00000000dead";
    const selected = resolveFromRoute(CONVERSATIONS, `?chat=${stale}`);

    expect(selected).toBeNull();
    // The important half: it must not fall back to some other conversation.
    expect(selected).not.toBe(CONVERSATIONS[0]);
    expect(selected).not.toBe(CONVERSATIONS[1]);
  });

  it("selects nothing for a malformed chat id instead of throwing", () => {
    expect(resolveFromRoute(CONVERSATIONS, "?chat=not-a-uuid")).toBeNull();
  });

  it("ignores Facebook and Instagram conversations, which publish no cache_id", () => {
    const metaConversations = [conversation({ id: "m_1", participant_name: "Messenger" })];
    expect(resolveFromRoute(metaConversations, `?chat=${CHAT_ONE}`)).toBeNull();
  });

  it("writes the selected conversation into the URL without losing other params", () => {
    const next = withInboxRoute(new URLSearchParams("label=vip"), {
      accountId: ACCOUNT_ID,
      conversationCacheId: CHAT_TWO,
    });

    expect(next.get("chat")).toBe(CHAT_TWO);
    expect(next.get("account")).toBe(ACCOUNT_ID);
    expect(next.get("label")).toBe("vip");
  });

  it("clears the chat param when the selection is cleared", () => {
    const next = withInboxRoute(new URLSearchParams(`chat=${CHAT_TWO}`), {
      accountId: ACCOUNT_ID,
      conversationCacheId: undefined,
    });
    expect(next.get("chat")).toBeNull();
  });
});
