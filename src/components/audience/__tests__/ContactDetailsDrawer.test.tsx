import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mutate = vi.fn();
const waMatch = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return {
    ...actual,
    useUpdateSocialContact: () => ({ mutate, isPending: false }),
    useWhatsAppContactMatch: (...a: unknown[]) => waMatch(...a),
  };
});

import { ContactDetailsDrawer } from "../ContactDetailsDrawer";
import type { SocialContact } from "@/features/audience";

const contact: SocialContact = {
  id: "1", user_id: "u", workspace_id: null, social_account_id: null, platform: "instagram",
  platform_user_id: "178", identity_kind: "id", display_name: "Dana", username: "dana.kw",
  profile_url: null, email: null, phone_number: null, company: null, notes: null,
  source: "organic_comment", tags: ["lead"], whatsapp_contact_id: null, total_comments_count: 3,
  first_interacted_at: "2026-09-01T00:00:00Z", last_interacted_at: "2026-09-04T00:00:00Z",
  last_comment_text: "price?", last_post_id: null, metadata: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-04T00:00:00Z",
};

function draw(c: SocialContact) {
  return render(
    <MemoryRouter>
      <ContactDetailsDrawer contact={c} onClose={() => {}} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mutate.mockReset();
  waMatch.mockReset().mockReturnValue({ data: null });
});

describe("ContactDetailsDrawer", () => {
  it("saves edited fields with a digits-only phone and lower-cased email", () => {
    draw(contact);
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+965 5000 0000" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " Dana@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "1", patch: expect.objectContaining({ phone_number: "96550000000", email: "dana@example.com" }) },
      expect.anything(),
    );
  });

  it("adds a tag on Enter and removes a tag", () => {
    draw(contact);
    fireEvent.change(screen.getByPlaceholderText("Add tag"), { target: { value: "vip" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Add tag"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith({ id: "1", patch: expect.objectContaining({ tags: ["vip"] }) }, expect.anything());
  });

  it("renders nothing when no contact is selected", () => {
    const { container } = render(
      <MemoryRouter>
        <ContactDetailsDrawer contact={null} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to link the WhatsApp contact matched by phone and links it on click", () => {
    waMatch.mockReturnValue({ data: { id: "wa-1", display_name: "Dana WA" } });
    draw({ ...contact, phone_number: "96550000000" });
    const button = screen.getByRole("button", { name: 'Link WhatsApp contact "Dana WA"' });
    fireEvent.click(button);
    expect(mutate).toHaveBeenCalledWith({ id: "1", patch: { whatsapp_contact_id: "wa-1" } });
  });

  it("shows no link button when the phone matches no WhatsApp contact", () => {
    waMatch.mockReturnValue({ data: null });
    draw({ ...contact, phone_number: "96550000000" });
    expect(screen.queryByRole("button", { name: /Link WhatsApp contact/i })).toBeNull();
  });

  // whatsapp_contacts.phone_number is stored digits-only. A social contact whose
  // phone arrived by any route other than this drawer's own save can still hold
  // punctuation, and looking that up verbatim would silently never match.
  it("looks the phone up in the digits-only form WhatsApp stores", () => {
    draw({ ...contact, phone_number: "+965 5000 0000" });
    expect(waMatch).toHaveBeenCalledWith("96550000000");
  });

  it("shows no link button when the contact has no phone at all", () => {
    draw(contact);
    expect(waMatch).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("button", { name: /Link WhatsApp contact/i })).toBeNull();
  });

  it("links to the WhatsApp contacts page when the contact is already linked", () => {
    waMatch.mockReturnValue({ data: null });
    draw({ ...contact, whatsapp_contact_id: "wa-1" });
    const link = screen.getByRole("link", { name: "Open on WhatsApp" });
    expect(link.getAttribute("href")).toBe("/messaging/whatsapp/contacts");
  });
});
