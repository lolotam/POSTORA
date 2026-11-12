import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsSearchBar } from "../SettingsSearchBar";

// Regression 2026-11-13: after an AI subscription login, Chrome filled the admin's email
// into this box (an API-key password field sits on the same page), every AI section was
// filtered out, and the ?q= value survived reloads.
describe("SettingsSearchBar", () => {
  it("opts out of browser credential autofill", () => {
    render(
      <SettingsSearchBar
        query=""
        onQueryChange={() => {}}
        counts={{ general: 0, integrations: 0, ai: 0 }}
        totalMatches={0}
        activeTab="ai"
        onSelectTab={() => {}}
      />,
    );
    const box = screen.getByRole("searchbox", { name: "Search settings" });
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).toHaveAttribute("name", "settings-search");
  });
});
