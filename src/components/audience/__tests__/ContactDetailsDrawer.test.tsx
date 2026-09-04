import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mutate = vi.fn();
vi.mock("@/features/audience", async () => {
  const actual = await vi.importActual<typeof import("@/features/audience")>("@/features/audience");
  return { ...actual, useUpdateSocialContact: () => ({ mutate, isPending: false }) };
});

import { ContactDetailsDrawer } from "../ContactDetailsDrawer";

const contact = {
  id: "1", platform: "instagram", display_name: "Dana", username: "dana.kw", platform_user_id: "178",
  email: null, phone_number: null, company: null, notes: null, tags: ["lead"], source: "organic_comment",
  total_comments_count: 3, last_interacted_at: "2026-09-04T00:00:00Z", first_interacted_at: "2026-09-01T00:00:00Z",
  last_comment_text: "price?", whatsapp_contact_id: null,
} as never;

describe("ContactDetailsDrawer", () => {
  it("saves edited fields with a digits-only phone and lower-cased email", () => {
    render(<ContactDetailsDrawer contact={contact} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+965 5000 0000" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " Dana@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith(
      { id: "1", patch: expect.objectContaining({ phone_number: "96550000000", email: "dana@example.com" }) },
      expect.anything(),
    );
  });

  it("adds a tag on Enter and removes a tag", () => {
    render(<ContactDetailsDrawer contact={contact} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Add tag"), { target: { value: "vip" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Add tag"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutate).toHaveBeenCalledWith({ id: "1", patch: expect.objectContaining({ tags: ["vip"] }) }, expect.anything());
  });

  it("renders nothing when no contact is selected", () => {
    const { container } = render(<ContactDetailsDrawer contact={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
