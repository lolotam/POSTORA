import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AdvancedCard } from "../AdvancedCard";

describe("AdvancedCard — Use web search", () => {
  it("is off when the config has never set it", () => {
    render(<AdvancedCard form={{}} update={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Use web search" })).toHaveAttribute("aria-checked", "false");
  });

  it("writes web_search_enabled when toggled", () => {
    const update = vi.fn();
    render(<AdvancedCard form={{ web_search_enabled: false }} update={update} />);
    fireEvent.click(screen.getByRole("switch", { name: "Use web search" }));
    expect(update).toHaveBeenCalledWith("web_search_enabled", true);
  });
});
