// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  attachmentKindFromMediaType,
  toWhatsAppMessageView,
  type WhatsAppMessageRow,
} from "./whatsappMessageView.ts";

function row(overrides: Partial<WhatsAppMessageRow> = {}): WhatsAppMessageRow {
  return {
    id: "row-1",
    message_id: "BAILEYSKEY",
    message_text: "hello",
    from_name: "Ada",
    from_phone: "1555",
    to_phone: "1999",
    timestamp: "2026-08-25T12:00:00.000Z",
    media_url: null,
    media_type: null,
    media_metadata: null,
    media_understanding: null,
    direction: "inbound",
    status: "received",
    ...overrides,
  };
}

Deno.test("provider_message_id comes from message_id, not a wamid alias", () => {
  const view = toWhatsAppMessageView(row({ message_id: "3EB0ABC" }));
  assertEquals(view.provider_message_id, "3EB0ABC");
  assertEquals("wamid" in view, false);
});

Deno.test("a null message_id becomes a null provider_message_id", () => {
  const view = toWhatsAppMessageView(row({ message_id: null }));
  assertEquals(view.provider_message_id, null);
});

Deno.test("direction, status, and media_understanding are passed through", () => {
  const view = toWhatsAppMessageView(row({
    direction: "outbound",
    status: "sent",
    media_understanding: "a cat on a sofa",
  }));
  assertEquals(view.direction, "outbound");
  assertEquals(view.status, "sent");
  assertEquals(view.media_understanding, "a cat on a sofa");
});

Deno.test("attachments are empty when media_type is null", () => {
  const view = toWhatsAppMessageView(row({ media_url: "https://lookaside.fbsbx.com/x" }));
  assertEquals(view.attachments, []);
});

Deno.test("typed attachments keep file_url and derive kind from media_type", () => {
  const view = toWhatsAppMessageView(row({
    media_type: "video",
    media_url: "https://lookaside.fbsbx.com/clip",
    media_metadata: { mime_type: "video/mp4", filename: "clip.mp4" },
  }));
  assertEquals(view.attachments, [{
    kind: "video",
    message_row_id: "row-1",
    mime_type: "video/mp4",
    name: "clip.mp4",
    needs_fetch: true,
    file_url: "https://lookaside.fbsbx.com/clip",
  }]);
});

Deno.test("sticker renders as an image kind", () => {
  assertEquals(attachmentKindFromMediaType("sticker"), "image");
  const view = toWhatsAppMessageView(row({
    media_type: "sticker",
    media_metadata: { mime_type: "image/webp" },
  }));
  assertEquals(view.attachments[0]?.kind, "image");
  assertEquals(view.attachments[0]?.file_url, null);
});

Deno.test("the legacy envelope fields stay in place", () => {
  const view = toWhatsAppMessageView(row());
  assertEquals(view.id, "row-1");
  assertEquals(view.message, "hello");
  assertEquals(view.from, { name: "Ada", id: "1555" });
  assertEquals(view.to, [{ name: "", id: "1999" }]);
  assertEquals(view.created_time, "2026-08-25T12:00:00.000Z");
});

Deno.test("revoked_at and revoked_by are not mapped — the columns do not exist yet", () => {
  const view = toWhatsAppMessageView({
    ...row(),
    revoked_at: "2026-08-25T12:00:00.000Z",
    revoked_by: "user-1",
  } as any);
  assertEquals("revoked_at" in view, false);
  assertEquals("revoked_by" in view, false);
});
