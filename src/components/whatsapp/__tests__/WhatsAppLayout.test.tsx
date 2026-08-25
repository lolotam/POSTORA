import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import WhatsAppLayout from "../WhatsAppLayout";
import { useWhatsAppChrome } from "../WhatsAppChromeContext";

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { msgWhatsapp: true }, isLoading: false }),
}));

vi.mock("../WhatsAppWorkspaceProvider", () => ({
  WhatsAppWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../WorkspaceSwitcher", () => ({
  WorkspaceSwitcher: () => <button type="button">Workspace</button>,
}));

vi.mock("../WhatsAppNavList", () => ({
  WhatsAppNavList: () => <nav>WhatsApp navigation</nav>,
}));

vi.mock("@/components/messaging/WhatsAppCoexistenceSetupBanner", () => ({
  WhatsAppCoexistenceSetupBanner: () => <div>Coexistence setup</div>,
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function ChromeProbe() {
  const { setCompact, setImmersive } = useWhatsAppChrome();
  return (
    <>
      <button type="button" onClick={() => setCompact(true)}>Compact header</button>
      <button type="button" onClick={() => setImmersive(true)}>Use immersive layout</button>
    </>
  );
}

function renderLayout() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<WhatsAppLayout />}>
          <Route index element={<ChromeProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("WhatsAppLayout immersive chrome", () => {
  // Regression guard, 2026-08-25: unmounting the expanded header content discarded focus.
  it("condenses the header with classes while keeping its content mounted", () => {
    renderLayout();
    const subtitle = screen.getByText("Conversations, automation, commerce, and diagnostics");
    expect(subtitle).toHaveClass("max-h-6", "opacity-100");

    fireEvent.click(screen.getByRole("button", { name: "Compact header" }));

    expect(screen.getByText("Conversations, automation, commerce, and diagnostics")).toBe(subtitle);
    expect(subtitle).toHaveClass("max-h-0", "opacity-0");
  });

  it("gives immersive routes a non-scrolling flex content root", () => {
    const { container } = renderLayout();
    fireEvent.click(screen.getByRole("button", { name: "Use immersive layout" }));

    expect(container.querySelector("main")).toHaveClass("overflow-hidden", "min-h-0");
    expect(screen.queryByText("Coexistence setup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compact header" }).parentElement).toHaveClass(
      "h-full",
      "min-h-0",
    );
  });
});
