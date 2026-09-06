# WhatsApp Inbox Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Direct-QR WhatsApp inbox show every chat with its history, report sync results, show delivery ticks, and gain forward / delete-chat / media download / lightbox / day separators / header contact actions.

**Architecture:** Edge work stays in `supabase/functions/_shared/*` (pure, Deno-tested) with thin action branches in `messaging-api`, `whatsapp-evolution-webhook` and `whatsapp-evolution-bridge`. Frontend work lives in `src/features/whatsapp-inbox` (domain → application ports → infrastructure adapter → ui), which has layering tests that must keep passing. One migration adds a jsonb column.

**Tech Stack:** React 18 + TypeScript + Vite + TanStack Query + shadcn/ui + vitest (jsdom, `fireEvent`, no `userEvent`); Deno edge functions with `Deno.test`; Postgres migrations; Evolution API 2.3.7.

**Spec:** `docs/superpowers/specs/2026-09-06-whatsapp-inbox-parity-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` §3, §4, §12–§16, §23 before editing. Never trust body `user_id`; every messaging-api action goes through `withWhatsAppActionAccess`.
- `src/features/whatsapp-inbox/tests/architecture.test.ts`: `application/` and `domain/` never import `infrastructure/`; only `ui/WhatsAppInboxScreen.tsx` may.
- `src/features/whatsapp-inbox/tests/scopeFence.test.ts`: `MessagingInbox.tsx` keeps three `h-[620px]` shells; do not touch it.
- Frontend tests: `bun run test -- <path>`; use `fireEvent`, never `userEvent`. Radix tabs need `mousedown`.
- Deno tests for a single file: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none <file>`. Run all Deno tests BEFORE `bun install`/vitest (`--node-modules-dir=auto` in CI rewrites `node_modules`).
- After every new or changed edge module run `deno check <file>` (`--no-check` hides type errors).
- Migrations are rehearsed on the db-harness, never inside the prod container. Migrations run as `supabase_admin`.
- Edge functions deploy via the runtime checkout on Contabo (`docs/runbooks/deploy-edge-function.md`, `git fetch` in `/root/postora-runtime` then `restart`). Deploy migrations + functions BEFORE merging to `main` (frontend auto-deploys).
- Commit scoped: `git commit -- <files>`. Never commit `.env*`, logs, `b64.txt`.
- Guard passes before presenting: `clean-code-guard` on production code, `test-guard` on tests.
- Copy: English only, no i18n. Theme: use `bg-whatsapp` / `text-whatsapp` tokens (`tailwind.config.ts:92`), never Danat's hex values.

---

## File map

| Path | Responsibility |
|---|---|
| `supabase/functions/_shared/whatsappConversationList.ts` (new) | Pure helpers: search predicate + directory-name override for the list action |
| `supabase/functions/messaging-api/index.ts` | Actions: `whatsapp_list_conversations` (cap, `q`, names), `whatsapp_forward_message`, `whatsapp_delete_conversation` |
| `supabase/functions/_shared/evolutionApi.ts` | `MESSAGES_UPDATE` in the event union; `pageCeiling` option on `findMessages`; `setWebhook` already exists |
| `supabase/functions/_shared/whatsappSyncEngine.ts` | LID anchor resolution, `chatsAwaitingLid`, `last_sync_outcome` write |
| `supabase/functions/_shared/evolutionMessageAck.ts` (new) | Ack normalisation + status ordering |
| `supabase/functions/whatsapp-evolution-webhook/index.ts` | `MESSAGES_UPDATE` handler |
| `supabase/functions/whatsapp-evolution-bridge/index.ts` | `get_sync_status`, `resubscribe_webhook` actions; event list |
| `supabase/migrations/20260906120000_whatsapp_evolution_sync_outcome.sql` (new) | `last_sync_outcome jsonb` |
| `src/features/whatsapp-inbox/domain/messageStatus.ts` (new) | Tick mapping |
| `src/features/whatsapp-inbox/domain/mediaKind.ts` (new) | image / video / audio / pdf / document |
| `src/features/whatsapp-inbox/domain/dayGroups.ts` (new) | Group messages by local day, format times |
| `src/features/whatsapp-inbox/application/ports.ts` | `forwardMessage`, `deleteConversation` ports |
| `src/features/whatsapp-inbox/infrastructure/whatsappInboxApi.ts` | Adapter bodies |
| `src/features/whatsapp-inbox/ui/WhatsAppStatusTicks.tsx` (new) | Tick icon |
| `src/features/whatsapp-inbox/ui/WhatsAppForwardDialog.tsx` (new) | Forward target picker |
| `src/features/whatsapp-inbox/ui/WhatsAppMediaLightbox.tsx` (new) | image / video / pdf viewer with download |
| `src/features/whatsapp-inbox/ui/WhatsAppMediaAttachment.tsx` | Download on all kinds, lightbox for video/pdf |
| `src/features/whatsapp-inbox/ui/WhatsAppMessageBubble.tsx` | Ticks, time, wa colours, forward hook-up |
| `src/features/whatsapp-inbox/ui/WhatsAppMessageContextMenu.tsx` | "Forward" item |
| `src/features/whatsapp-inbox/ui/WhatsAppConversationPane.tsx` | Day separators, header phone + contact button, wallpaper |
| `src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx` | Controlled search → server `q`; delete chat wiring |
| `src/components/messaging/ConversationList.tsx` | Optional controlled search, absolute times, hover delete |
| `src/components/messaging/contacts/ContactFormDialog.tsx` | Optional `initialPhone` for add mode |
| `src/components/messaging/WhatsAppSetup.tsx` | Sync status polling + result toast |
| `src/hooks/useMessaging.ts` | `search` option on `useConversations` |

---

## Track A — sync correctness

### Task 1: List action — cap, server search, directory names

**Files:**
- Create: `supabase/functions/_shared/whatsappConversationList.ts`
- Create: `supabase/functions/_shared/whatsappConversationList.test.ts`
- Modify: `supabase/functions/messaging-api/index.ts:1395-1455`

**Interfaces:**
- Produces: `sanitizeConversationSearch(q: unknown): string | null`, `conversationSearchOr(term: string): string`, `displayNameFor(cachedName: string | null, phone: string, contact: { display_name: string | null } | undefined): string`, `CONVERSATION_LIST_LIMIT = 500`.

- [ ] **Step 1: Write the failing test**

```ts
// supabase/functions/_shared/whatsappConversationList.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CONVERSATION_LIST_LIMIT,
  conversationSearchOr,
  displayNameFor,
  sanitizeConversationSearch,
} from "./whatsappConversationList.ts";

Deno.test("search term is trimmed, capped, and stripped of ilike wildcards and filter separators", () => {
  assertEquals(sanitizeConversationSearch("  ali%_(,) "), "ali");
  assertEquals(sanitizeConversationSearch(""), null);
  assertEquals(sanitizeConversationSearch(undefined), null);
  assertEquals(sanitizeConversationSearch("x".repeat(200))?.length, 80);
});

Deno.test("search matches the participant name or the phone digits", () => {
  assertEquals(
    conversationSearchOr("9655"),
    "participant_name.ilike.%9655%,conversation_id.ilike.%9655%",
  );
});

Deno.test("directory name beats the push name, but a bare phone in the directory does not", () => {
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "Ali Saved" }), "Ali Saved");
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "+96555" }), "Push Name");
  assertEquals(displayNameFor("Push Name", "96555", { display_name: "96555" }), "Push Name");
  assertEquals(displayNameFor(null, "96555", undefined), "+96555");
  assertEquals(CONVERSATION_LIST_LIMIT, 500);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none supabase/functions/_shared/whatsappConversationList.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// supabase/functions/_shared/whatsappConversationList.ts
// Pure helpers for messaging-api `whatsapp_list_conversations`.
//
// The list used to return 50 rows and the client searched by name only; a 285-chat
// account showed 50 and could not find a chat by number. Search is server-side now and
// the cap is the largest a workspace has been seen to hold, times two.

export const CONVERSATION_LIST_LIMIT = 500;
const SEARCH_MAX_CHARS = 80;

/** Strips ilike wildcards and PostgREST filter separators; null when nothing is left. */
export function sanitizeConversationSearch(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const term = q.replace(/[%_(),]/g, "").trim().slice(0, SEARCH_MAX_CHARS);
  return term.length > 0 ? term : null;
}

/** PostgREST `or` predicate: name or the phone digits carried by the conversation id. */
export function conversationSearchOr(term: string): string {
  return `participant_name.ilike.%${term}%,conversation_id.ilike.%${term}%`;
}

function isBarePhone(name: string, phone: string): boolean {
  return name.replace(/^\+/, "") === phone;
}

/**
 * The contact directory is the authoritative name book: a name the user typed there beats
 * the push name captured at ingest. A directory row whose display_name is just the number
 * (auto-captured on outbound sends) carries no information and yields to the push name.
 */
