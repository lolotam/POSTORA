// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  attachmentList,
  describeAttachment,
  firstReadableAttachment,
  leadPlaceholder,
  noteUnreadAttachments,
} from "./attachments.ts";

const image = { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/p.jpg" } };
const voice = { type: "audio", payload: { url: "https://cdn.fbsbx.com/audioclip-1.mp4" } };
const video = { type: "video", payload: { url: "https://video.xx.fbcdn.net/v.mp4" } };
const doc = { type: "file", payload: { url: "https://cdn.fbsbx.com/invoice.pdf" } };

Deno.test("Meta's own words map onto the kinds the pipeline understands", () => {
  assertEquals(describeAttachment(voice).kind, "audio");
  assertEquals(describeAttachment(image).kind, "image");
  // Meta calls every non-media attachment `file`.
  assertEquals(describeAttachment(doc).kind, "document");
  // Nothing here reads a video or a pin, so they stay on their placeholder.
  assertEquals(describeAttachment(video).kind, null);
  assertEquals(describeAttachment({ type: "location" }).kind, null);
  assertEquals(describeAttachment(undefined).kind, null);
});

Deno.test("both attachment payload shapes are read", () => {
  assertEquals(attachmentList({ attachments: [image] }).length, 1);
  assertEquals(attachmentList({ attachments: { data: [image, voice] } }).length, 2);
  assertEquals(attachmentList({}).length, 0);
  assertEquals(attachmentList({ attachments: null }).length, 0);
});

Deno.test("the first READABLE attachment wins, not attachment zero", () => {
  // A customer who sends a video and then the photo they meant to send puts the readable
  // one second. Taking index 0 blind would answer the video, which is to say answer nothing.
  const chosen = firstReadableAttachment({ attachments: [video, image] });
  assertEquals(chosen?.kind, "image");
  assertEquals(chosen?.url, image.payload.url);
});

Deno.test("an attachment with no url is skipped rather than chosen", () => {
  const chosen = firstReadableAttachment({ attachments: [{ type: "image" }, voice] });
  assertEquals(chosen?.kind, "audio");
});

Deno.test("nothing readable is null, not a guess", () => {
  assertEquals(firstReadableAttachment({ attachments: [video] }), null);
  assertEquals(firstReadableAttachment({ attachments: [] }), null);
});

Deno.test("the placeholder names what arrived, even when nothing can read it", () => {
  // "[Attachment]" was the bug: the agent could not even say "I see you sent a video".
  assertEquals(leadPlaceholder({ attachments: [video] }), "[Video]");
  assertEquals(leadPlaceholder({ attachments: [voice] }), "[Voice message]");
  assertEquals(leadPlaceholder({ attachments: [doc] }), "[Document]");
  assertEquals(leadPlaceholder({ attachments: [{ type: "template" }] }), "[Attachment]");
  assertEquals(leadPlaceholder({ attachments: [] }), null);
});

Deno.test("the agent is told what it did not see, not just the log", () => {
  const understood = "[Image description & OCR]\nA meter reading of 4471.";
  assert(noteUnreadAttachments(understood, 2).includes("2 further attachments"));
  assert(noteUnreadAttachments(understood, 1).includes("1 further attachment"));
  // The note is appended, never substituted for what was understood.
  assert(noteUnreadAttachments(understood, 3).startsWith(understood));
  // And it is absent when there is nothing to say.
  assertEquals(noteUnreadAttachments(understood, 0), understood);
  assertEquals(noteUnreadAttachments(understood, -1), understood);
});
