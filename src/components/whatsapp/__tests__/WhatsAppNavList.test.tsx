import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WhatsAppNavList } from "../WhatsAppNavList";
import { whatsappNavItems } from "../waNav";

function renderNav(props: { collapsed?: boolean } = {}, route = "/messaging/whatsapp") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TooltipProvider>
        <WhatsAppNavList {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("WhatsAppNavList", () => {
  it("renders every section as a link", () => {
    renderNav();
    expect(screen.getAllByRole("link")).toHaveLength(whatsappNavItems.length);
  });

  it("keeps section names available when collapsed to an icon rail", () => {
    // The labels are hidden visually, not removed — a rail that drops them is unusable with a
    // screen reader.
    renderNav({ collapsed: true });
    expect(screen.getByRole("link", { name: "Setup" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conversations" })).toBeInTheDocument();
  });

  // 2026-08-25: the 68px rail kept h-4 w-4 icons, so a 16px glyph floated in 68px of space.
  it("renders larger icons when collapsed", () => {
    const { container } = renderNav({ collapsed: true });
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("h-5 w-5");
  });

  it("keeps the accessible name when collapsed", () => {
    renderNav({ collapsed: true });
    expect(screen.getByRole("link", { name: /conversations/i })).toBeInTheDocument();
  });

  it("marks the active section for the current route", () => {
    renderNav({}, "/messaging/whatsapp/setup");
    expect(screen.getByRole("link", { name: "Setup" })).toHaveAttribute("aria-current", "page");
  });

  it("marks its own section active for promoted automation sub-sections", () => {
    // Quick Replies used to live under the Automation hub; as a top-level section it
    // must highlight its own entry, not a parent hub item.
    renderNav({}, "/messaging/whatsapp/quick-replies");
    expect(screen.getByRole("link", { name: "Quick Replies" })).toHaveAttribute("aria-current", "page");
  });

  it("does not keep the dashboard active on child routes", () => {
    renderNav({}, "/messaging/whatsapp/contacts");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });
});
