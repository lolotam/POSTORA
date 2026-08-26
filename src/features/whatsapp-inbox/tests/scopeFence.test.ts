import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("WhatsApp inbox scope fence", () => {
  // Regression guard, 2026-08-25: MessagingInbox is rendered by BrandIntelligence with no
  // platform prop, so resizing its shared chat shells would also change Facebook and Instagram.
  it("leaves the shared MessagingInbox layout alone", () => {
    const src = readFileSync("src/components/messaging/MessagingInbox.tsx", "utf8");
    // Updated 2026-08-26: the unified-inbox restyle bumped the shared shell from
    // 600px to 620px; the fence still guards that all three shells match.
    expect(src.match(/h-\[620px\]/g)).toHaveLength(3);
  });
});
