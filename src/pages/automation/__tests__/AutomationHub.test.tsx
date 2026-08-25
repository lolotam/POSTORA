import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AutomationHub from "@/pages/automation/AutomationHub";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("AutomationHub", () => {
  it("renders all three core automation cards", () => {
    render(
      <MemoryRouter>
        <AutomationHub />
      </MemoryRouter>
    );

    expect(screen.getByText("Automation Hub")).toBeInTheDocument();
    expect(screen.getByText("Agent Setup Portal")).toBeInTheDocument();
    expect(screen.getByText("Messaging Automation")).toBeInTheDocument();
    expect(screen.getByText("Comments Automation")).toBeInTheDocument();
  });
});
