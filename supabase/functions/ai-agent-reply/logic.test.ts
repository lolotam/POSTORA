// supabase/functions/ai-agent-reply/logic.test.ts
//
// What a staff send means for the agent: whether it is an answer at all, what the
// agent replays from it, and which of them arrived too late for the answer that was
// already written.
//
// A voice note or an image is an answer. The send paths give a media send a preview
// text ("[Image]"), but a row may carry the attachment and no text at all, and a
// customer who was answered by a picture was answered.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  isStaffAnswer,
  lateStaffTurns,
  staffAnsweredNote,
  staffTurnsSince,
  type MessageRow,
} from "./logic.ts";

const SINCE = "2026-11-12T08:00:00.000Z";

const VOICE_NOTE: MessageRow = {
  id: "11111111-1111-1111-1111-111111111111",
  direction: "outbound",
  from_name: "You",
  message_text: null,
  message_type: "audio",
  media_url: "voice/2026/11/12/opus.ogg",
  created_at: "2026-11-12T09:00:00.000Z",
};

const PHOTO: MessageRow = {
  id: "22222222-2222-2222-2222-222222222222",
  direction: "outbound",
  from_name: "You",
  message_text: "",
  message_type: "image",
  media_url: "media/2026/11/12/price-list.jpg",
  created_at: "2026-11-12T09:05:00.000Z",
};

Deno.test("an attachment-only staff reply is an answer", () => {
  assertEquals(isStaffAnswer(VOICE_NOTE), true);
  assertEquals(isStaffAnswer(PHOTO), true);

  // And it is replayed to the agent, so the agent knows the customer was answered.
  assertEquals(staffTurnsSince([VOICE_NOTE, PHOTO], SINCE), [
    {
      role: "assistant",
      content: "(staff) [Audio message]",
      created_at: "2026-11-12T09:00:00.000Z",
      source_id: "11111111-1111-1111-1111-111111111111",
    },
    {
      role: "assistant",
      content: "(staff) [Image]",
      created_at: "2026-11-12T09:05:00.000Z",
      source_id: "22222222-2222-2222-2222-222222222222",
    },
  ]);
});

Deno.test("an outbound row with neither words nor an attachment is not an answer", () => {
  // Nothing was sent, so nothing answered the customer.
  assertEquals(
    isStaffAnswer({
      direction: "outbound",
      from_name: "You",
      message_text: null,
      created_at: "2026-11-12T09:10:00.000Z",
    }),
    false,
  );
  assertEquals(
    staffTurnsSince([
      {
        direction: "outbound",
        from_name: "You",
        message_text: null,
        created_at: "2026-11-12T09:10:00.000Z",
      },
    ], SINCE),
    [],
  );
});

Deno.test("the staff sends that arrived while the model was answering are the late ones", () => {
  const known = staffTurnsSince([
    {
      id: "33333333-3333-3333-3333-333333333333",
      direction: "outbound",
      from_name: "You",
      message_text: "متوفر عندنا",
      created_at: "2026-11-12T08:30:00.000Z",
    },
  ], SINCE);
  assertEquals(known.length, 1);

  // The fresh read sees the known send AND one that landed while the model answered.
  const fresh: MessageRow[] = [
    {
      id: "44444444-4444-4444-4444-444444444444",
      direction: "outbound",
      from_name: "You",
      message_text: "نعم متوفر عندنا",
      created_at: "2026-11-12T08:35:00.000Z",
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      direction: "outbound",
      from_name: "You",
      message_text: "متوفر عندنا",
      created_at: "2026-11-12T08:30:00.000Z",
    },
  ];

  const late = lateStaffTurns(fresh, known, SINCE);
  assertEquals(late.length, 1);
  assertEquals(late[0].content, "(staff) نعم متوفر عندنا");
});

Deno.test("the note that tells the model a staff member answered names the reply", () => {
  const note = staffAnsweredNote([
    { role: "assistant", content: "(staff) نعم متوفر عندنا", created_at: "2026-11-12T08:35:00.000Z" },
  ]);

  assert(note.includes("(staff) نعم متوفر عندنا"), "the note must carry the staff reply");
  assert(note.includes("again"), "the note must ask for the answer again");
});
