/**
 * The plain-caption projection.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - Markup is removed first, then the ASCII controls a caption must not
 *     carry. A control inside an unclosed-looking tag cannot split it.
 *   - TAB, LF and CR stay. DEL does not.
 *   - Arabic text and emoji are copied through unchanged.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { readPlainCaption } from "./contracts.ts";

/** Every code unit the caption control strip removes. */
const REMOVED_CONTROLS = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x0b, 0x0c,
  0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x7f,
];

Deno.test("a caption strips markup and controls and keeps tab, line breaks, arabic and emoji", () => {
  for (const code of REMOVED_CONTROLS) {
    const raw = `قبل${String.fromCharCode(code)}بعد`;
    assertEquals(readPlainCaption(raw, "caption", "media"), "قبلبعد");
  }

  assertEquals(readPlainCaption("a\u007Fb", "caption", "media"), "ab");
  assertEquals(
    readPlainCaption(" \u007e\u0080سطر\tواحد\nثاني\r😀", "caption", "media"),
    " \u007e\u0080سطر\tواحد\nثاني\r😀",
  );
  assertEquals(
    readPlainCaption("<script>alert(1)</script> مرحبا 😀", "caption", "media"),
    "alert(1) مرحبا 😀",
  );
  // Markup runs first: the control does not split the tag.
  assertEquals(readPlainCaption("<<\u0000script>نص", "caption", "media"), "نص");
});
