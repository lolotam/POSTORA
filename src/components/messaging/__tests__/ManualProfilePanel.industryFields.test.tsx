import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManualProfilePanel } from "@/components/messaging/knowledge/ManualProfilePanel";
import type { BusinessProfile } from "@/lib/agentProfile";

function renderPanel(profile: BusinessProfile) {
  return render(
    <ManualProfilePanel
      profile={profile}
      onProfileChange={vi.fn()}
      onSave={vi.fn()}
      saveDisabled={false}
      saving={false}
      showCatalog={false}
      catalog={null}
      hasCatalogAccount={false}
      onSyncCatalog={vi.fn()}
      catalogBusy={false}
    />,
  );
}

describe("ManualProfilePanel shows the fields of the selected business type", () => {
  it("shows every extra field while no type is chosen", () => {
    renderPanel({});
    expect(screen.getByLabelText("Returns policy")).toBeInTheDocument();
    expect(screen.getByLabelText("Viewing and leasing terms")).toBeInTheDocument();
  });

  it("swaps shipping-style fields for booking-style fields on a clinic", () => {
    renderPanel({ industry: "clinic" });
    expect(screen.getByLabelText("Booking and appointments")).toBeInTheDocument();
    expect(screen.getByLabelText("Insurance accepted")).toBeInTheDocument();
    expect(screen.queryByLabelText("Shipping policy")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Returns policy")).not.toBeInTheDocument();
  });

  it("says when a filled field is hidden by the type instead of dropping it", () => {
    renderPanel({ industry: "restaurant", policies: { shipping: "Free over 20 KWD" } });
    expect(screen.queryByLabelText("Shipping policy")).not.toBeInTheDocument();
    expect(screen.getByText(/1 filled field for other business types is kept but not indexed/))
      .toBeInTheDocument();
  });
});
