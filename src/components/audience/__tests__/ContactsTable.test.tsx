import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ContactsTable } from "../ContactsTable";
import type { SocialContact } from "@/features/audience";

const row = {
  id: "1", user_id: "u", workspace_id: null, social_account_id: null, platform: "instagram",
  platform_user_id: "178", identity_kind: "id", display_name: "Dana", username: "dana.kw",
  profile_url: null, email: null, phone_number: null, company: null, notes: null,
  source: "organic_comment", tags: [], whatsapp_contact_id: null, total_comments_count: 1,
  first_interacted_at: "2026-09-01T00:00:00Z", last_interacted_at: "2026-09-04T00:00:00Z",
  last_comment_text: null, last_post_id: null, metadata: {},
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-04T00:00:00Z",
} as SocialContact;

function table(r: SocialContact) {
  return render(
    <MemoryRouter>
      <ContactsTable rows={[r]} onOpen={vi.fn()} onDelete={vi.fn()} />
    </MemoryRouter>,
  );
}

describe("ContactsTable", () => {
  it("shows the Open on WhatsApp link only for a linked contact", () => {
    const { rerender } = table(row);
    expect(screen.queryByRole("link", { name: "Open on WhatsApp" })).toBeNull();

    rerender(
      <MemoryRouter>
        <ContactsTable
          rows={[{ ...row, whatsapp_contact_id: "wa-1" }]}
          onOpen={vi.fn()}
          onDelete={vi.fn()}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Open on WhatsApp" });
    expect(link.getAttribute("href")).toBe("/messaging/whatsapp/contacts");
  });
});