export function displayNameFor(
  cachedName: string | null,
  phone: string,
  contact: { display_name: string | null } | undefined,
): string {
  const directory = contact?.display_name?.trim();
  if (directory && !isBarePhone(directory, phone)) return directory;
  const cached = cachedName?.trim();
  if (cached) return cached;
  return `+${phone}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: 3 passed.

- [ ] **Step 5: Wire the action**

In `supabase/functions/messaging-api/index.ts`, add the import next to the other `_shared` imports:

```ts
import {
  CONVERSATION_LIST_LIMIT,
  conversationSearchOr,
  displayNameFor,
  sanitizeConversationSearch,
} from "../_shared/whatsappConversationList.ts";
```

Replace the body of `if (action === "whatsapp_list_conversations")` from `const { data, error } = await adminClient` through `return jsonResponse({ conversations });` with:

```ts
      const searchTerm = sanitizeConversationSearch(body.q);
      let listQuery = adminClient
        .from("messaging_cache")
        .select("*")
        .eq("social_account_id", social_account_id)
        .eq("workspace_id", account.workspaceId)
        .eq("platform", "whatsapp");
      if (searchTerm) listQuery = listQuery.or(conversationSearchOr(searchTerm));
      const { data, error } = await listQuery
        .order("last_message_at", { ascending: false })
        .limit(CONVERSATION_LIST_LIMIT);

      if (error) throw error;

      const participantPhone = (conversationId: string) =>
        conversationId.replace(`wa_${social_account_id}_`, "").replace(/^wa_\d+_/, "");
      const participantPhones = [...new Set(
        (data || []).map((conversation: any) => participantPhone(conversation.conversation_id)),
      )].filter(Boolean);
      const contactByPhone = new Map<string, { id: string; display_name: string | null }>();

      if (participantPhones.length > 0) {
        const { data: contacts, error: contactsError } = await adminClient
          .from("whatsapp_contacts")
          .select("id, phone_number, display_name")
          .eq("workspace_id", account.workspaceId)
          .in("phone_number", participantPhones);
        if (contactsError) throw contactsError;
        for (const contact of contacts || []) {
          contactByPhone.set(contact.phone_number, { id: contact.id, display_name: contact.display_name });
        }
      }

      const conversations = (data || []).map((c: any) => {
        const phone = participantPhone(c.conversation_id);
        const contact = contactByPhone.get(phone);
        const name = displayNameFor(c.participant_name, phone, contact);
        return {
          id: c.conversation_id,
          cache_id: c.id,
          workspace_id: c.workspace_id,
          contact_id: contact?.id || null,
          participant_name: name,
          participant_id: phone,
          participant_avatar: c.participant_avatar || null,
          last_message: c.last_message_preview || "",
          last_message_time: c.last_message_at,
          last_message_from: name,
          unread_count: c.unread_count || 0,
          updated_time: c.updated_at,
        };
      });

      return jsonResponse({ conversations });
```

- [ ] **Step 6: Type-check and commit**

Run: `deno check supabase/functions/messaging-api/index.ts` (expected: no errors). Then:

```bash
git add supabase/functions/_shared/whatsappConversationList.ts supabase/functions/_shared/whatsappConversationList.test.ts supabase/functions/messaging-api/index.ts
git commit -m "feat(whatsapp): list every conversation, search by name or phone, prefer directory names"
```

---

### Task 2: Frontend — server search from the inbox list

**Files:**
- Modify: `src/hooks/useMessaging.ts:121-158`
- Modify: `src/components/messaging/ConversationList.tsx`
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx`
- Test: `src/components/messaging/ConversationList.test.tsx` (create if absent)

**Interfaces:**
- `useConversations(socialAccountId, messagingPlatform, options?: { silent?: boolean; search?: string })` — `search` is sent as `q`, only for WHATSAPP, and is part of the query key.
- `ConversationList` new optional props: `search?: string; onSearchChange?(value: string): void`. When both are given the list is controlled and does NOT filter client-side.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/messaging/ConversationList.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useMessaging";
import { ConversationList } from "./ConversationList";

function conv(id: string, name: string): Conversation {
  return {
    id, participant_name: name, participant_id: id.replace(/^wa_\d+_/, ""), participant_avatar: null,
    last_message: "hi", last_message_time: "2026-09-06T10:00:00.000Z", last_message_from: name,
    unread_count: 0, updated_time: "2026-09-06T10:00:00.000Z",
  };
}

describe("ConversationList controlled search", () => {
  it("reports typing to the owner and does not filter locally", () => {
    const onSearchChange = vi.fn();
    render(
      <ConversationList
        conversations={[conv("wa_1_96555", "Ali"), conv("wa_1_96599", "Sara")]}
        selectedId={null}
        onSelect={vi.fn()}
        isLoading={false}
        search="9659"
        onSearchChange={onSearchChange}
      />,
    );
    // The server already applied "9659"; the client must not hide Ali on a name-only match.
    expect(screen.getByText("Ali")).toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), { target: { value: "sa" } });
    expect(onSearchChange).toHaveBeenCalledWith("sa");
  });

  it("still filters locally when uncontrolled", () => {
    render(
      <ConversationList
        conversations={[conv("wa_1_96555", "Ali"), conv("wa_1_96599", "Sara")]}
        selectedId={null}
        onSelect={vi.fn()}
        isLoading={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), { target: { value: "sa" } });
    expect(screen.queryByText("Ali")).not.toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/messaging/ConversationList.test.tsx`
Expected: first test FAILS (Ali hidden, `onSearchChange` never called).

- [ ] **Step 3: Implement**

`src/components/messaging/ConversationList.tsx` — add the props and switch to controlled mode:

```tsx
interface ConversationListProps {
  // ...existing props...
  /** Controlled search: the owner sends it to the server, so no local filtering happens. */
  search?: string;
  onSearchChange?: (value: string) => void;
  /** WhatsApp style: HH:mm today, dd/MM/yy otherwise. Default keeps the relative label. */
  absoluteTimes?: boolean;
  /** Hover trash on each row; omitted hides it. */
  onDelete?: (conv: Conversation) => void;
}
```

Inside the component replace the search state block with:

```tsx
  const [localSearch, setLocalSearch] = useState("");
  const controlled = search !== undefined && onSearchChange !== undefined;
  const searchValue = controlled ? search : localSearch;
  const setSearch = controlled ? onSearchChange : setLocalSearch;

  const filtered = !controlled && searchValue
    ? conversations.filter((c) => c.participant_name.toLowerCase().includes(searchValue.toLowerCase()))
    : conversations;
```

and bind the input to `searchValue` / `setSearch`. Leave `absoluteTimes` and `onDelete` unused for now (Task 12 and Task 10 fill them in); declare them so the interface is stable.

`src/hooks/useMessaging.ts` — `useConversations`:

```ts
export function useConversations(
  socialAccountId: string | null,
  messagingPlatform: string,
  options?: { silent?: boolean; search?: string },
) {
  const { session } = useAuth();
  const search = messagingPlatform === "WHATSAPP" ? (options?.search ?? "").trim() : "";
  const query = useQuery({
    queryKey: ["messaging-conversations", socialAccountId, messagingPlatform, search],
    queryFn: async () => {
      if (!socialAccountId) return [];
      try {
        const action = messagingPlatform === "WHATSAPP" ? "whatsapp_list_conversations" : "list_conversations";
        const data = await callMessagingApi(action, {
          social_account_id: socialAccountId,
          messaging_platform: messagingPlatform,
          ...(search ? { q: search } : {}),
        });
```

Keep the rest as is. The realtime invalidation uses the key prefix `["messaging-conversations", socialAccountId, messagingPlatform]`, which still matches because TanStack matches prefixes.

`src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx` — own the search with a 250 ms debounce:

```tsx
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const { data: conversations = [], isLoading: conversationsLoading } = useConversations(
    selectedAccountId,
    "WHATSAPP",
    { search: debouncedSearch },
  );
```

and pass `search={search} onSearchChange={setSearch}` to `<ConversationList>`.

- [ ] **Step 4: Run tests**

Run: `bun run test -- src/components/messaging src/features/whatsapp-inbox`
Expected: all pass (the screen test mocks `useConversations`, so the extra argument is ignored).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMessaging.ts src/components/messaging/ConversationList.tsx src/components/messaging/ConversationList.test.tsx src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx
git commit -m "feat(whatsapp): server-side conversation search from the inbox list"
```

---

### Task 3: Sync engine — resolve LID chats through a live anchor

**Files:**
- Modify: `supabase/functions/_shared/evolutionApi.ts` (`FindMessagesOptions`, `findMessages`)
- Modify: `supabase/functions/_shared/whatsappSyncEngine.ts`
- Modify: `supabase/functions/_shared/whatsappSyncEngine.test.ts`

**Interfaces:**
- `FindMessagesOptions` gains `pageCeiling?: number` (default 20).
- `SyncOutcome.chatsUnaddressable` is renamed `chatsAwaitingLid`; a new `chatsLidResolved: number` counts LID chats imported through an anchor.
- The fake admin in tests gains `from("whatsapp_messages").select().eq().in().limit()` returning `{ data, error }`.

- [ ] **Step 1: Write the failing tests** (append to `whatsappSyncEngine.test.ts`; also rename every `chatsUnaddressable` assertion in the file to `chatsAwaitingLid`)

First extend `fakeAdmin` so the anchor lookup can be answered:

```ts
function fakeAdmin(options: { anchors?: Record<string, string> } = {}) {
  const writes: Write[] = [];
  const anchors = options.anchors ?? {};
  return {
    writes,
    rpc: (fn: string, args: { p_rows: any[] }) => {
      writes.push({ table: fn, rows: args.p_rows });
      return Promise.resolve({ data: args.p_rows.length, error: null });
    },
    // Models `.from("whatsapp_messages").select("conversation_id").eq(...).in("message_id", ids).limit(1)`.
    from: (_table: string) => {
      let ids: string[] = [];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: (_column: string, values: string[]) => { ids = values; return chain; },
        limit: () => {
          const hit = ids.map((id) => anchors[id]).find(Boolean);
          return Promise.resolve({ data: hit ? [{ conversation_id: hit }] : [], error: null });
        },
        update: () => chain,
        then: undefined,
      };
      return chain;
    },
  };
}
```

Then the tests:

```ts
function lidMessage(id: string, remoteJid: string, text: string) {
  return {
    key: { id, remoteJid, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1787268633,
    pushName: "Lid Person",
  };
}

Deno.test("a LID chat with a live anchor is imported under the anchored number", async () => {
  // Evolution stores this chat's history under the LID only. One of its message ids was
  // already ingested live (the webhook is phone-normalised), which pins it to a number.
  const admin = fakeAdmin({ anchors: { "LIVE1": "wa_96597950350_96555683677" } });
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("166095025660123@lid")],
      messages: {
        "166095025660123@lid": [
          lidMessage("LIVE1", "166095025660123@lid", "hello"),
          lidMessage("OLD1", "166095025660123@lid", "older"),
        ],
      },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  assertEquals(outcome.chatsLidResolved, 1);
  assertEquals(outcome.chatsAwaitingLid, 0);
  const conversations = rowsFor(admin, "import_whatsapp_conversations");
  assertEquals(conversations[0].conversation_id, "wa_96597950350_96555683677");
  const messages = rowsFor(admin, "import_whatsapp_messages");
  assertEquals(messages.length, 2);
  assertEquals(messages.every((row) => row.conversation_id === "wa_96597950350_96555683677"), true);
});

Deno.test("a LID chat with no anchor is counted as waiting, not imported", async () => {
  const admin = fakeAdmin();
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("166095025660123@lid")],
      messages: { "166095025660123@lid": [lidMessage("X1", "166095025660123@lid", "hi")] },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  assertEquals(outcome.chatsAwaitingLid, 1);
  assertEquals(outcome.chatsLidResolved, 0);
  assertEquals(rowsFor(admin, "import_whatsapp_conversations").length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none supabase/functions/_shared/whatsappSyncEngine.test.ts`
Expected: the two new tests FAIL (`chatsLidResolved` undefined / no conversations).

- [ ] **Step 3: Implement**

`evolutionApi.ts` — find `interface FindMessagesOptions` (or the inline options type used by `findMessages`) and add:

```ts
export interface FindMessagesOptions {
  deadlineAt?: number;
  /** Stop after this many pages; the anchor probe reads one page, the import reads up to 20. */
  pageCeiling?: number;
}
```

In `findMessages`, replace `const pageCeiling = 20;` with `const pageCeiling = Math.max(1, Math.min(options?.pageCeiling ?? 20, 20));`.

`whatsappSyncEngine.ts` — changes:

1. `SyncOutcome`: replace `chatsUnaddressable: number;` with

```ts
  /** LID-only chats with no live message yet; they unlock as the contact writes in. */
  chatsAwaitingLid: number;
  /** LID-only chats pinned to a number through a message the webhook already ingested. */
  chatsLidResolved: number;
```

2. `ChatScan`: rename `unaddressable` to `lidPending: any[]` (the raw chat records that need an anchor):

```ts
interface ChatScan {
  summaries: ChatSummary[];
  /** LID-addressed one-to-one chats whose number appears nowhere in the record. */
  lidPending: any[];
}
```

and in `scanChats`, where the LID branch increments the counter, push the record instead: `if (remoteJid.endsWith(LID_JID_SUFFIX)) scan.lidPending.push(chat);`.

3. Extract the summary construction into a helper so the LID path can reuse it:

```ts
function summarize(chat: any, remoteJid: string, address: string, contact: any, account: SyncAccount): ChatSummary {
  const number = remoteNumberFor(address);
  return {
    remoteJid,
    address,
    number,
    conversationId: `wa_${account.platform_user_id}_${number}`,
    name: realName(contact?.pushName, number) ?? realName(chat?.pushName, number),
    avatar: contact?.profilePicUrl || chat?.profilePicUrl || null,
    preview: previewOf(chat),
    lastMessageAt: lastMessageIso(chat),
    unreadCount: Number(chat?.unreadCount) || 0,
  };
}
```

and call it from `scanChats` in place of the inline object.

4. Add the anchor lookup and resolver:

```ts
/**
 * Evolution files a LID chat's history under the LID with no phone alias, but it normalises
 * LIVE webhook events to the phone JID. A message id present both in the chat's history and
 * in whatsapp_messages therefore pins the chat to the number the live event carried. Scoped
 * to this account: the same LID can belong to a different tenant's contact.
 */
async function lookupAnchorNumber(admin: any, accountId: string, ids: string[]): Promise<string | null> {
  if (ids.length === 0) return null;
  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("conversation_id")
    .eq("social_account_id", accountId)
    .in("message_id", ids)
    .limit(1);
  if (error) throw error;
  const conversationId = data?.[0]?.conversation_id as string | undefined;
  const number = conversationId?.split("_").pop();
  return number && /^\d+$/.test(number) ? number : null;
}

async function resolveLidChats(deps: {
  admin: any;
  api: EvolutionApi;
  account: SyncAccount;
  instanceName: string;
  contacts: any[];
  pending: any[];
  deadlineAt: number;
}): Promise<{ resolved: ChatSummary[]; awaiting: number }> {
  const { admin, api, account, instanceName, contacts, pending, deadlineAt } = deps;
  const contactByJid = new Map(contacts.filter((c) => c?.remoteJid).map((c) => [c.remoteJid, c]));
  const resolved: ChatSummary[] = [];
  let awaiting = 0;
  for (const chat of pending) {
    if (Date.now() >= deadlineAt) { awaiting += 1; continue; }
    const remoteJid = String(chat?.remoteJid || "");
    try {
      const probe = await api.findMessages(instanceName, remoteJid, { deadlineAt, pageCeiling: 1 });
      const ids = probe.records
        .map((record: any) => record?.key?.id)
        .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
      const number = await lookupAnchorNumber(admin, account.id, ids);
      if (!number) { awaiting += 1; continue; }
      resolved.push(summarize(chat, remoteJid, `${number}${DIRECT_JID_SUFFIX}`, contactByJid.get(remoteJid), account));
    } catch (error) {
      awaiting += 1;
      console.error(
        `[whatsapp-sync] ${instanceName} LID probe failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { resolved, awaiting };
}
```

Add `const DIRECT_JID_SUFFIX = "@s.whatsapp.net";` next to `LID_JID_SUFFIX`.

5. In `syncEvolutionHistory`, after `const { summaries, lidPending } = scanChats(...)`:

```ts
  const lid = await resolveLidChats({
    admin, api, account, instanceName, contacts, pending: lidPending, deadlineAt,
  });
  const allSummaries = [...summaries, ...lid.resolved];
  const outcome: SyncOutcome = {
    chatsDiscovered: chats.length,
    chatsImported: allSummaries.length,
    chatsSkipped: chats.length - summaries.length - lidPending.length,
    chatsAwaitingLid: lid.awaiting,
    chatsLidResolved: lid.resolved.length,
    messagesWritten: 0,
    chatFailures: 0,
    truncated: false,
  };
  if (lid.awaiting > 0) {
    console.log(
      `[whatsapp-sync] ${instanceName}: ${lid.awaiting} one-to-one chat(s) are LID-addressed with no ` +
        `live message yet and were not imported`,
    );
  }
  if (allSummaries.length === 0) return outcome;
```

and use `allSummaries` everywhere the function previously used `summaries` below that point (conversation rows, contact rows, the sweep loop, the truncation log).

- [ ] **Step 4: Run tests**

Same command. Expected: all pass, including the renamed assertions.

- [ ] **Step 5: Type-check and commit**

Run: `deno check supabase/functions/_shared/whatsappSyncEngine.ts supabase/functions/_shared/evolutionApi.ts`

```bash
git add supabase/functions/_shared/evolutionApi.ts supabase/functions/_shared/whatsappSyncEngine.ts supabase/functions/_shared/whatsappSyncEngine.test.ts
git commit -m "feat(whatsapp): import LID-addressed chats through a live message anchor"
```

---

### Task 4: Sync outcome persisted and exposed

**Files:**
- Create: `supabase/migrations/20260906120000_whatsapp_evolution_sync_outcome.sql`
- Modify: `supabase/functions/_shared/whatsappSyncEngine.ts` (`importEvolutionHistory`)
- Modify: `supabase/functions/_shared/whatsappSyncEngine.test.ts`
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts` (`get_sync_status`)
- Modify: `src/integrations/supabase/types.ts` (regenerate or hand-add the column)

**Interfaces:**
- Column `whatsapp_evolution_instances.last_sync_outcome jsonb` = `SyncOutcome & { finished_at: string; error?: string }`.
- Bridge action `get_sync_status` → `{ success: true, social_account_id, sync_running: boolean, last_sync_at: string | null, last_sync_outcome: object | null }`.

- [ ] **Step 1: Migration**

```sql
-- 20260906120000_whatsapp_evolution_sync_outcome.sql
-- The history sweep runs in the background and used to report nothing. The setup page
-- polls this column to tell the user how many chats and messages landed, whether the
-- sweep was cut short by its budget (run again), and how many LID chats still wait for
-- a first live message.
alter table public.whatsapp_evolution_instances
  add column if not exists last_sync_outcome jsonb;
```

Rehearse on the db-harness per `docs/runbooks` (never in the prod container), then commit.

- [ ] **Step 2: Failing test** (append to `whatsappSyncEngine.test.ts`; the fake admin's `from(...).update(...).eq(...)` must record the payload — extend the chain so `update: (payload) => { writes.push({ table: "whatsapp_evolution_instances", rows: [payload] }); return chain; }` and `eq` still returns `chain` and the chain is thenable: add `then: (resolve: any) => resolve({ data: null, error: null })` ONLY on the object returned by `update`).

```ts
Deno.test("importEvolutionHistory records the outcome with the lease release", async () => {
  const admin = fakeAdmin();
  (admin as any).rpc = (fn: string, args: any) => {
    if (fn === "claim_whatsapp_history_sync") return Promise.resolve({ data: true, error: null });
    admin.writes.push({ table: fn, rows: args.p_rows });
    return Promise.resolve({ data: args.p_rows.length, error: null });
  };
  await importEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96555683677@s.whatsapp.net")],
      messages: { "96555683677@s.whatsapp.net": [lidMessage("M1", "96555683677@s.whatsapp.net", "hi")] },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  const completion = rowsFor(admin, "whatsapp_evolution_instances")[0];
  assertEquals(completion.sync_started_at, null);
  assertEquals(typeof completion.last_sync_at, "string");
  assertEquals(completion.last_sync_outcome.chatsImported, 1);
  assertEquals(completion.last_sync_outcome.messagesWritten, 1);
  assertEquals(typeof completion.last_sync_outcome.finished_at, "string");
});
```

- [ ] **Step 3: Implement** in `importEvolutionHistory`:

```ts
  const completion: Record<string, unknown> = { sync_started_at: null };
  try {
    const outcome = await syncEvolutionHistory(deps);
    console.log(`[whatsapp-sync] ${instanceName}: ${JSON.stringify(outcome)}`);
    completion.last_sync_outcome = { ...outcome, finished_at: new Date().toISOString() };
    const sweptCleanly = outcome.chatsImported > 0 && outcome.chatFailures === 0 && !outcome.truncated;
    if (sweptCleanly && outcome.messagesWritten > 0) {
      completion.last_sync_at = new Date().toISOString();
    }
  } catch (error) {
    // The user pressed a button and deserves to see why nothing arrived; the message is
    // Evolution's or Postgres's, never a secret.
    completion.last_sync_outcome = {
      finished_at: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 200) : "sync failed",
    };
    throw error;
  } finally {
    await admin.from("whatsapp_evolution_instances").update(completion).eq("social_account_id", account.id);
  }
```

Bridge: add `"get_sync_status"` to the `action` union and to `findInstance`'s select add `sync_started_at, last_sync_outcome`; extend `EvolutionInstanceRow` with `sync_started_at: string | null; last_sync_outcome: Record<string, unknown> | null;`. Add:

```ts
async function getSyncStatus(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  return {
    success: true,
    social_account_id: body.social_account_id,
    sync_running: instance.sync_started_at !== null,
    last_sync_at: instance.last_sync_at,
    last_sync_outcome: instance.last_sync_outcome,
  };
}
```

and the dispatch branch:

```ts
    if (body.action === "get_sync_status") {
      return restrictedJsonResponse(req, await getSyncStatus(context.admin, context.user.id, body));
    }
```

Types: in `src/integrations/supabase/types.ts`, find the `whatsapp_evolution_instances` Row/Insert/Update blocks and add `last_sync_outcome: Json | null` (Row), `last_sync_outcome?: Json | null` (Insert/Update).

- [ ] **Step 4: Run tests, type-check, commit**

```bash
deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none supabase/functions/_shared/whatsappSyncEngine.test.ts
deno check supabase/functions/_shared/whatsappSyncEngine.ts supabase/functions/whatsapp-evolution-bridge/index.ts
git add supabase/migrations/20260906120000_whatsapp_evolution_sync_outcome.sql supabase/functions/_shared/whatsappSyncEngine.ts supabase/functions/_shared/whatsappSyncEngine.test.ts supabase/functions/whatsapp-evolution-bridge/index.ts src/integrations/supabase/types.ts
git commit -m "feat(whatsapp): persist and expose the history sync outcome"
```

---

### Task 5: Setup page — poll the sync and report the result

**Files:**
- Create: `src/lib/whatsappSyncOutcome.ts`
- Create: `src/lib/whatsappSyncOutcome.test.ts`
- Modify: `src/components/messaging/WhatsAppSetup.tsx:100-125`

**Interfaces:**
- `describeSyncOutcome(outcome: SyncOutcomeView): { title: string; description: string; variant: "default" | "destructive" }`.
- `SyncOutcomeView = { finished_at: string; error?: string; chatsImported?: number; messagesWritten?: number; chatsAwaitingLid?: number; chatsLidResolved?: number; truncated?: boolean }`.

- [ ] **Step 1: Failing test**

```ts
// src/lib/whatsappSyncOutcome.test.ts
import { describe, expect, it } from "vitest";
import { describeSyncOutcome } from "./whatsappSyncOutcome";

describe("describeSyncOutcome", () => {
  it("summarises a complete sweep", () => {
    const result = describeSyncOutcome({ finished_at: "x", chatsImported: 12, messagesWritten: 340, chatsAwaitingLid: 0, truncated: false });
    expect(result.title).toBe("Chats imported");
    expect(result.description).toBe("12 chats, 340 messages.");
    expect(result.variant).toBe("default");
  });
  it("asks for another run when truncated and mentions waiting LID chats", () => {
    const result = describeSyncOutcome({ finished_at: "x", chatsImported: 25, messagesWritten: 900, chatsAwaitingLid: 7, truncated: true });
    expect(result.title).toBe("Partial import");
    expect(result.description).toBe("25 chats, 900 messages. Run again to continue. 7 chats are waiting for a first message from the contact.");
  });
  it("surfaces an error", () => {
    const result = describeSyncOutcome({ finished_at: "x", error: "Evolution unreachable" });
    expect(result.title).toBe("Import failed");
    expect(result.description).toBe("Evolution unreachable");
    expect(result.variant).toBe("destructive");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun run test -- src/lib/whatsappSyncOutcome.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/lib/whatsappSyncOutcome.ts
export interface SyncOutcomeView {
  finished_at: string;
  error?: string;
  chatsImported?: number;
  messagesWritten?: number;
  chatsAwaitingLid?: number;
  chatsLidResolved?: number;
  truncated?: boolean;
}

export interface SyncOutcomeToast {
  title: string;
  description: string;
  variant: "default" | "destructive";
}

export function describeSyncOutcome(outcome: SyncOutcomeView): SyncOutcomeToast {
  if (outcome.error) return { title: "Import failed", description: outcome.error, variant: "destructive" };
  const parts = [`${outcome.chatsImported ?? 0} chats, ${outcome.messagesWritten ?? 0} messages.`];
  if (outcome.truncated) parts.push("Run again to continue.");
  if ((outcome.chatsAwaitingLid ?? 0) > 0) {
    parts.push(`${outcome.chatsAwaitingLid} chats are waiting for a first message from the contact.`);
  }
  return {
    title: outcome.truncated ? "Partial import" : "Chats imported",
    description: parts.join(" "),
    variant: "default",
  };
}
```

In `WhatsAppSetup.tsx`, replace `syncPastChats` with a version that remembers the previous `finished_at`, starts the sweep, then polls every 3 s for up to 5 minutes:

```tsx
  const syncPastChats = async (socialAccountId: string) => {
    setSyncingAccountId(socialAccountId);
    try {
      const before = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "get_sync_status", social_account_id: socialAccountId },
      });
      const previousFinishedAt: string | null = before.data?.last_sync_outcome?.finished_at ?? null;
      const { error } = await supabase.functions.invoke("whatsapp-evolution-bridge", {
        body: { action: "sync_past_chats", social_account_id: socialAccountId },
      });
      if (error) throw error;
      toast({ title: "Importing your conversations", description: "This can take a minute for large accounts." });

      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const status = await supabase.functions.invoke("whatsapp-evolution-bridge", {
          body: { action: "get_sync_status", social_account_id: socialAccountId },
        });
        const outcome = status.data?.last_sync_outcome;
        if (outcome?.finished_at && outcome.finished_at !== previousFinishedAt) {
          toast(describeSyncOutcome(outcome));
          return;
        }
      }
      toast({ title: "Still importing", description: "Large accounts keep importing in the background." });
    } catch (error) {
      toast({
        title: "Could not import conversations",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncingAccountId(null);
    }
  };
```

Import `describeSyncOutcome` from `@/lib/whatsappSyncOutcome`.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/lib/whatsappSyncOutcome.test.ts src/components/messaging
git add src/lib/whatsappSyncOutcome.ts src/lib/whatsappSyncOutcome.test.ts src/components/messaging/WhatsAppSetup.tsx
git commit -m "feat(whatsapp): report history sync results on the setup page"
```

---

## Track B — chat-box parity

### Task 6: Delivery acks — MESSAGES_UPDATE end to end

**Files:**
- Create: `supabase/functions/_shared/evolutionMessageAck.ts`
- Create: `supabase/functions/_shared/evolutionMessageAck.test.ts`
- Modify: `supabase/functions/_shared/evolutionApi.ts:1-4` (event union)
- Modify: `supabase/functions/whatsapp-evolution-bridge/index.ts:15-19` (event list), plus `resubscribe_webhook` action
- Modify: `supabase/functions/whatsapp-evolution-webhook/index.ts` (handler)

**Interfaces:**
- `normalizeAckStatus(value: unknown): AckStatus | null`
- `inboxStatusForAck(status: AckStatus): "delivered" | "read" | "failed" | null`
- `isMessageKeyId(value: unknown): value is string`
- `ackUpdates(items: unknown[]): Array<{ messageId: string; status: "delivered" | "read" | "failed" }>` — the pure part of the handler.
- `MESSAGE_STATUS_RANK: Record<string, number>` and `shouldAdvanceStatus(current: string | null, next: string): boolean` (never regress `read` to `delivered`; `failed` terminal).

- [ ] **Step 1: Failing tests**

```ts
// supabase/functions/_shared/evolutionMessageAck.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ackUpdates, inboxStatusForAck, isMessageKeyId, normalizeAckStatus, shouldAdvanceStatus } from "./evolutionMessageAck.ts";

Deno.test("ack status accepts Evolution strings and raw Baileys numbers", () => {
  assertEquals(normalizeAckStatus("DELIVERY_ACK"), "DELIVERY_ACK");
  assertEquals(normalizeAckStatus("read"), "READ");
  assertEquals(normalizeAckStatus(3), "DELIVERY_ACK");
  assertEquals(normalizeAckStatus(0), "ERROR");
  assertEquals(normalizeAckStatus("nope"), null);
});

Deno.test("ack maps onto inbox status", () => {
  assertEquals(inboxStatusForAck("DELIVERY_ACK"), "delivered");
  assertEquals(inboxStatusForAck("READ"), "read");
  assertEquals(inboxStatusForAck("PLAYED"), "read");
  assertEquals(inboxStatusForAck("ERROR"), "failed");
  assertEquals(inboxStatusForAck("SERVER_ACK"), null);
});

Deno.test("only own sends with a valid key become updates, in both payload shapes", () => {
  const updates = ackUpdates([
    { keyId: "3EB0AAAA1111", remoteJid: "9655@s.whatsapp.net", fromMe: true, status: "READ" },
    { key: { id: "3EB0BBBB2222", fromMe: true }, update: { status: 3 } },
    { keyId: "3EB0CCCC3333", fromMe: false, status: "READ" },
    { keyId: "bad id!", fromMe: true, status: "READ" },
    { keyId: "3EB0DDDD4444", fromMe: true, status: "SERVER_ACK" },
  ]);
  assertEquals(updates, [
    { messageId: "3EB0AAAA1111", status: "read" },
    { messageId: "3EB0BBBB2222", status: "delivered" },
  ]);
  assertEquals(isMessageKeyId("3EB0AAAA1111"), true);
});

Deno.test("status only moves forward and failed is terminal", () => {
  assertEquals(shouldAdvanceStatus("sent", "delivered"), true);
  assertEquals(shouldAdvanceStatus("read", "delivered"), false);
  assertEquals(shouldAdvanceStatus("delivered", "read"), true);
  assertEquals(shouldAdvanceStatus("failed", "read"), false);
  assertEquals(shouldAdvanceStatus(null, "delivered"), true);
});
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement**

```ts
// supabase/functions/_shared/evolutionMessageAck.ts
// WhatsApp's verdict on a send arrives after Evolution's 201, as a server ack on the same
// key via MESSAGES_UPDATE. Without it every outbound row stays "sent" forever and a
// rejected message (Baileys 463 on a cold contact) is invisible.

export type AckStatus = "ERROR" | "PENDING" | "SERVER_ACK" | "DELIVERY_ACK" | "READ" | "PLAYED";

/** Baileys' numeric WAMessageStatus in enum order; Evolution maps through it. */
const ACK_BY_NUMBER: readonly AckStatus[] = ["ERROR", "PENDING", "SERVER_ACK", "DELIVERY_ACK", "READ", "PLAYED"];

export type InboxAckStatus = "delivered" | "read" | "failed";

export function normalizeAckStatus(value: unknown): AckStatus | null {
  if (typeof value === "number") return ACK_BY_NUMBER[value] ?? null;
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (ACK_BY_NUMBER as readonly string[]).includes(upper) ? (upper as AckStatus) : null;
}

export function inboxStatusForAck(status: AckStatus): InboxAckStatus | null {
  switch (status) {
    case "ERROR": return "failed";
    case "DELIVERY_ACK": return "delivered";
    case "READ":
    case "PLAYED": return "read";
    default: return null;
  }
}

/** Message-key ids are alphanumeric from Baileys; anything else is not ours to look up. */
export function isMessageKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{8,64}$/.test(value);
}

export const MESSAGE_STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Acks can arrive out of order; a late DELIVERY_ACK must not undo READ. Failed is terminal. */
export function shouldAdvanceStatus(current: string | null, next: InboxAckStatus): boolean {
  if (current === "failed") return false;
  const currentRank = current ? MESSAGE_STATUS_RANK[current] ?? 0 : 0;
  return MESSAGE_STATUS_RANK[next] > currentRank;
}

export interface AckUpdate {
  messageId: string;
  status: InboxAckStatus;
}

/**
 * Evolution 2.3.7 sends `{ keyId, remoteJid, fromMe, status }`; the raw Baileys shape
 * `{ key: { id, fromMe }, update: { status } }` is accepted too so a gateway upgrade cannot
 * silently stop acks. Only our own sends matter: a contact's read receipt on an inbound
 * message is not a delivery outcome.
 */
export function ackUpdates(items: unknown[]): AckUpdate[] {
  const updates: AckUpdate[] = [];
  for (const raw of items) {
    const item = raw as Record<string, any>;
    const key = item?.key ?? {};
    const keyId = item?.keyId ?? key.id;
    const fromMe = item?.fromMe ?? key.fromMe;
    const ack = normalizeAckStatus(item?.status ?? item?.update?.status);
    if (!isMessageKeyId(keyId) || fromMe !== true || !ack) continue;
    const status = inboxStatusForAck(ack);
    if (status) updates.push({ messageId: keyId, status });
  }
  return updates;
}
```

`evolutionApi.ts` event union:

```ts
export type EvolutionEvent =
  | "MESSAGES_UPSERT"
  | "MESSAGES_UPDATE"
  | "CONNECTION_UPDATE"
  | "QRCODE_UPDATED";
```

Bridge `EVOLUTION_EVENTS`: add `"MESSAGES_UPDATE"` after `"MESSAGES_UPSERT"`. Add `"resubscribe_webhook"` to the action union and:

```ts
// One-time repair for instances paired before MESSAGES_UPDATE was subscribed. Same URL,
// same jwt_key header, the full current event list.
async function resubscribeWebhook(context: Awaited<ReturnType<typeof authenticateRequest>>, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  await findOwnedAccount(context.admin, context.user.id, body.social_account_id);
  const instance = await findInstance(context.admin, body.social_account_id);
  await createEvolutionApi().setWebhook(instance.instance_name, {
    url: `${context.webhookBaseUrl}/functions/v1/whatsapp-evolution-webhook`,
    headers: { jwt_key: instance.jwt_key },
    events: EVOLUTION_EVENTS,
  });
  return { success: true, social_account_id: body.social_account_id, events: EVOLUTION_EVENTS };
}
```

with the dispatch branch `if (body.action === "resubscribe_webhook") return restrictedJsonResponse(req, await resubscribeWebhook(context, body));`. (`context.webhookBaseUrl` is what `createAndGetQr` already uses; confirm the name in `authenticateRequest` and reuse it.)

Webhook handler, `whatsapp-evolution-webhook/index.ts`: import `{ ackUpdates, shouldAdvanceStatus }` and add

```ts
async function handleMessagesUpdate(admin: any, account: EvolutionAccount, body: any): Promise<void> {
  for (const update of ackUpdates(messageItems(body))) {
    const { data: row, error: readError } = await admin
      .from("whatsapp_messages")
      .select("id, status")
      .eq("social_account_id", account.id)
      .eq("message_id", update.messageId)
      .maybeSingle();
    if (readError) throw readError;
    if (!row || !shouldAdvanceStatus(row.status, update.status)) continue;
    const { error } = await admin
      .from("whatsapp_messages")
      .update({ status: update.status })
      .eq("id", row.id);
    if (error) throw error;
  }
}
```

and in `Deno.serve`: `else if (event === "MESSAGES_UPDATE") { await handleMessagesUpdate(admin, account, body); }` before the `CONNECTION_UPDATE` branch.

- [ ] **Step 4: Run tests, type-check, commit**

```bash
deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none supabase/functions/_shared/evolutionMessageAck.test.ts
deno check supabase/functions/_shared/evolutionMessageAck.ts supabase/functions/whatsapp-evolution-webhook/index.ts supabase/functions/whatsapp-evolution-bridge/index.ts
git add supabase/functions/_shared/evolutionMessageAck.ts supabase/functions/_shared/evolutionMessageAck.test.ts supabase/functions/_shared/evolutionApi.ts supabase/functions/whatsapp-evolution-webhook/index.ts supabase/functions/whatsapp-evolution-bridge/index.ts
git commit -m "feat(whatsapp): apply Evolution delivery and read acks to outbound messages"
```

---

### Task 7: Status ticks and absolute time in the bubble

**Files:**
- Create: `src/features/whatsapp-inbox/domain/messageStatus.ts` + `.test.ts`
- Create: `src/features/whatsapp-inbox/ui/WhatsAppStatusTicks.tsx`
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppMessageBubble.tsx`
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppMessageBubble.test.tsx`

**Interfaces:**
- `tickKindFor(status: string | null | undefined): "sent" | "delivered" | "read" | "failed"` (unknown → `sent`).
- `<WhatsAppStatusTicks status={message.status} />` renders an `<span data-testid="wa-ticks" data-status="read">`.

- [ ] **Step 1: Failing tests**

```ts
// src/features/whatsapp-inbox/domain/messageStatus.test.ts
import { describe, expect, it } from "vitest";
import { tickKindFor } from "./messageStatus";

describe("tickKindFor", () => {
  it("maps stored statuses to tick kinds and defaults to sent", () => {
    expect(tickKindFor("read")).toBe("read");
    expect(tickKindFor("delivered")).toBe("delivered");
    expect(tickKindFor("failed")).toBe("failed");
    expect(tickKindFor("sent")).toBe("sent");
    expect(tickKindFor("received")).toBe("sent");
    expect(tickKindFor(null)).toBe("sent");
  });
});
```

Append to `WhatsAppMessageBubble.test.tsx`:

```tsx
  it("shows ticks only on sent bubbles and reflects the status", () => {
    renderBubble(message({ status: "read", direction: "outbound" }), { isSent: true });
    expect(screen.getByTestId("wa-ticks")).toHaveAttribute("data-status", "read");
  });

  it("shows no ticks on received bubbles", () => {
    renderBubble(message({ status: "received" }), { isSent: false });
    expect(screen.queryByTestId("wa-ticks")).not.toBeInTheDocument();
  });

  it("renders the time as HH:mm", () => {
    renderBubble(message({ created_time: "2026-08-25T10:07:00.000Z" }));
    const expected = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date("2026-08-25T10:07:00.000Z"));
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure** — `bun run test -- src/features/whatsapp-inbox`.

- [ ] **Step 3: Implement**

```ts
// src/features/whatsapp-inbox/domain/messageStatus.ts
export type TickKind = "sent" | "delivered" | "read" | "failed";

/** whatsapp_messages.status → tick. Inbound rows carry "received" and never render ticks. */
export function tickKindFor(status: string | null | undefined): TickKind {
  if (status === "delivered" || status === "read" || status === "failed") return status;
  return "sent";
}

export function formatBubbleTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
```

```tsx
// src/features/whatsapp-inbox/ui/WhatsAppStatusTicks.tsx
import { AlertCircle, Check, CheckCheck } from "lucide-react";
import { tickKindFor } from "../domain/messageStatus";

export function WhatsAppStatusTicks({ status }: { status: string | null | undefined }): JSX.Element {
  const kind = tickKindFor(status);
  const icon = kind === "failed"
    ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    : kind === "read"
      ? <CheckCheck className="h-3.5 w-3.5 text-sky-500" />
      : kind === "delivered"
        ? <CheckCheck className="h-3.5 w-3.5 opacity-60" />
        : <Check className="h-3.5 w-3.5 opacity-60" />;
  return (
    <span data-testid="wa-ticks" data-status={kind} aria-label={`Message ${kind}`} className="inline-flex">
      {icon}
    </span>
  );
}
```

In `WhatsAppMessageBubble.tsx`: import `formatBubbleTime` and `WhatsAppStatusTicks`; replace the `format(new Date(message.created_time), "MMM d, h:mm a")` span with

```tsx
      <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>{formatBubbleTime(message.created_time)}</span>
        {isSent ? <WhatsAppStatusTicks status={message.status} /> : null}
      </span>
```

and remove the now-unused `date-fns` import. Change the bubble colours to the WhatsApp tokens: sent → `rounded-br-sm bg-whatsapp/20 text-foreground dark:bg-whatsapp-dark/40`, received → `rounded-bl-sm bg-card text-foreground shadow-sm`.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/features/whatsapp-inbox
git add src/features/whatsapp-inbox/domain/messageStatus.ts src/features/whatsapp-inbox/domain/messageStatus.test.ts src/features/whatsapp-inbox/ui/WhatsAppStatusTicks.tsx src/features/whatsapp-inbox/ui/WhatsAppMessageBubble.tsx src/features/whatsapp-inbox/ui/WhatsAppMessageBubble.test.tsx
git commit -m "feat(whatsapp): delivery ticks and WhatsApp-style bubble colours"
```

---

### Task 8: Forward — messaging-api action

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts` (new action after `whatsapp_send_media`)

**Interfaces:**
- Action `whatsapp_forward_message` body `{ social_account_id, message_row_id, to_phone }` → `{ success: true, message_id }`. Errors as `{ error_type: "media_unavailable" | "empty_message", error }` with HTTP 200 (matching `messagingApiClient` which treats `error_type` as final).

- [ ] **Step 1: Implement** (the action is a composition of two already-tested paths; the Deno-level test lives in Task 15's e2e checklist, the unit coverage is on `resolveWhatsAppMedia` and the transport)

```ts
    // ACTION: whatsapp_forward_message
    if (action === "whatsapp_forward_message") {
      const { social_account_id, message_row_id, to_phone } = body;
      if (!social_account_id || !message_row_id || !to_phone) {
        throw new Error("social_account_id, message_row_id, and to_phone required");
      }
      const recipientPhone = String(to_phone).replace(/\D/g, "");
      if (recipientPhone.length < 8) throw new Error("to_phone must be a phone number");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_send_message",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      const { data: source, error: sourceError } = await adminClient
        .from("whatsapp_messages")
        .select("id, message_text, message_type, media_type, media_url, media_metadata")
        .eq("social_account_id", social_account_id)
        .eq("id", message_row_id)
        .maybeSingle();
      if (sourceError) throw sourceError;
      if (!source) throw new Error("Message not found");

      const transport = await resolveWhatsAppTransport(adminClient, {
        id: account.accountId,
        platform_user_id: account.platformUserId,
        access_token: account.accessToken,
        connection_mode: account.connectionMode,
        account_metadata: account.accountMetadata as Record<string, unknown> | null,
      });
      const phoneNumberId = account.platformUserId;
      const conversationId = `wa_${phoneNumberId}_${recipientPhone}`;

      let data: any;
      let preview: string;
      let row: Record<string, unknown>;
      if (source.media_type) {
        const [media] = await resolveWhatsAppMedia(adminClient, account, { messageRowIds: [source.id] });
        if (!media?.url) {
          return jsonResponse({ error_type: "media_unavailable", error: "This file is no longer available to forward" });
        }
        const kind = media.kind;
        data = (await transport.sendMedia({
          recipientPhone,
          mediaUrl: media.url,
          mediaType: kind,
          caption: undefined,
          fileName: kind === "document" ? media.file_name || "file" : undefined,
        })).raw;
        preview = `[${kind}]`;
        row = {
          message_text: preview,
          message_type: kind,
          media_url: source.media_url,
          media_type: source.media_type,
          media_metadata: source.media_metadata,
        };
      } else {
        const text = String(source.message_text || "").trim();
        if (!text) return jsonResponse({ error_type: "empty_message", error: "This message has nothing to forward" });
        data = (await transport.sendText({ recipientPhone, text })).raw;
        preview = text;
        row = { message_text: text, message_type: "text" };
      }
      const sentMessageId = data?.messages?.[0]?.id || data?.key?.id;

      await adminClient.from("whatsapp_messages").insert({
        user_id: account.ownerId,
        social_account_id,
        conversation_id: conversationId,
        message_id: sentMessageId,
        from_phone: phoneNumberId,
        from_name: "You",
        to_phone: recipientPhone,
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
        ...row,
      });
      await upsertOutboundConversation(adminClient, {
        user_id: account.ownerId,
        social_account_id,
        workspace_id: account.workspaceId,
        phone_number_id: phoneNumberId,
        recipient_phone: recipientPhone,
        preview,
      });
      return jsonResponse({ success: true, message_id: sentMessageId });
    }
```

`resolveWhatsAppMedia` and `resolveWhatsAppTransport` are already imported in this file (used by `whatsapp_get_media` and `whatsapp_send_message`); check the exact `resolveWhatsAppMedia` signature at `_shared/whatsappMediaResolver.ts:110` and pass the same access object `whatsapp_get_media` passes.

- [ ] **Step 2: Type-check and commit**

```bash
deno check supabase/functions/messaging-api/index.ts
git add supabase/functions/messaging-api/index.ts
git commit -m "feat(whatsapp): forward a text or media message to another number"
```

---

### Task 9: Forward — port, adapter, dialog, menu

**Files:**
- Modify: `src/features/whatsapp-inbox/application/ports.ts`
- Modify: `src/features/whatsapp-inbox/infrastructure/whatsappInboxApi.ts` (+ `.test.ts`)
- Create: `src/features/whatsapp-inbox/ui/WhatsAppForwardDialog.tsx` (+ `.test.tsx`)
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppMessageContextMenu.tsx`, `WhatsAppMessageBubble.tsx`, `WhatsAppConversationPane.tsx`
- Modify every test double that spells out `WhatsAppInboxApi` (grep `sendVoice: vi.fn()`): add `forwardMessage: vi.fn()` and `deleteConversation: vi.fn()`.

**Interfaces:**
- Port: `forwardMessage(input: { social_account_id: string; message_row_id: string; to_phone: string }): Promise<{ success: boolean; message_id?: string | null; error_type?: string; error?: string }>`
- Port: `deleteConversation(input: { social_account_id: string; conversation_id: string }): Promise<{ success: boolean }>` (declared now, implemented in Task 10).
- `WhatsAppForwardDialog` props: `{ open: boolean; onOpenChange(open: boolean): void; socialAccountId: string; messageRowId: string | null; targets: ForwardTarget[]; }` with `ForwardTarget = { phone: string; label: string }`.
- `WhatsAppMessageBubble` gains `onForward?(): void`; `WhatsAppMessageContextMenu` gains `onForward(): void`.

- [ ] **Step 1: Failing tests**

Adapter (`whatsappInboxApi.test.ts`, follow the file's existing pattern of mocking `./messagingApiClient`):

```ts
  it("forwardMessage posts whatsapp_forward_message", async () => {
    await createWhatsAppInboxApi().forwardMessage({ social_account_id: "a", message_row_id: "m", to_phone: "96555" });
    expect(callMessagingApi).toHaveBeenCalledWith("whatsapp_forward_message", { social_account_id: "a", message_row_id: "m", to_phone: "96555" });
  });
```

Dialog (`WhatsAppForwardDialog.test.tsx`):

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";
import { WhatsAppForwardDialog } from "./WhatsAppForwardDialog";

const forwardMessage = vi.fn(async () => ({ success: true, message_id: "x" }));
const api = { forwardMessage } as unknown as WhatsAppInboxApi;

describe("WhatsAppForwardDialog", () => {
  it("filters targets and forwards on pick", async () => {
    const onOpenChange = vi.fn();
    render(
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppForwardDialog
          open
          onOpenChange={onOpenChange}
          socialAccountId="acct-1"
          messageRowId="row-1"
          targets={[{ phone: "96555", label: "Ali" }, { phone: "96599", label: "Sara" }]}
        />
      </WhatsAppInboxApiProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("Search chats or contacts"), { target: { value: "sar" } });
    expect(screen.queryByText("Ali")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Sara"));
    await waitFor(() => expect(forwardMessage).toHaveBeenCalledWith({ social_account_id: "acct-1", message_row_id: "row-1", to_phone: "96599" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test -- src/features/whatsapp-inbox`.

- [ ] **Step 3: Implement**

`ports.ts` additions:

```ts
export interface ForwardMessageRequest {
  social_account_id: string;
  message_row_id: string;
  to_phone: string;
}

export interface ForwardMessageResponse {
  success: boolean;
  message_id?: string | null;
  error_type?: string;
  error?: string;
}

export interface DeleteConversationRequest {
  social_account_id: string;
  conversation_id: string;
}
```

and on `WhatsAppInboxApi`:

```ts
  forwardMessage(input: ForwardMessageRequest): Promise<ForwardMessageResponse>;
  deleteConversation(input: DeleteConversationRequest): Promise<{ success: boolean }>;
```

Adapter:

```ts
    forwardMessage(input: ForwardMessageRequest): Promise<ForwardMessageResponse> {
      return callMessagingApi<ForwardMessageResponse>("whatsapp_forward_message", { ...input });
    },
    deleteConversation(input: DeleteConversationRequest): Promise<{ success: boolean }> {
      return callMessagingApi<{ success: boolean }>("whatsapp_delete_conversation", { ...input });
    },
```

Dialog:

```tsx
// src/features/whatsapp-inbox/ui/WhatsAppForwardDialog.tsx
import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useWhatsAppInboxApi } from "./WhatsAppInboxApiProvider";

export interface ForwardTarget {
  phone: string;
  label: string;
}

interface WhatsAppForwardDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  socialAccountId: string;
  messageRowId: string | null;
  targets: ForwardTarget[];
}

export function WhatsAppForwardDialog({ open, onOpenChange, socialAccountId, messageRowId, targets }: WhatsAppForwardDialogProps): JSX.Element {
  const api = useWhatsAppInboxApi();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const term = search.trim().toLowerCase();
  const visible = term
    ? targets.filter((target) => target.label.toLowerCase().includes(term) || target.phone.includes(term))
    : targets;

  const pick = async (target: ForwardTarget) => {
    if (!messageRowId || busy) return;
    setBusy(true);
    try {
      const result = await api.forwardMessage({ social_account_id: socialAccountId, message_row_id: messageRowId, to_phone: target.phone });
      if (result.error_type) throw new Error(result.error ?? result.error_type);
      toast.success(`Forwarded to ${target.label}`);
      setSearch("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not forward");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onOpenChange(false)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>Pick a chat or contact. The message is sent immediately.</DialogDescription>
        </DialogHeader>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chats or contacts" />
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No matches</p>
          ) : (
            <ul>
              {visible.map((target) => (
                <li key={target.phone}>
                  <Button variant="ghost" disabled={busy} onClick={() => void pick(target)} className="h-auto w-full justify-between rounded-none border-b px-3 py-2.5">
                    <span className="min-w-0 text-left">
                      <span className="block truncate text-sm font-medium">{target.label}</span>
                      <span className="text-xs text-muted-foreground">+{target.phone}</span>
                    </span>
                    <Send className="h-4 w-4 shrink-0" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

Context menu: add `onForward(): void` to both prop interfaces and `<Item onSelect={onForward}>Forward</Item>` after `Copy`. Bubble: accept `onForward?(): void` and pass `onForward={() => onForward?.()}` to the menu. Pane: hold `const [forwardRowId, setForwardRowId] = useState<string | null>(null)`, pass `onForward={() => setForwardRowId(message.id)}` to each bubble, and render `<WhatsAppForwardDialog open={forwardRowId !== null} onOpenChange={(o) => !o && setForwardRowId(null)} socialAccountId={socialAccountId} messageRowId={forwardRowId} targets={forwardTargets} />`. The pane gets a new prop `forwardTargets: ForwardTarget[]`; `WhatsAppInboxScreen` builds it from `conversations` (`{ phone: c.participant_id, label: c.participant_name }`), deduped by phone, and passes it down. Update the screen test's pane render sites with `forwardTargets={[]}`.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/features/whatsapp-inbox
git add src/features/whatsapp-inbox
git commit -m "feat(whatsapp): forward messages from the inbox"
```

---

### Task 10: Delete a chat

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts` (action after `whatsapp_mark_read`)
- Modify: `src/components/messaging/ConversationList.tsx` (hover trash using the `onDelete` prop declared in Task 2)
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx` (confirm dialog + call)
- Test: `src/components/messaging/ConversationList.test.tsx`

- [ ] **Step 1: Failing test** (append)

```tsx
  it("shows a delete control per row when onDelete is given", () => {
    const onDelete = vi.fn();
    const rows = [conv("wa_1_96555", "Ali")];
    render(<ConversationList conversations={rows} selectedId={null} onSelect={vi.fn()} isLoading={false} onDelete={onDelete} />);
    fireEvent.click(screen.getByLabelText("Delete chat with Ali"));
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
  });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

Edge action:

```ts
    // ACTION: whatsapp_delete_conversation
    if (action === "whatsapp_delete_conversation") {
      const { social_account_id, conversation_id } = body;
      if (!social_account_id || !conversation_id) throw new Error("social_account_id and conversation_id required");

      const account = await withWhatsAppActionAccess({
        client: whatsappAccessClient,
        userId: user.id,
        action: "whatsapp_mark_read",
        socialAccountId: social_account_id,
      }, (access) => Promise.resolve(access));

      // Messages first: if this fails the cache row survives and the thread stays visible
      // rather than orphaning invisible rows. Contacts and cached media are kept.
      const { error: messagesError } = await adminClient
        .from("whatsapp_messages")
        .delete()
        .eq("social_account_id", social_account_id)
        .eq("conversation_id", conversation_id);
      if (messagesError) throw messagesError;
      const { error: cacheError } = await adminClient
        .from("messaging_cache")
        .delete()
        .eq("social_account_id", social_account_id)
        .eq("workspace_id", account.workspaceId)
        .eq("conversation_id", conversation_id);
      if (cacheError) throw cacheError;
      return jsonResponse({ success: true });
    }
```

`ConversationList.tsx`: wrap each row in `<div className="group relative">`, and when `onDelete` is set render before the `<button>`:

```tsx
              {onDelete && (
                <button
                  type="button"
                  aria-label={`Delete chat with ${conv.participant_name}`}
                  className="absolute right-1 top-1 z-10 rounded p-1 text-destructive opacity-0 hover:bg-muted group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={(event) => { event.stopPropagation(); onDelete(conv); }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
```

(import `Trash2` from lucide-react).

`WhatsAppInboxScreen.tsx`: state `const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)`; pass `onDelete={setDeleteTarget}` to the list; render an `AlertDialog` (from `@/components/ui/alert-dialog`) titled "Delete this chat?" with description "All messages in this chat are removed from Postora. The contact is kept." whose confirm runs:

```tsx
  const queryClient = useQueryClient();
  const confirmDelete = async () => {
    if (!deleteTarget || !selectedAccountId) return;
    try {
      await api.deleteConversation({ social_account_id: selectedAccountId, conversation_id: deleteTarget.id });
      if (selectedConversation?.id === deleteTarget.id) selectConversation(null);
      await queryClient.invalidateQueries({ queryKey: ["messaging-conversations", selectedAccountId] });
      toast.success("Chat deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete chat");
    } finally {
      setDeleteTarget(null);
    }
  };
```

(`toast` from `sonner`, `useQueryClient` from `@tanstack/react-query`.)

- [ ] **Step 4: Run tests, type-check, commit**

```bash
bun run test -- src/components/messaging src/features/whatsapp-inbox
deno check supabase/functions/messaging-api/index.ts
git add supabase/functions/messaging-api/index.ts src/components/messaging/ConversationList.tsx src/components/messaging/ConversationList.test.tsx src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx
git commit -m "feat(whatsapp): delete a chat from the inbox list"
```

---

### Task 11: Media — download on every kind, video and PDF lightbox

**Files:**
- Create: `src/features/whatsapp-inbox/domain/mediaKind.ts` + `.test.ts`
- Create: `src/features/whatsapp-inbox/ui/WhatsAppMediaLightbox.tsx`
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppMediaAttachment.tsx` (+ `.test.tsx`)

**Interfaces:**
- `resolveMediaKind(attachment: { kind: WhatsAppAttachmentKind; name: string | null; mime_type: string | null }, resolvedMime?: string | null): "image" | "video" | "audio" | "pdf" | "document"`.
- `<WhatsAppMediaLightbox entry={{ kind: "image" | "video" | "pdf"; url: string; fileName: string | null; urls?: string[] }} onClose() onDownload(url, fileName) />`.

- [ ] **Step 1: Failing tests**

```ts
// src/features/whatsapp-inbox/domain/mediaKind.test.ts
import { describe, expect, it } from "vitest";
import { resolveMediaKind } from "./mediaKind";

describe("resolveMediaKind", () => {
  it("passes image/video/audio through", () => {
    expect(resolveMediaKind({ kind: "image", name: null, mime_type: null })).toBe("image");
    expect(resolveMediaKind({ kind: "video", name: null, mime_type: null })).toBe("video");
    expect(resolveMediaKind({ kind: "audio", name: null, mime_type: null })).toBe("audio");
  });
  it("detects pdf by resolved mime, then stored mime, then name", () => {
    expect(resolveMediaKind({ kind: "document", name: "a.zip", mime_type: null }, "application/pdf")).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: null, mime_type: "application/pdf; charset=x" })).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: "Receipt.PDF", mime_type: null })).toBe("pdf");
    expect(resolveMediaKind({ kind: "document", name: "a.docx", mime_type: null })).toBe("document");
  });
});
```

Append to `WhatsAppMediaAttachment.test.tsx` (mirror the file's existing helper that renders an attachment with a resolved media map; if it uses a `resolvedMedia` fixture, reuse it):

```tsx
  it("offers a download on an image", async () => {
    // arrange a resolved image exactly as the existing image test does
    expect(await screen.findByLabelText("Download image")).toBeInTheDocument();
  });

  it("opens a PDF in the lightbox", async () => {
    // arrange a resolved document with mime_type "application/pdf"
    fireEvent.click(await screen.findByText("Receipt.pdf"));
    expect(screen.getByTitle("Receipt.pdf")).toBeInTheDocument(); // the iframe
  });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// src/features/whatsapp-inbox/domain/mediaKind.ts
import type { WhatsAppAttachmentKind } from "../application/ports";

export type MediaKind = "image" | "video" | "audio" | "pdf" | "document";

function isPdfMime(mime: string | null | undefined): boolean {
  return (mime ?? "").split(";")[0].trim().toLowerCase() === "application/pdf";
}

/** The resolved MIME wins (a name can lie); before resolution the stored MIME or the name decides. */
export function resolveMediaKind(
  attachment: { kind: WhatsAppAttachmentKind; name: string | null; mime_type: string | null },
  resolvedMime?: string | null,
): MediaKind {
  if (attachment.kind !== "document") return attachment.kind;
  if (resolvedMime != null) return isPdfMime(resolvedMime) ? "pdf" : "document";
  if (isPdfMime(attachment.mime_type)) return "pdf";
  return (attachment.name ?? "").toLowerCase().endsWith(".pdf") ? "pdf" : "document";
}
```

```tsx
// src/features/whatsapp-inbox/ui/WhatsAppMediaLightbox.tsx
import type { KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export interface LightboxEntry {
  kind: "image" | "video" | "pdf";
  url: string;
  fileName: string | null;
  /** Image galleries: every image url in the thread; navigation moves inside it. */
  urls?: string[];
}

interface WhatsAppMediaLightboxProps {
  entry: LightboxEntry | null;
  onClose(): void;
  onNavigate?(url: string): void;
  onDownload(url: string, fileName: string | null): void;
}

export function WhatsAppMediaLightbox({ entry, onClose, onNavigate, onDownload }: WhatsAppMediaLightboxProps): JSX.Element | null {
  if (!entry) return null;
  const urls = entry.kind === "image" ? entry.urls ?? [entry.url] : [entry.url];
  const index = Math.max(0, urls.indexOf(entry.url));
  const prev = () => onNavigate?.(urls[(index - 1 + urls.length) % urls.length]);
  const next = () => onNavigate?.(urls[(index + 1) % urls.length]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); prev(); }
    if (event.key === "ArrowRight") { event.preventDefault(); next(); }
  };
  const label = entry.fileName ?? (entry.kind === "image" ? "Image" : entry.kind === "video" ? "Video" : "PDF");

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl overflow-hidden border-none bg-black/95 p-2" onKeyDown={onKeyDown} hideCloseButton>
        <div className="relative flex min-h-[60vh] items-center justify-center">
          {entry.kind === "image" ? (
            <img src={entry.url} alt={label} className="max-h-[80vh] w-full object-contain" />
          ) : entry.kind === "video" ? (
            <video src={entry.url} controls autoPlay playsInline className="max-h-[80vh] w-full rounded-md bg-black" />
          ) : (
            <iframe src={entry.url} title={label} className="h-[80vh] w-full rounded-md bg-white" />
          )}
          {urls.length > 1 && (
            <>
              <Button type="button" size="icon" variant="secondary" aria-label="Previous image" onClick={prev} className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full"><ChevronLeft className="h-5 w-5" /></Button>
              <Button type="button" size="icon" variant="secondary" aria-label="Next image" onClick={next} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"><ChevronRight className="h-5 w-5" /></Button>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => onDownload(entry.url, entry.fileName)}><Download className="h-4 w-4" /> Download</Button>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

`WhatsAppMediaAttachment.tsx`:
- Remove the local `ImageLightbox`; keep one `const [lightbox, setLightbox] = useState<LightboxEntry | null>(null)`.
- Add a download helper using the port: `const api = useWhatsAppInboxApi(); const download = async (url: string, fileName: string | null) => { const blob = await (await fetch(url)).blob(); api.downloadBlob(blob, fileName || \`whatsapp-${attachment.message_row_id}\`); }` (the `useWhatsAppInboxApi` import from `./WhatsAppInboxApiProvider` is a ui→ui import, allowed).
- `const kind = resolveMediaKind(attachment, resolved?.mime_type);`
- image: keep the thumbnail button but `onClick={() => setLightbox({ kind: "image", url, fileName: attachment.name, urls: imageUrls })}`, plus a small `<button aria-label="Download image">` with a `Download` icon under it.
- video: `<video ... />` unchanged plus an overlay row with `aria-label="Open video"` (sets `{ kind: "video" }`) and `aria-label="Download video"`.
- audio: keep `VoiceNotePlayer`, add `aria-label="Download audio"`.
- pdf: a card like `DocumentCard` whose filename is a button opening `{ kind: "pdf", url: resolved.url, fileName }`, plus the existing download link.
- document: `DocumentCard` unchanged.
- Render `<WhatsAppMediaLightbox entry={lightbox} onClose={() => setLightbox(null)} onNavigate={(url) => setLightbox((e) => e && { ...e, url })} onDownload={(url, name) => void download(url, name)} />` at the end.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/features/whatsapp-inbox
git add src/features/whatsapp-inbox
git commit -m "feat(whatsapp): download any attachment, preview video and PDF in the lightbox"
```

---

### Task 12: Thread layout — day separators, absolute list times, header phone, wallpaper

**Files:**
- Create: `src/features/whatsapp-inbox/domain/dayGroups.ts` + `.test.ts`
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppConversationPane.tsx`
- Modify: `src/components/messaging/ConversationList.tsx` (`absoluteTimes`)
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppInboxScreen.tsx` (pass `absoluteTimes`)
- Modify: `src/features/whatsapp-inbox/tests/WhatsAppInboxScreen.test.tsx`

**Interfaces:**
- `groupByDay<T extends { created_time: string }>(messages: T[]): Array<{ day: string; label: string; rows: T[] }>`; `day` = local `YYYY-MM-DD`, `label` = "Today" | "Yesterday" | `Intl.DateTimeFormat(undefined, { dateStyle: "medium" })`.
- `formatListTime(iso: string, now?: Date): string` → `HH:mm` same day, else `dd/MM/yy`.

- [ ] **Step 1: Failing tests**

```ts
// src/features/whatsapp-inbox/domain/dayGroups.test.ts
import { describe, expect, it } from "vitest";
import { formatListTime, groupByDay } from "./dayGroups";

describe("groupByDay", () => {
  it("groups consecutive messages by local day and labels today/yesterday", () => {
    const now = new Date();
    const today = new Date(now); today.setHours(9, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const groups = groupByDay([
      { id: "1", created_time: yesterday.toISOString() },
      { id: "2", created_time: today.toISOString() },
      { id: "3", created_time: today.toISOString() },
    ], now);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([["Yesterday", 1], ["Today", 2]]);
  });
});

describe("formatListTime", () => {
  it("uses the time today and the short date otherwise", () => {
    const now = new Date(2026, 8, 6, 15, 0, 0);
    expect(formatListTime(new Date(2026, 8, 6, 9, 5, 0).toISOString(), now)).toMatch(/09:05/);
    expect(formatListTime(new Date(2026, 7, 30, 9, 5, 0).toISOString(), now)).toBe("30/08/26");
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// src/features/whatsapp-inbox/domain/dayGroups.ts
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayLabel(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

export interface DayGroup<T> { day: string; label: string; rows: T[] }

export function groupByDay<T extends { created_time: string }>(messages: T[], now: Date = new Date()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of messages) {
    const date = new Date(row.created_time);
    const day = localDayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, label: dayLabel(date, now), rows: [row] });
  }
  return groups;
}

export function formatListTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (localDayKey(date) === localDayKey(now)) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${String(date.getFullYear()).slice(-2)}`;
}
```

`WhatsAppConversationPane.tsx`: `const groups = useMemo(() => groupByDay(visibleMessages), [visibleMessages]);` and replace `visibleMessages.map((message) => <WhatsAppMessageBubble .../>)` with

```tsx
          groups.map((group) => (
            <div key={group.day} className="space-y-3">
              <div className="flex justify-center">
                <span className="rounded-md bg-card px-2 py-0.5 text-[11px] text-muted-foreground shadow-sm">{group.label}</span>
              </div>
              {group.rows.map((message) => (
                <WhatsAppMessageBubble key={message.id} /* same props as before */ />
              ))}
            </div>
          ))
```

Message pane container: add `bg-whatsapp/5 dark:bg-whatsapp-dark/10` to the scroll div's className. Header: under the name replace the "Active / N unread" line with

```tsx
          <p className="text-xs text-muted-foreground" dir="ltr">
            +{conversation.participant_id}
            {conversation.unread_count > 0 ? ` · ${conversation.unread_count} unread` : ""}
          </p>
```

`ConversationList.tsx`: import `formatListTime` from `@/features/whatsapp-inbox` (add `export { formatListTime } from "./domain/dayGroups";` to `src/features/whatsapp-inbox/index.ts`) and render `absoluteTimes ? formatListTime(conv.last_message_time) : formatDistanceToNow(...)`. Screen passes `absoluteTimes`.

Update `WhatsAppInboxScreen.test.tsx` expectations that matched "Active" if any (grep the file for `"Active"`).

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/components/messaging src/features/whatsapp-inbox
git add src/features/whatsapp-inbox src/components/messaging/ConversationList.tsx
git commit -m "feat(whatsapp): day separators, absolute times, phone in the header"
```

---

### Task 13: Add / edit contact from the thread header

**Files:**
- Modify: `src/components/messaging/contacts/ContactFormDialog.tsx` (`initialPhone` prop)
- Modify: `src/features/whatsapp-inbox/ui/WhatsAppConversationPane.tsx`
- Modify: `src/features/whatsapp-inbox/tests/WhatsAppInboxScreen.test.tsx`

**Interfaces:**
- `ContactFormDialog` new optional prop `initialPhone?: string` used only when `contact` is null: seeds `phone_number` in add mode.
- Pane reads the directory row through a small query: `useQuery(["whatsapp-contact-by-phone", workspaceId, phone])` selecting `id, phone_number, display_name, first_name, last_name, email, company, job_title, phone_secondary, street, city, country, birthday, website, notes, tags, avatar_url` from `whatsapp_contacts` where `workspace_id = activeWorkspaceId and phone_number = phone`. This lives in the pane because it is view state, and the Supabase client is what the sibling `contacts/` components already use.

- [ ] **Step 1: Failing test** (append to the screen test; the file already mocks `useConversations` with `testState.conversations` and renders the pane — add a mock for `@/integrations/supabase/client` returning an empty contact list, following the file's existing `vi.mock` style, and)

```tsx
  it("offers Add to contacts when the number is not in the directory", async () => {
    // seed one conversation and select it (reuse the file's existing selection helper)
    expect(await screen.findByLabelText("Add to contacts")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`ContactFormDialog.tsx`: add `initialPhone?: string` to the props and change the reset effect's `: EMPTY` branch to `: { ...EMPTY, phone_number: initialPhone ?? "" }`; add `initialPhone` to the effect deps.

Pane: import `ContactFormDialog` and `ContactRecord` (from `@/components/messaging/contacts/contactCodecs`), `supabase` client, `useQuery`, `useWhatsAppWorkspaceContext` (already imported), `UserPlus` and `Pencil` icons.

```tsx
  const { activeWorkspaceId } = useWhatsAppWorkspaceContext();
  const phone = conversation?.participant_id ?? null;
  const contactQuery = useQuery({
    queryKey: ["whatsapp-contact-by-phone", activeWorkspaceId, phone],
    enabled: Boolean(activeWorkspaceId && phone),
    queryFn: async (): Promise<ContactRecord | null> => {
      const { data, error } = await supabase
        .from("whatsapp_contacts")
        .select("id, phone_number, display_name, first_name, last_name, email, company, job_title, phone_secondary, street, city, country, birthday, website, notes, tags, avatar_url")
        .eq("workspace_id", activeWorkspaceId as string)
        .eq("phone_number", phone as string)
        .maybeSingle();
      if (error) throw error;
      return (data as ContactRecord | null) ?? null;
    },
  });
  const [contactOpen, setContactOpen] = useState(false);
  const directoryContact = contactQuery.data ?? null;
  const hasName = Boolean(directoryContact?.display_name && directoryContact.display_name.replace(/^\+/, "") !== phone);
```

Header, after the name block and before the AI mode select:

```tsx
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label={hasName ? "Edit contact" : "Add to contacts"}
          title={hasName ? "Edit contact" : "Add to contacts"}
          onClick={() => setContactOpen(true)}
        >
          {hasName ? <Pencil className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
        </Button>
```

and at the end of the component tree:

```tsx
      <ContactFormDialog
        open={contactOpen}
        onOpenChange={(open) => { setContactOpen(open); if (!open) void contactQuery.refetch(); }}
        contact={directoryContact}
        initialPhone={phone ?? undefined}
      />
```

`useContactMutations` already invalidates `["messaging-conversations"]`, so the list name refreshes through Task 1's directory override.

- [ ] **Step 4: Run tests and commit**

```bash
bun run test -- src/features/whatsapp-inbox src/components/messaging
git add src/components/messaging/contacts/ContactFormDialog.tsx src/features/whatsapp-inbox
git commit -m "feat(whatsapp): add or edit the contact from the conversation header"
```

---

### Task 14: Gates and guard passes

- [ ] **Step 1:** `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=none supabase/functions/_shared/` then `deno check` on every edge file touched. Then `bun install` (if `node_modules` was touched) and `bun run typecheck && bun run lint && bun run test`. All green, or fix.
- [ ] **Step 2:** Run `clean-code-guard` on every production file in the file map; run `test-guard` on every test file. Apply fixes, re-run gates.
- [ ] **Step 3:** `graphify update .`
- [ ] **Step 4:** Commit any fixes scoped to the files touched.

---

### Task 15: Ops, deploy, verify

- [ ] **Step 1: Migration.** Rehearse `20260906120000_whatsapp_evolution_sync_outcome.sql` on the db-harness; apply on prod as `supabase_admin` via `ssh-contabo-mcp` (`docker exec <db> psql -U supabase_admin -d postgres -f -`), then `NOTIFY pgrst, 'reload schema'`.
- [ ] **Step 2: Edge deploy.** Push the branch; on Contabo `cd /root/postora-runtime && git fetch origin refs/heads/worktree-whatsapp-inbox-parity && git checkout FETCH_HEAD -- supabase/functions`, copy `_shared`, `messaging-api`, `whatsapp-evolution-webhook`, `whatsapp-evolution-bridge` into the functions volume per `docs/runbooks/deploy-edge-function.md`, verify SHA256, `docker compose ... restart functions`. Probe each function with an unauthenticated POST and expect 401.
- [ ] **Step 3: Evolution flag.** Find the Dokploy application for `postora-evolutionapi` (`project-all` → `application-one`), append `CONFIG_SESSION_PHONE_SYNC_FULL_HISTORY=true` to its env with `application-saveEnvironment`, then `application-redeploy`. Confirm with `docker service inspect postora-evolutionapi-zenkpi --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' | grep FULL_HISTORY`.
- [ ] **Step 4: Re-subscribe acks.** For every row in `whatsapp_evolution_instances` joined to an active `evolution_qr` account, call the bridge `resubscribe_webhook` action as the owning user (sign in as the admin user for admin-owned accounts; for other users' accounts run `POST /webhook/set/<instance>` on Evolution directly from the host with the same URL, `jwt_key` header and the four events). Verify with `GET /webhook/find/<instance>`.
- [ ] **Step 5: Ask the user to re-pair** each QR account (Setup → disconnect → connect) so Baileys pulls full history; then press "Sync past chats" until the toast says complete.
- [ ] **Step 6: Verify.** In the inbox: the 264-chat account lists more than 50 rows; search by digits finds a chat; send one message and watch ticks move; forward one text and one image; delete a test chat; open a PDF and a video in the lightbox; header shows the phone and the contact button. SQL: `select status, count(*) from whatsapp_messages where direction='outbound' and timestamp > now() - interval '1 day' group by 1;` shows delivered/read rows.
- [ ] **Step 7:** Open the PR with `commit-commands:commit-push-pr`, babysit one Codex review round, merge. Save a mem0 memory (issue, root causes, fix, files). Final report.
