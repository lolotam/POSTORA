import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScopeBadges } from "../ScopeBadges";

describe("ScopeBadges", () => {
  it("renders one badge per scope and reports a click", () => {
    const onToggle = vi.fn();
    render(<ScopeBadges scopes={["messages:send", "posts:write"]} activeScope={null} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "messages:send" }));
    expect(onToggle).toHaveBeenCalledWith("messages:send");
  });
  it("marks the active scope", () => {
    render(<ScopeBadges scopes={["messages:send"]} activeScope="messages:send" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "messages:send" })).toHaveAttribute("aria-pressed", "true");
  });
});
