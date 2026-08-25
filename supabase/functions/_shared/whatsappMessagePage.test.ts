// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  clampLimit,
  conversationIdsForFilter,
  keysetOrFilter,
  LEGACY_MESSAGE_LIMIT,
  MalformedMessageCursorError,
  pageFetchLimit,
  PAGINATED_DEFAULT_LIMIT,
  parseMessageCursor,
  parseWhatsAppMessagePageRequest,
  sliceWhatsAppMessagePage,
} from "./whatsappMessagePage.ts";

function row(id: string, timestamp: string) {
  return { id, timestamp, message_text: id };
}

function newestFirst(count: number, start = 0) {
  return Array.from({ length: count }, (_, index) => {
    const n = start + count - 1 - index;
    return row(`id-${String(n).padStart(3, "0")}`, `2026-08-25T12:${String(n).padStart(2, "0")}:00.000Z`);
  });
}

Deno.test("clampLimit defaults, rejects junk, and caps at 100", () => {
  assertEquals(clampLimit(undefined), PAGINATED_DEFAULT_LIMIT);
  assertEquals(clampLimit(0), PAGINATED_DEFAULT_LIMIT);
  assertEquals(clampLimit(5000), 100);
  assertEquals(clampLimit("abc"), PAGINATED_DEFAULT_LIMIT);
  assertEquals(clampLimit(40), 40);
  assertEquals(clampLimit(1), 1);
});

Deno.test("a legacy call (no limit, no before) is 100 rows and has no page_info", () => {
  const request = parseWhatsAppMessagePageRequest({
    action: "whatsapp_get_messages",
    social_account_id: "acct",
    conversation_id: "conv",
  });
  assertEquals(request, { mode: "legacy" });
  assertEquals(pageFetchLimit(request), LEGACY_MESSAGE_LIMIT);

  const rows = newestFirst(100);
  const page = sliceWhatsAppMessagePage(rows, request);
  assertEquals(page.rows.length, 100);
  assertEquals(page.page_info, undefined);
});

Deno.test("an old-client projection still resolves while additive message fields remain", () => {
  const page = sliceWhatsAppMessagePage(newestFirst(100), { mode: "legacy" });
  const envelope = { messages: page.rows };
  assertEquals("page_info" in envelope, false);
  assertEquals(envelope.messages.length, 100);
  assertEquals(Object.keys(envelope).sort(), ["messages"]);
});

Deno.test("a paginated call defaults to 40 and includes page_info", () => {
  const request = parseWhatsAppMessagePageRequest({ limit: undefined });
  assertEquals(request.mode, "paginated");
  if (request.mode !== "paginated") return;
  assertEquals(request.limit, 40);
  assertEquals(pageFetchLimit(request), 41);

  const fetched = newestFirst(41);
  const page = sliceWhatsAppMessagePage(fetched, request);
  assertEquals(page.rows.length, 40);
  assertEquals(page.page_info?.has_more, true);
  assertEquals(page.page_info?.next_before, {
    timestamp: fetched[39].timestamp,
    id: fetched[39].id,
  });
});

Deno.test("cursor round-trip: next_before parses and reproduces the keyset filter", () => {
  const request = parseWhatsAppMessagePageRequest({
    limit: 40,
    before: { timestamp: "2026-08-25T12:00:00.000Z", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  });
  if (request.mode !== "paginated" || !request.before) {
    throw new Error("expected paginated request with a cursor");
  }
  const fetched = newestFirst(41);
  const page = sliceWhatsAppMessagePage(fetched, { mode: "paginated", limit: 40 });
  const cursor = parseMessageCursor(page.page_info?.next_before);
  assertEquals(cursor, page.page_info?.next_before);
  assertEquals(
    keysetOrFilter(cursor),
    `timestamp.lt.${cursor.timestamp},and(timestamp.eq.${cursor.timestamp},id.lt.${cursor.id})`,
  );
});

Deno.test("a malformed cursor throws rather than silently returning page one", () => {
  const malformed = [
    "not-an-object",
    12,
    {},
    { timestamp: "2026-08-25T12:00:00.000Z" },
    { id: "row-1" },
    { timestamp: "", id: "row-1" },
    { timestamp: "not-a-date", id: "row-1" },
    { timestamp: "2026-08-25T12:00:00.000Z", id: "row,injected" },
    { timestamp: "2026-08-25T12:00:00.000Z,id.gt.x", id: "row-1" },
  ];
  for (const value of malformed) {
    assertThrows(
      () => parseWhatsAppMessagePageRequest({ before: value }),
      MalformedMessageCursorError,
    );
  }
});

Deno.test("conversation filter values are unique and keep the plus-prefix variant", () => {
  assertEquals(
    conversationIdsForFilter("wa_1_96550000000", "wa_1_+96550000000"),
    ["wa_1_96550000000", "wa_1_+96550000000"],
  );
  assertEquals(conversationIdsForFilter("wa_1_9655", "wa_1_9655"), ["wa_1_9655"]);
});
